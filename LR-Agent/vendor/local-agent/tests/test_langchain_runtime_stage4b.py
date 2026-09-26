"""阶段 4b：轮末产帧（``tool_start`` / ``tool_result`` / ``tool_pending``）对照测试。

覆盖 ``docs/阶段4-SSE适配设计备忘.md`` §8 实施清单的**第 6 项**。断言对象是
生产适配器 :func:`app.agent.langchain_runtime.sse_adapter.stream_agent_events`
（经 ``stream_agent_events`` 全量运行，不是内部片段）。

对照基准是阶段 0 冻结的 OLD 路径契约
（``tests/test_agent_baseline_contract.py``）：这里按同一批场景参数化，
对**承重帧做全量 ``to_sse_dict()`` 比较**（与基线同样严格），而不是只看类型序列。

覆盖的样例类：``TestSingleTool``、``TestMultipleTools``（含 SYNC+ASYNC 混合同轮）、
``TestDismissAndReject``、``TestReadOnlyTools``、``TestToolError``、
``TestBudgetExhausted``；另加两处阶段 5 反向依赖：
``after_model`` 注入帧必须零产帧、以及 ``done`` / ``error`` / ``preparing(mcp)``
永不由适配器产出。

全部离线、确定性：脚本化流式模型（无网络、无真实 provider）、工具一律结构化存根。
"""

from __future__ import annotations

import json
from typing import Any

import pytest

# baseline 环境（只有 langchain-core，无 langchain/langgraph）整体 skip 而不是 collect error
pytest.importorskip("langchain")

from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import (  # noqa: E402
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    ToolMessage,
)
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
)
from langchain_core.tools import StructuredTool  # noqa: E402
from pydantic import Field  # noqa: E402

from app.agent.assist.task_phase import derive_task_phase  # noqa: E402
from app.agent.langchain_runtime import sse_adapter  # noqa: E402
from app.agent.langchain_runtime.middleware import (  # noqa: E402
    build_business_middleware,
)
from app.agent.langchain_runtime.runtime import (  # noqa: E402
    AgentContext,
    build_langchain_agent,
)
from app.agent.langchain_runtime.sse_adapter import (  # noqa: E402
    SseStreamConfig,
    stream_agent_events,
)
from app.schemas.agent import (  # noqa: E402
    ClientContextInput,
    ProposalStateInput,
    StreamEventPayload,
)

pytestmark = pytest.mark.filterwarnings(
    "ignore:Pydantic serializer warnings:UserWarning"
)

WORKSPACE_CTX = ClientContextInput(workspace_root="/w")


# ── 流式脚本化模型 ─────────────────────────────────────────────────────


class ScriptedStreamChat(BaseChatModel):
    """按轮次返回预设 ``AIMessageChunk`` 的假聊天模型（离线、确定性）。"""

    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)
    seen_messages: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "lr-agent-scripted-stream-stage4b"

    @property
    def invoke_calls(self) -> int:
        return int(self.counters.get("invoke_calls", 0))

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [getattr(t, "name", str(t)) for t in tools]
        return self

    def _round(self) -> list[AIMessageChunk]:
        index = int(self.counters.get("invoke_calls", 0))
        self.counters["invoke_calls"] = index + 1
        if index < len(self.rounds):
            return self.rounds[index]
        return [AIMessageChunk(content="")]

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        merged: AIMessageChunk | None = None
        for chunk in self._round():
            merged = chunk if merged is None else merged + chunk
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="" if merged is None else merged.content,
                        tool_calls=(
                            [] if merged is None else list(merged.tool_calls or [])
                        ),
                    )
                )
            ]
        )

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen_messages.append(list(messages))
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


# ── 分片构造（跨 chunk 拆分的 tool args）───────────────────────────────


def text_chunk(text: str, reasoning: str | None = None) -> AIMessageChunk:
    extra = {"reasoning_content": reasoning} if reasoning is not None else {}
    return AIMessageChunk(content=text, additional_kwargs=extra)


def call_chunks(
    call_id: str,
    name: str,
    args: dict[str, Any],
    *,
    index: int = 0,
) -> list[AIMessageChunk]:
    """一个调用的**两块**分片：首块带 ``name``+``id``，续块 ``id=None``。

    真实 provider 的流式就是这样分片的（``langchain_core/messages/ai.py``）；
    适配器必须从 ``updates["model"]`` 的累加结果取调用表，而不是靠单块。
    """
    raw = json.dumps(args, ensure_ascii=False)
    head, tail = raw[: len(raw) // 2], raw[len(raw) // 2 :]
    return [
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "name": name,
                    "args": head,
                    "id": call_id,
                    "index": index,
                    "type": "tool_call_chunk",
                }
            ],
        ),
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "name": None,
                    "args": tail,
                    "id": None,
                    "index": index,
                    "type": "tool_call_chunk",
                }
            ],
        ),
    ]


def call_round(calls: list[tuple[str, str, dict[str, Any]]]) -> list[AIMessageChunk]:
    """一轮里多个调用，每个都跨两块分片。"""
    out: list[AIMessageChunk] = []
    for index, (call_id, name, args) in enumerate(calls):
        out.extend(call_chunks(call_id, name, args, index=index))
    return out


# ── 工具存根（零副作用；统计真实执行次数）──────────────────────────────


def make_tools(specs: dict[str, dict[str, Any]]):
    """``{name: {"result": dict|None, "raises": Exception|None}}`` → ``(tools, executions)``。"""
    executions: dict[str, list[dict]] = {name: [] for name in specs}
    tools: list[StructuredTool] = []

    for name, spec in specs.items():
        def _make(tool_name=name, tool_spec=spec):
            def _fn(**kwargs):
                executions[tool_name].append(kwargs)
                if tool_spec.get("raises") is not None:
                    raise tool_spec["raises"]
                payload = tool_spec.get("result") or {
                    "ok": True,
                    "summary": f"{tool_name} ok",
                }
                return json.dumps(payload, ensure_ascii=False)

            return _fn

        tools.append(
            StructuredTool(
                name=name,
                description=f"{name} stub",
                func=_make(),
                args_schema={"type": "object", "properties": {}},
            )
        )
    return tools, executions


# ── 驱动 ───────────────────────────────────────────────────────────────


async def run_agent(
    rounds: list[list[AIMessageChunk]],
    tools: list[StructuredTool],
    *,
    max_tool_rounds: int = 5,
    client_context: Any = None,
    task_phase_states: list[ProposalStateInput] | None = None,
    completed_tool_ids: frozenset[str] = frozenset(),
    messages: list[Any] | None = None,
) -> tuple[list[StreamEventPayload], ScriptedStreamChat]:
    phase_ctx = (
        derive_task_phase(task_phase_states) if task_phase_states else None
    )
    model = ScriptedStreamChat(rounds=rounds)
    agent = build_langchain_agent(
        model,
        tools,
        middleware=build_business_middleware(max_tool_rounds=max_tool_rounds),
        name="lr_agent_candidate_4b_test",
    )
    context = AgentContext(
        mode="assist",
        client_context=client_context,
        task_phase_context=phase_ctx,
        completed_tool_ids=completed_tool_ids,
    )
    frames: list[StreamEventPayload] = []
    async for frame in stream_agent_events(
        agent,
        messages=messages or [HumanMessage(content="执行任务")],
        config=SseStreamConfig(context=context),
        client_context=client_context,
        task_phase_ctx=phase_ctx,
    ):
        frames.append(frame)
    return frames, model


def types(frames: list[StreamEventPayload]) -> list[str]:
    return [frame.type for frame in frames]


def sse(frames: list[StreamEventPayload]) -> list[dict[str, Any]]:
    return [frame.to_sse_dict() for frame in frames]


READ_SPEC = {"result": {"ok": True, "summary": "已读取 a.md"}}
ANNOTATE_SPEC = {"result": {"ok": True, "summary": "不应在后端执行"}}


# ── 1. 单工具（TestSingleTool）─────────────────────────────────────────


class TestSingleToolRoundTail:
    async def test_single_sync_tool_frames_match_the_baseline(self):
        tools, executions = make_tools({"read_workspace_file": READ_SPEC})
        frames, model = await run_agent(
            [
                call_round([("t1", "read_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("已读取 a.md。")],
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        assert types(frames) == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        assert sse(frames) == [
            {"type": "preparing", "stage": "streaming"},
            {
                "type": "tool_start",
                "toolCallId": "t1",
                "name": "read_workspace_file",
                "arguments": '{\n  "relative_path": "a.md"\n}',
            },
            {
                "type": "tool_result",
                "toolCallId": "t1",
                "result": "已读取 a.md",
            },
            {"type": "text_delta", "content": "已读取 a.md。"},
        ]
        # 工具恰好执行一次
        assert executions["read_workspace_file"] == [{"relative_path": "a.md"}]
        assert model.invoke_calls == 2

    async def test_no_frame_carries_done_error_or_mcp_stage(self):
        tools, _ = make_tools({"read_workspace_file": READ_SPEC})
        frames, _model = await run_agent(
            [
                call_round([("t1", "read_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("完成")],
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        assert "done" not in types(frames)
        assert "error" not in types(frames)
        assert [f for f in frames if f.type == "preparing"] == [frames[0]]
        assert frames[0].stage == "streaming"


# ── 2. 多个工具 / 混合同轮（TestMultipleTools）────────────────────────


class TestMultipleToolsRoundTail:
    async def test_two_parallel_reads_keep_model_order_and_payloads(self):
        tools, executions = make_tools(
            {
                "grep_workspace": {"result": {"ok": True, "summary": "grep 命中 2 处"}},
                "glob_workspace": {"result": {"ok": True, "summary": "glob 命中 3 个文件"}},
            }
        )
        frames, _model = await run_agent(
            [
                call_round(
                    [
                        ("g1", "grep_workspace", {"pattern": "TODO"}),
                        ("g2", "glob_workspace", {"pattern": "*.py"}),
                    ]
                ),
                [text_chunk("共 2 处命中、3 个文件。")],
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        assert types(frames) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        payloads = sse(frames)
        assert payloads[1] == {
            "type": "tool_start",
            "toolCallId": "g1",
            "name": "grep_workspace",
            "arguments": '{\n  "pattern": "TODO"\n}',
        }
        assert payloads[2] == {
            "type": "tool_result",
            "toolCallId": "g1",
            "result": "grep 命中 2 处",
        }
        assert payloads[3] == {
            "type": "tool_start",
            "toolCallId": "g2",
            "name": "glob_workspace",
            "arguments": '{\n  "pattern": "*.py"\n}',
        }
        assert payloads[4] == {
            "type": "tool_result",
            "toolCallId": "g2",
            "result": "glob 命中 3 个文件",
        }
        assert executions["grep_workspace"] == [{"pattern": "TODO"}]
        assert executions["glob_workspace"] == [{"pattern": "*.py"}]

    async def test_mixed_sync_and_async_round_executes_sync_then_pends(self):
        """``TestMultipleTools`` 的混合同轮：SYNC 先执行，ASYNC 只挂起、后端零执行。

        同时钉住三条易错点：
        1. ``after_model`` 注入的 ``ToolMessage``（``client_tool_pending`` 内容）
           **不得**变成 ``tool_result``（阶段 3 §4-1）；
        2. ASYNC 的 ``tool_start`` 恰好一次（不得因挂起 + pending 双发）；
        3. 混合轮**不再发起第二次模型调用**。
        """
        tools, executions = make_tools(
            {"read_workspace_file": READ_SPEC, "auto_annotate": ANNOTATE_SPEC}
        )
        frames, model = await run_agent(
            [
                call_round(
                    [
                        ("r1", "read_workspace_file", {"relative_path": "a.md"}),
                        (
                            "a1",
                            "auto_annotate",
                            {"paths": ["data/1.jpg"], "all_files": False},
                        ),
                    ]
                )
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        assert types(frames) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_pending",
        ]
        assert sse(frames) == [
            {"type": "preparing", "stage": "streaming"},
            {
                "type": "tool_start",
                "toolCallId": "r1",
                "name": "read_workspace_file",
                "arguments": '{\n  "relative_path": "a.md"\n}',
            },
            {"type": "tool_result", "toolCallId": "r1", "result": "已读取 a.md"},
            {
                "type": "tool_start",
                "toolCallId": "a1",
                "name": "auto_annotate",
                "arguments": (
                    "{\n"
                    '  "paths": [\n'
                    '    "data/1.jpg"\n'
                    "  ],\n"
                    '  "all_files": false\n'
                    "}"
                ),
            },
            {
                "type": "tool_pending",
                "clientToolCalls": [
                    {
                        "toolCallId": "a1",
                        "name": "auto_annotate",
                        "arguments": {"paths": ["data/1.jpg"], "all_files": False},
                    }
                ],
                "toolCalls": [
                    {
                        "toolCallId": "a1",
                        "name": "auto_annotate",
                        "arguments": {"paths": ["data/1.jpg"], "all_files": False},
                    }
                ],
            },
        ]
        assert executions["read_workspace_file"] == [{"relative_path": "a.md"}]
        assert executions["auto_annotate"] == []
        assert model.invoke_calls == 1
        # 后端拦截消息本身**不产帧**（内容里带 client_tool_pending 状态）
        assert not any(
            frame.type == "tool_result"
            and frame.tool_call_id == "a1"
            for frame in frames
        )

    async def test_coalesced_annotation_uses_merged_arguments_and_order(self):
        """同轮两个 ``auto_annotate``：合并者先出（``tool_pending`` 带**合并后**参数），
        被合并者后出（``tool_result(status=coalesced)``）。"""
        tools, _executions = make_tools({"auto_annotate": ANNOTATE_SPEC})
        frames, model = await run_agent(
            [
                call_round(
                    [
                        ("c1", "auto_annotate", {"paths": ["1.jpg"]}),
                        ("c2", "auto_annotate", {"paths": ["2.jpg"]}),
                    ]
                )
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        assert types(frames) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_pending",
        ]
        payloads = sse(frames)
        assert payloads[1]["toolCallId"] == "c2"
        assert payloads[1]["arguments"] == '{\n  "paths": [\n    "2.jpg"\n  ]\n}'
        assert json.loads(payloads[2]["result"])["status"] == "coalesced"
        assert payloads[3] == {
            "type": "tool_start",
            "toolCallId": "c1",
            "name": "auto_annotate",
            "arguments": (
                "{\n"
                '  "paths": [\n'
                '    "1.jpg",\n'
                '    "2.jpg"\n'
                "  ],\n"
                '  "all_files": false,\n'
                '  "write_mode": "append"\n'
                "}"
            ),
        }
        assert payloads[4]["clientToolCalls"][0]["arguments"] == {
            "paths": ["1.jpg", "2.jpg"],
            "all_files": False,
            "write_mode": "append",
        }
        assert model.invoke_calls == 1

    async def test_duplicate_call_is_suppressed_after_the_merged_call(self):
        tools, _executions = make_tools({"auto_annotate": ANNOTATE_SPEC})
        frames, _model = await run_agent(
            [
                call_round(
                    [
                        ("d1", "auto_annotate", {"paths": ["1.jpg"]}),
                        ("d2", "auto_annotate", {"paths": ["1.jpg"]}),
                    ]
                )
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        payloads = sse(frames)
        assert [frame["type"] for frame in payloads] == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_pending",
        ]
        assert payloads[1]["toolCallId"] == "d2"
        assert json.loads(payloads[2]["result"])["status"] == "coalesced"
        assert payloads[3]["toolCallId"] == "d1"
        assert payloads[4]["clientToolCalls"][0]["toolCallId"] == "d1"

    async def test_workspace_write_is_phase_blocked_when_annotation_same_round(self):
        """``TestMultipleTools`` 的同轮互斥：工作区写在标注写同轮被拦，标注照常挂起。"""
        tools, executions = make_tools(
            {"auto_annotate": ANNOTATE_SPEC, "write_workspace_file": ANNOTATE_SPEC}
        )
        frames, _model = await run_agent(
            [
                call_round(
                    [
                        (
                            "b2",
                            "write_workspace_file",
                            {"relative_path": "report.md", "content": "report"},
                        ),
                        ("b1", "auto_annotate", {"paths": ["1.jpg"]}),
                    ]
                )
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        payloads = sse(frames)
        # 写工具的**流式**提案帧先出（拦截器在 model 轮就出卡），随后才是轮末帧
        assert [frame["type"] for frame in payloads][:5] == [
            "preparing",
            "file_proposal_start",
            "file_proposal_delta",
            "tool_start",
            "tool_result",
        ]
        assert payloads[3]["toolCallId"] == "b2"
        blocked = json.loads(payloads[4]["result"])
        assert blocked["status"] == "phase_blocked"
        assert "本轮已包含标注写入" in blocked["summary"]
        assert executions["write_workspace_file"] == []

    async def test_phase_gate_reason_is_byte_identical_to_old_path(self):
        """``AWAIT_CONFIRM`` 门禁被拦的写工具：载荷逐字节等于旧路径的
        ``build_tool_result``，且同轮合法只读调用照常执行（suppressed 先于 execute_now）。"""
        states = [
            ProposalStateInput(path="data/1.jpg", kind="annotation", status="pending")
        ]
        tools, executions = make_tools(
            {
                "write_workspace_file": {"result": {"ok": True, "summary": "不应执行"}},
                "read_workspace_file": READ_SPEC,
            }
        )
        frames, _model = await run_agent(
            [
                call_round(
                    [
                        (
                            "w1",
                            "write_workspace_file",
                            {"relative_path": "r.md", "content": "x"},
                        ),
                        ("r1", "read_workspace_file", {"relative_path": "a.md"}),
                    ]
                ),
                [text_chunk("提案待确认。")],
            ],
            tools,
            client_context=WORKSPACE_CTX,
            task_phase_states=states,
        )

        assert types(frames) == [
            "preparing",
            "file_proposal_start",
            "file_proposal_delta",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        payloads = sse(frames)
        assert payloads[3]["toolCallId"] == "w1"
        assert payloads[4] == {
            "type": "tool_result",
            "toolCallId": "w1",
            "result": (
                '{"ok": false, "tool": "write_workspace_file", "status": '
                '"phase_blocked", "summary": "当前存在未确认的标注提案（data/1.jpg），'
                "用户尚未 Keep All，提案未写盘。禁止标注写入与文件写入操作。"
                '请用一两句说明提案内容，提示用户 Keep All 或关闭提案后再继续。", '
                '"file_written": false, "proposal_pending": false}'
            ),
        }
        assert payloads[5]["toolCallId"] == "r1"
        assert payloads[6]["result"] == "已读取 a.md"
        assert executions["write_workspace_file"] == []
        assert executions["read_workspace_file"] == [{"relative_path": "a.md"}]


# ── 3. 拒绝 / dismissed（TestDismissAndReject）────────────────────────


class TestDismissAndRejectRoundTail:
    async def test_all_dismissed_keeps_gate_open_and_pends(self):
        states = [
            ProposalStateInput(path="data/2.jpg", kind="annotation", status="dismissed")
        ]
        tools, executions = make_tools({"auto_annotate": ANNOTATE_SPEC})
        frames, _model = await run_agent(
            [call_round([("d1", "auto_annotate", {"paths": ["data/2.jpg"]})])],
            tools,
            client_context=ClientContextInput(
                workspace_root="/w", proposal_states=states
            ),
            task_phase_states=states,
        )

        assert types(frames) == ["preparing", "tool_start", "tool_pending"]
        assert sse(frames)[1] == {
            "type": "tool_start",
            "toolCallId": "d1",
            "name": "auto_annotate",
            "arguments": '{\n  "paths": [\n    "data/2.jpg"\n  ]\n}',
        }
        assert not any(
            frame.type == "tool_result" and "phase_blocked" in (frame.result or "")
            for frame in frames
        )
        assert executions["auto_annotate"] == []

    async def test_failed_edit_after_streaming_emits_dismissed_terminal_frame(self):
        """流式已出卡的 ``str_replace`` 执行失败 → 补 ``file_proposal(dismissed)``，
        且 ``tool_result`` 保持**原始 JSON**（写类工具的显示层不对称，阶段 0 §8-6）。"""
        args = {"relative_path": "a.py", "old_string": "x", "new_string": "y"}
        tools, executions = make_tools(
            {
                "str_replace_workspace_file": {
                    "result": {
                        "ok": False,
                        "tool": "str_replace_workspace_file",
                        "status": "error",
                        "summary": "未找到 old_string",
                    }
                }
            }
        )
        frames, _model = await run_agent(
            [
                [
                    AIMessageChunk(
                        content="",
                        tool_call_chunks=[
                            {
                                "name": "str_replace_workspace_file",
                                "args": json.dumps(args, ensure_ascii=False),
                                "id": "s1",
                                "index": 0,
                                "type": "tool_call_chunk",
                            }
                        ],
                    )
                ],
                [text_chunk("替换失败，未改动文件。")],
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        assert types(frames) == [
            "preparing",
            "file_proposal_start",
            "file_edit_delta",
            "tool_start",
            "tool_result",
            "file_proposal",
            "text_delta",
        ]
        payloads = sse(frames)
        assert payloads[1] == {
            "type": "file_proposal_start",
            "summary": "a.py",
            "suggestedRelativePath": "a.py",
            "title": "a.py",
            "detail": "0",
            "mode": "edit",
            "operation": "edit",
        }
        assert payloads[2] == {
            "type": "file_edit_delta",
            "imagePath": "a.py",
            "oldDelta": "x",
            "newDelta": "y",
        }
        assert payloads[4] == {
            "type": "tool_result",
            "toolCallId": "s1",
            "result": (
                '{"ok": false, "tool": "str_replace_workspace_file", '
                '"status": "error", "summary": "未找到 old_string"}'
            ),
        }
        assert payloads[5] == {
            "type": "file_proposal",
            "content": "",
            "status": "dismissed",
            "summary": "a.py",
            "suggestedRelativePath": "a.py",
            "title": "a.py",
            "mode": "edit",
            "operation": "edit",
        }
        assert executions["str_replace_workspace_file"] == [args]


# ── 4. 只读工具（TestReadOnlyTools）───────────────────────────────────


class TestReadOnlyRoundTail:
    async def test_two_read_rounds_emit_no_pending_and_never_run_write_tools(self):
        tools, executions = make_tools(
            {
                "grep_workspace": {"result": {"ok": True, "summary": "grep 命中 1 处"}},
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 annotations.json"}
                },
                "write_workspace_file": {"result": {"ok": True, "summary": "不应被调用"}},
            }
        )
        frames, _model = await run_agent(
            [
                call_round([("ro1", "grep_workspace", {"pattern": "annotations"})]),
                call_round(
                    [("ro2", "read_workspace_file", {"relative_path": "annotations.json"})]
                ),
                [text_chunk("只读核对完成，未做任何写入。")],
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        assert types(frames) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        payloads = sse(frames)
        assert [payloads[1]["toolCallId"], payloads[3]["toolCallId"]] == ["ro1", "ro2"]
        assert payloads[2] == {
            "type": "tool_result",
            "toolCallId": "ro1",
            "result": "grep 命中 1 处",
        }
        assert payloads[4] == {
            "type": "tool_result",
            "toolCallId": "ro2",
            "result": "已读取 annotations.json",
        }
        assert not any(frame.type == "tool_pending" for frame in frames)
        assert not any(frame.type.startswith("file_proposal") for frame in frames)
        assert executions["write_workspace_file"] == []


# ── 5. 工具错误（TestToolError）───────────────────────────────────────


class TestToolErrorRoundTail:
    async def test_raising_tool_becomes_error_result_without_retry(self):
        tools, executions = make_tools(
            {"read_workspace_file": {"raises": RuntimeError("磁盘炸了")}}
        )
        frames, model = await run_agent(
            [
                call_round([("e1", "read_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("读取失败，已停止。")],
            ],
            tools,
            client_context=WORKSPACE_CTX,
        )

        assert types(frames) == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        assert sse(frames)[2] == {
            "type": "tool_result",
            "toolCallId": "e1",
            "result": "工具执行失败: 磁盘炸了",
        }
        # 不自动重试：恰好一次
        assert executions["read_workspace_file"] == [{"relative_path": "a.md"}]
        assert model.invoke_calls == 2

    async def test_unknown_tool_error_text_is_remapped_to_the_old_payload(self):
        """未注册工具：框架 ``ToolNode`` 的英文模板必须换回旧路径的
        ``"未知工具: <name>"`` 显示载荷（:func:`sse_adapter._old_unknown_tool_result`）。"""
        frames, _model = await run_agent(
            [
                call_round([("u1", "memory_read", {"topic": "x"})]),
                [text_chunk("该工具当前不可用。")],
            ],
            [],
            client_context=WORKSPACE_CTX,
        )

        assert types(frames) == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        assert sse(frames)[2] == {
            "type": "tool_result",
            "toolCallId": "u1",
            "result": "未知工具: memory_read",
        }


# ── 6. 预算耗尽（TestBudgetExhausted）────────────────────────────────


class TestBudgetExhaustedRoundTail:
    async def test_two_budgeted_tool_rounds_then_tool_less_wrap_up(self):
        tools, executions = make_tools({"read_workspace_file": READ_SPEC})
        frames, model = await run_agent(
            [
                call_round([("call-1", "read_workspace_file", {"relative_path": "a.md"})]),
                call_round([("call-2", "read_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("预算已用完。当前进展：已读取 a.md。")],
            ],
            tools,
            max_tool_rounds=1,
            client_context=WORKSPACE_CTX,
        )

        assert types(frames) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        assert [frame.tool_call_id for frame in frames if frame.type == "tool_start"] == [
            "call-1",
            "call-2",
        ]
        assert len(executions["read_workspace_file"]) == 2
        assert model.invoke_calls == 3

    async def test_wrap_up_round_tool_call_is_ignored(self):
        """收尾轮即使吐出 ``tool_calls`` 也不执行、不产工具帧。"""
        tools, executions = make_tools({"read_workspace_file": READ_SPEC})
        wrap_up = call_round(
            [("wrapup-1", "read_workspace_file", {"relative_path": "b.md"})]
        )
        wrap_up[0] = AIMessageChunk(
            content="预算已用完。",
            tool_call_chunks=list(wrap_up[0].tool_call_chunks or []),
        )
        frames, _model = await run_agent(
            [
                call_round([("call-1", "read_workspace_file", {"relative_path": "a.md"})]),
                call_round([("call-2", "read_workspace_file", {"relative_path": "a.md"})]),
                wrap_up,
            ],
            tools,
            max_tool_rounds=1,
            client_context=WORKSPACE_CTX,
        )

        assert [frame.tool_call_id for frame in frames if frame.type == "tool_start"] == [
            "call-1",
            "call-2",
        ]
        assert all(
            args != {"relative_path": "b.md"}
            for args in executions["read_workspace_file"]
        )
        assert sse(frames)[-1] == {
            "type": "text_delta",
            "content": "预算已用完。",
        }


# ── 7. 跨请求 resume：``already_completed`` 抑制（TestProposalConfirm）──


class TestAlreadyCompletedRoundTail:
    async def test_seeded_completed_id_is_suppressed_with_old_payload_shape(self):
        """阶段 3 播种 ``completed_tool_ids`` 后，模型复读的调用必须出
        ``tool_result(status=already_completed)`` 且**零执行**、**零 tool_pending**。"""
        tools, executions = make_tools({"auto_annotate": ANNOTATE_SPEC})
        frames, _model = await run_agent(
            [call_round([("c1", "auto_annotate", {"paths": ["data/1.jpg"]})])],
            tools,
            client_context=WORKSPACE_CTX,
            completed_tool_ids=frozenset({"c1"}),
        )

        assert types(frames) == ["preparing", "tool_start", "tool_result"]
        payloads = sse(frames)
        assert payloads[1]["toolCallId"] == "c1"
        assert json.loads(payloads[2]["result"]) == {
            "ok": False,
            "tool": "auto_annotate",
            "status": "already_completed",
            "summary": "该工具本轮已执行，请勿重复调用。请总结，勿重跑标注工具。",
            "file_written": False,
            "proposal_pending": False,
        }
        assert executions["auto_annotate"] == []


# ── 8. 理由能力（阶段 5 反向依赖）：注入帧零产帧 ──────────────────────


def message_part(message: Any, **metadata: Any) -> dict[str, Any]:
    meta = {"langgraph_node": "model", "langgraph_step": 1}
    meta.update(metadata)
    return {"type": "messages", "ns": (), "data": (message, meta)}


class RecordingGraph:
    """只实现 ``astream`` 的假图：用于构造 ``after_model`` 注入帧等边界分片。"""

    def __init__(self, parts: list[dict[str, Any]]) -> None:
        self.parts = parts
        self.closed = False

    async def astream(self, _input, **kwargs):
        try:
            for part in self.parts:
                yield part
        finally:
            self.closed = True


class TestAfterModelInjectedFrames:
    """``after_model`` 节点注入的合成消息只是状态通道 —— 必须零产帧。"""

    def test_is_after_model_node_matches_only_the_hook_suffix(self):
        assert sse_adapter._is_after_model_node("BusinessRoundMiddleware.after_model")
        assert sse_adapter._is_after_model_node("X.after_model")
        assert not sse_adapter._is_after_model_node("model")
        assert not sse_adapter._is_after_model_node("tools")
        assert not sse_adapter._is_after_model_node(None)

    async def test_synthetic_after_model_messages_produce_no_frame(self):
        graph = RecordingGraph(
            [
                message_part(text_chunk("真实输出")),
                message_part(
                    AIMessageChunk(content=""), langgraph_node="X.after_model"
                ),
                message_part(
                    ToolMessage(content='{"ok": false}', tool_call_id="ghost"),
                    langgraph_node="X.after_model",
                    langgraph_step=6,
                ),
                {
                    "type": "updates",
                    "ns": (),
                    "data": {"model": {"messages": [AIMessage(content="真实输出")]}},
                },
            ]
        )

        frames: list[StreamEventPayload] = []
        async for frame in stream_agent_events(
            graph,
            messages=[HumanMessage(content="x")],
            config=SseStreamConfig(),
        ):
            frames.append(frame)

        assert types(frames) == ["preparing", "text_delta"]
        assert frames[1].content == "真实输出"
        assert not any(frame.type == "tool_result" for frame in frames)
        assert not any(frame.type == "tool_start" for frame in frames)
