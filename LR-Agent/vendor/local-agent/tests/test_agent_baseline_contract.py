"""阶段 0：冻结 OLD 路径（stream_assist + _stream_local_chat）的可复现基线。

覆盖计划 §5-阶段 0 要求的十类样例；每类同时固定三件事：

  1. 事件顺序（精确的 ``event.type`` 列表）；
  2. 承重帧的 **完整** ``to_sse_dict()`` 载荷；
  3. 后端 **真实工具执行次数**（统计注入的假工具函数被调用几次），
     以及 ``tool_start`` / ``tool_pending`` / ``ToolMessage`` 之间的
     ``tool_call_id`` 对齐。

依赖这些基线的迁移阶段：

  - 阶段 2（业务 middleware）：同轮多工具合并/去重、门禁拦截、
    预算收尾的「零执行 / 执行次数」结论依赖
    ``TestMultipleTools`` / ``TestReadOnlyTools`` / ``TestBudgetExhausted``。
  - 阶段 3（提案确认与跨请求续跑）：``TestProposalConfirm`` 固定
    pending → resume 的 ToolMessage 对齐与「谎报防护」。
  - 阶段 4（流式事件适配）：本文件所有 ``to_sse_dict()`` 全量载荷断言。
  - 阶段 5（MCP / 只读子代理）：``TestMcpUnavailable``。
  - 阶段 8（故障注入）：``TestToolError`` / ``TestCancel``。

全部离线、确定性：无网络、无真实模型、无 YOLO、无 Docker、无磁盘写入。

注意：旧路径 **没有** ``error`` SSE 事件（见 docs/Agent与LangChain实现分析.md:393）。
本文件对「工具错误」固定的是携带错误 JSON 的 ``tool_result`` 帧，
而不是不存在的 ``error`` 帧。
"""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool

from app.agent.assist.task_phase import derive_task_phase
from app.agent.assist_service import stream_assist
from app.schemas.agent import (
    ClientContextInput,
    ClientToolResult,
    LocalChatStreamRequest,
    ProposalStateInput,
    StreamEventPayload,
)

pytest.importorskip("langchain_openai")


# ── 脚本化模型与工具 ────────────────────────────────────────────────────


class Chunk:
    """脚本化 AIMessageChunk。

    字段与既有约定一致（``test_agent_migration_contract.FakeChunk``），
    另实现 ``__add__`` 以支持 assist_service 的 ``gathered`` 累加。
    """

    def __init__(
        self,
        content: str = "",
        tool_calls=None,
        tool_call_chunks=None,
        additional_kwargs=None,
    ):
        self.content = content
        self.tool_calls = tool_calls or []
        self.tool_call_chunks = tool_call_chunks or []
        self.additional_kwargs = additional_kwargs or {}

    def __add__(self, other: "Chunk") -> "Chunk":
        return Chunk(
            content=(self.content or "") + (other.content or ""),
            tool_calls=list(self.tool_calls) + list(other.tool_calls),
            tool_call_chunks=list(self.tool_call_chunks)
            + list(other.tool_call_chunks),
            additional_kwargs={**self.additional_kwargs, **other.additional_kwargs},
        )


class ScriptedChat:
    """按轮次返回预设 chunk 的假聊天模型。

    记录 ``astream`` / ``bind_tools`` 调用次数，以及每次 ``astream``
    收到的 messages 快照（用于断言 ToolMessage 与 tool_call_id 对齐）。
    """

    def __init__(self, rounds):
        self._rounds = list(rounds)
        self.astream_calls = 0
        self.bind_tools_calls = 0
        self.bound_tool_names: list[str] = []
        self.seen_messages: list[list] = []

    def bind_tools(self, tools, tool_choice=None):
        self.bind_tools_calls += 1
        self.bound_tool_names = [getattr(t, "name", str(t)) for t in tools]
        return self

    async def astream(self, messages):
        self.astream_calls += 1
        self.seen_messages.append(list(messages))
        chunks = self._rounds.pop(0) if self._rounds else []
        for chunk in chunks:
            yield chunk

    async def ainvoke(self, messages):
        # tool_choice="any" 伪代码兜底路径：本文件的场景都不应触发。
        return AIMessage(content="", tool_calls=[])


def make_tools(specs: dict):
    """构建注入用的假工具。

    ``specs``: ``{name: {"result": dict|callable|None, "raises": Exception|None,
    "properties": dict|None}}``

    返回 ``(tools, executions)``；``executions[name]`` 是该工具真实被调用
    的参数列表 —— 长度即「实际执行次数」。
    """
    executions: dict[str, list[dict]] = {name: [] for name in specs}
    tools: list[StructuredTool] = []

    for name, spec in specs.items():
        def _make(tool_name=name, tool_spec=spec):
            def _fn(**kwargs):
                executions[tool_name].append(kwargs)
                if tool_spec.get("raises") is not None:
                    raise tool_spec["raises"]
                result = tool_spec.get("result")
                if callable(result):
                    payload = result(kwargs)
                elif result is not None:
                    payload = result
                else:
                    payload = {
                        "ok": True,
                        "tool": tool_name,
                        "status": "ok",
                        "summary": f"{tool_name} ok",
                    }
                return json.dumps(payload, ensure_ascii=False)

            return _fn

        tools.append(
            StructuredTool(
                name=name,
                description=f"{name} stub",
                func=_make(),
                args_schema={
                    "type": "object",
                    "properties": spec.get("properties") or {},
                },
            )
        )

    return tools, executions


async def _never_cancel() -> bool:
    return False


class CancelAfter:
    """第 n 次 ``is_cancelled()`` 调用起返回 True（n=1 表示进循环前即取消）。"""

    def __init__(self, n: int):
        self.n = n
        self.calls = 0

    async def __call__(self) -> bool:
        self.calls += 1
        return self.calls >= self.n


async def _run(
    llm,
    tools,
    *,
    messages=None,
    max_tool_rounds: int = 5,
    is_cancelled=_never_cancel,
    client_context=None,
    user_content: str = "执行任务",
    client_tool_results=None,
    task_phase_ctx=None,
):
    """驱动 OLD 路径 ``stream_assist``，返回事件列表。"""
    return [
        event
        async for event in stream_assist(
            llm,
            messages if messages is not None else [HumanMessage(content=user_content)],
            tools,
            settings=None,  # type: ignore[arg-type]
            max_tool_rounds=max_tool_rounds,
            is_cancelled=is_cancelled,
            client_context=client_context,
            user_content=user_content,
            client_tool_results=client_tool_results,
            task_phase_ctx=task_phase_ctx,
        )
    ]


def _sse(events) -> list[dict]:
    return [event.to_sse_dict() for event in events]


def _types(events) -> list[str]:
    return [event.type for event in events]


def _tool_messages(messages) -> list[ToolMessage]:
    return [m for m in messages if isinstance(m, ToolMessage)]


# ── 1. 空工具调用 ───────────────────────────────────────────────────────


class TestEmptyToolCall:
    """阶段 0 基线 / 阶段 4 依赖：纯文本回合不发任何工具帧。"""

    async def test_plain_text_turn_emits_no_tool_frame_and_zero_execution(self):
        tools, executions = make_tools(
            {"read_workspace_file": {"properties": {"relative_path": {"type": "string"}}}}
        )
        llm = ScriptedChat([[Chunk(content="你好，我可以帮你整理工作区。")]])

        events = await _run(
            llm,
            tools,
            client_context=ClientContextInput(workspace_root="/w"),
            user_content="你好",
        )

        assert _types(events) == ["preparing", "text_delta"]
        assert _sse(events) == [
            {"type": "preparing", "stage": "streaming"},
            {"type": "text_delta", "content": "你好，我可以帮你整理工作区。"},
        ]
        # 空工具调用 = 零真实工具执行
        assert executions["read_workspace_file"] == []
        # 只有一次模型调用；没有进入第二轮
        assert llm.astream_calls == 1
        # bind_tools 只发生一次（未触发 tool_choice="any" 伪代码兜底）
        assert llm.bind_tools_calls == 1


# ── 2. 单工具（后端同步工具） ───────────────────────────────────────────


class TestSingleTool:
    """阶段 0 基线 / 阶段 4 依赖：单工具轮 = tool_start + tool_result + 收尾文本。"""

    async def test_single_read_tool_round(self):
        tools, executions = make_tools(
            {
                "read_workspace_file": {
                    "result": {
                        "ok": True,
                        "tool": "read_workspace_file",
                        "status": "ok",
                        "summary": "已读取 a.md（12 字符）",
                    },
                    "properties": {"relative_path": {"type": "string"}},
                }
            }
        )
        llm = ScriptedChat(
            [
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "t1",
                                "name": "read_workspace_file",
                                "args": {"relative_path": "a.md"},
                            }
                        ]
                    )
                ],
                [Chunk(content="已读取 a.md。")],
            ]
        )

        events = await _run(
            llm,
            tools,
            client_context=ClientContextInput(workspace_root="/w"),
        )

        assert _types(events) == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        assert _sse(events)[1] == {
            "type": "tool_start",
            "toolCallId": "t1",
            "name": "read_workspace_file",
            "arguments": '{\n  "relative_path": "a.md"\n}',
        }
        assert _sse(events)[2] == {
            "type": "tool_result",
            "toolCallId": "t1",
            "result": "已读取 a.md（12 字符）",
        }
        assert _sse(events)[3] == {"type": "text_delta", "content": "已读取 a.md。"}

        # 真实执行次数 = 1
        assert executions["read_workspace_file"] == [{"relative_path": "a.md"}]
        # 第二轮模型看到 ToolMessage，且 tool_call_id 与 tool_start 对齐
        second_round = llm.seen_messages[1]
        tool_messages = _tool_messages(second_round)
        assert [m.tool_call_id for m in tool_messages] == ["t1"]
        assert tool_messages[0].content == "已读取 a.md（12 字符）"
        assert llm.astream_calls == 2


# ── 3. 多个工具 ─────────────────────────────────────────────────────────


class TestMultipleTools:
    """阶段 0 基线 / 阶段 2、4 依赖：同轮多工具的保序执行与 ASYNC 不落后端。"""

    async def test_two_parallel_read_tools_keep_order_and_ids(self):
        tools, executions = make_tools(
            {
                "grep_workspace": {
                    "result": {"ok": True, "summary": "grep 命中 2 处"},
                    "properties": {"pattern": {"type": "string"}},
                },
                "glob_workspace": {
                    "result": {"ok": True, "summary": "glob 命中 3 个文件"},
                    "properties": {"pattern": {"type": "string"}},
                },
            }
        )
        llm = ScriptedChat(
            [
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "g1",
                                "name": "grep_workspace",
                                "args": {"pattern": "TODO"},
                            },
                            {
                                "id": "g2",
                                "name": "glob_workspace",
                                "args": {"pattern": "*.py"},
                            },
                        ]
                    )
                ],
                [Chunk(content="共 2 处命中、3 个文件。")],
            ]
        )

        events = await _run(
            llm,
            tools,
            client_context=ClientContextInput(workspace_root="/w"),
        )

        assert _types(events) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        sse = _sse(events)
        # tool_start / tool_result 成对，且顺序与模型给出的调用顺序一致
        assert [sse[1]["toolCallId"], sse[3]["toolCallId"]] == ["g1", "g2"]
        assert [sse[2]["toolCallId"], sse[4]["toolCallId"]] == ["g1", "g2"]
        assert sse[1]["name"] == "grep_workspace"
        assert sse[1]["arguments"] == '{\n  "pattern": "TODO"\n}'
        assert sse[2] == {
            "type": "tool_result",
            "toolCallId": "g1",
            "result": "grep 命中 2 处",
        }
        assert sse[3]["name"] == "glob_workspace"
        assert sse[3]["arguments"] == '{\n  "pattern": "*.py"\n}'
        assert sse[4] == {
            "type": "tool_result",
            "toolCallId": "g2",
            "result": "glob 命中 3 个文件",
        }
        # 每个工具恰好执行一次
        assert executions["grep_workspace"] == [{"pattern": "TODO"}]
        assert executions["glob_workspace"] == [{"pattern": "*.py"}]
        # ToolMessage 顺序/ID 与 SSE 一致
        assert [m.tool_call_id for m in _tool_messages(llm.seen_messages[1])] == [
            "g1",
            "g2",
        ]

    async def test_sync_and_async_tool_same_round_executes_sync_then_pends(self):
        """同轮「后端工具 + 客户端 ASYNC 工具」：先执行后端工具，再挂起客户端工具；
        客户端工具在后端 **零执行**（由前端执行后 resume）。"""
        tools, executions = make_tools(
            {
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 a.md"},
                    "properties": {"relative_path": {"type": "string"}},
                },
                "auto_annotate": {
                    "result": {"ok": True, "summary": "不应在后端执行"},
                    "properties": {
                        "paths": {"type": "array"},
                        "all_files": {"type": "boolean"},
                    },
                },
            }
        )
        llm = ScriptedChat(
            [
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "r1",
                                "name": "read_workspace_file",
                                "args": {"relative_path": "a.md"},
                            },
                            {
                                "id": "a1",
                                "name": "auto_annotate",
                                "args": {"paths": ["data/1.jpg"], "all_files": False},
                            },
                        ]
                    )
                ]
            ]
        )

        events = await _run(
            llm,
            tools,
            client_context=ClientContextInput(workspace_root="/w"),
        )

        assert _types(events) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_pending",
        ]
        sse = _sse(events)
        assert sse[3] == {
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
        }
        assert sse[4] == {
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
        }
        # 后端只执行了同步工具
        assert executions["read_workspace_file"] == [{"relative_path": "a.md"}]
        assert executions["auto_annotate"] == []
        # tool_pending 结束本轮 HTTP：模型未被再次调用
        assert llm.astream_calls == 1
        # 挂起调用的 tool_call_id 与 tool_start 对齐
        assert sse[3]["toolCallId"] == sse[4]["clientToolCalls"][0]["toolCallId"]


# ── 4. 提案确认（proposal confirm） ─────────────────────────────────────


class TestProposalConfirm:
    """阶段 0 基线 / 阶段 3 依赖：pending → 用户确认 → 结果回传 → 最终回答。"""

    async def test_pending_then_confirm_resume_alignment(self):
        tools, executions = make_tools(
            {
                "auto_annotate": {
                    "result": {"ok": True, "summary": "不应在后端执行"},
                    "properties": {"paths": {"type": "array"}},
                }
            }
        )
        client_context = ClientContextInput(workspace_root="/w")

        # 第一轮：生成提案 → tool_pending 结束 HTTP 轮次
        first_llm = ScriptedChat(
            [
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "c1",
                                "name": "auto_annotate",
                                "args": {"paths": ["data/1.jpg"]},
                            }
                        ]
                    )
                ]
            ]
        )
        first = await _run(
            first_llm, tools, client_context=client_context, user_content="标注 data/1.jpg"
        )
        assert _types(first) == ["preparing", "tool_start", "tool_pending"]
        assert _sse(first)[2]["clientToolCalls"][0]["toolCallId"] == "c1"
        assert executions["auto_annotate"] == []

        # 第二轮：用户确认，前端回传客户端工具结果 → 最终回答
        result = ClientToolResult(
            tool_call_id="c1",
            name="auto_annotate",
            result=json.dumps(
                {
                    "status": "completed",
                    "proposal_pending": True,
                    "file_written": False,
                },
                ensure_ascii=False,
            ),
        )
        resume_llm = ScriptedChat([[Chunk(content="已收到标注结果，等待用户确认提案。")]])
        second = await _run(
            resume_llm,
            tools,
            client_context=client_context,
            user_content="标注 data/1.jpg",
            client_tool_results=[result],
        )

        assert _types(second) == ["preparing", "text_delta"]
        assert _sse(second) == [
            {"type": "preparing", "stage": "streaming"},
            {"type": "text_delta", "content": "已收到标注结果，等待用户确认提案。"},
        ]
        # 确认轮不重复执行客户端工具
        assert executions["auto_annotate"] == []
        # 模型看到合成 AIMessage(tool_calls) + ToolMessage，且 id 对齐
        seen = resume_llm.seen_messages[0]
        ai_tool_calls = [
            tc
            for m in seen
            if isinstance(m, AIMessage)
            for tc in (m.tool_calls or [])
        ]
        assert [tc["id"] for tc in ai_tool_calls] == ["c1"]
        tool_messages = _tool_messages(seen)
        assert [m.tool_call_id for m in tool_messages] == ["c1"]
        assert "next_hint" in tool_messages[0].content

    async def test_keep_all_resume_rewrites_pending_flags(self):
        """用户 Keep All（applied）后 resume：工具结果被改写为
        proposal_pending=false / file_written=true（谎报防护）。"""
        tools, _ = make_tools({})
        states = [
            ProposalStateInput(
                path="data/1.jpg", kind="annotation", status="applied"
            )
        ]
        ctx = derive_task_phase(states)
        assert ctx is not None

        result = ClientToolResult(
            tool_call_id="c1",
            name="auto_annotate",
            result=json.dumps(
                {"status": "completed", "proposal_pending": True, "file_written": False},
                ensure_ascii=False,
            ),
        )
        llm = ScriptedChat([[Chunk(content="已核对落盘结果，未再重复标注。")]])
        # 只校验消息链（本用例不关心门禁后的工具执行）
        await _run(
            llm,
            tools,
            client_context=ClientContextInput(
                workspace_root="/w", proposal_states=states
            ),
            client_tool_results=[result],
            task_phase_ctx=ctx,
            max_tool_rounds=1,
        )

        tool_messages = _tool_messages(llm.seen_messages[0])
        assert [m.tool_call_id for m in tool_messages] == ["c1"]
        payload = json.loads(tool_messages[0].content)
        assert payload["proposal_pending"] is False
        assert payload["file_written"] is True
        assert "Keep All" in payload["next_hint"]


# ── 5. 拒绝（dismiss / reject） ────────────────────────────────────────


class TestDismissAndReject:
    """阶段 0 基线 / 阶段 2 依赖：用户关闭提案后门禁解除、可重新规划；
    写工具失败时补发 dismissed 终态收卡。"""

    async def test_all_dismissed_clears_gate_and_allows_replanning(self):
        """全部提案 dismissed → derive_task_phase 返回 None（不启用门禁），
        后续 auto_annotate 正常挂起，而不是被 phase_blocked。"""
        states = [
            ProposalStateInput(
                path="data/2.jpg", kind="annotation", status="dismissed"
            )
        ]
        assert derive_task_phase(states) is None

        tools, executions = make_tools(
            {
                "auto_annotate": {
                    "result": {"ok": True, "summary": "不应在后端执行"},
                    "properties": {"paths": {"type": "array"}},
                }
            }
        )
        llm = ScriptedChat(
            [
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "d1",
                                "name": "auto_annotate",
                                "args": {"paths": ["data/2.jpg"]},
                            }
                        ]
                    )
                ]
            ]
        )
        events = await _run(
            llm,
            tools,
            client_context=ClientContextInput(
                workspace_root="/w", proposal_states=states
            ),
            task_phase_ctx=derive_task_phase(states),
        )

        assert _types(events) == ["preparing", "tool_start", "tool_pending"]
        assert not any(
            "phase_blocked" in (e.result or "")
            for e in events
            if e.type == "tool_result"
        )
        assert _sse(events)[1] == {
            "type": "tool_start",
            "toolCallId": "d1",
            "name": "auto_annotate",
            "arguments": '{\n  "paths": [\n    "data/2.jpg"\n  ]\n}',
        }
        assert executions["auto_annotate"] == []

    async def test_failed_edit_after_streaming_emits_dismissed_terminal_frame(self):
        """str_replace 已流式出卡但工具失败 → 补发 file_proposal(status=dismissed)。"""
        tools, executions = make_tools(
            {
                "str_replace_workspace_file": {
                    "result": {
                        "ok": False,
                        "tool": "str_replace_workspace_file",
                        "status": "error",
                        "summary": "未找到 old_string",
                    },
                    "properties": {
                        "relative_path": {"type": "string"},
                        "old_string": {"type": "string"},
                        "new_string": {"type": "string"},
                    },
                }
            }
        )
        streamed_chunk = Chunk(
            tool_call_chunks=[
                {
                    "index": 0,
                    "id": "s1",
                    "name": "str_replace_workspace_file",
                    "args": '{"relative_path": "a.py", "old_string": "x", "new_string": "y"}',
                }
            ],
            tool_calls=[
                {
                    "id": "s1",
                    "name": "str_replace_workspace_file",
                    "args": {"relative_path": "a.py", "old_string": "x", "new_string": "y"},
                }
            ],
        )
        llm = ScriptedChat([[streamed_chunk], [Chunk(content="替换失败，未改动文件。")]])

        events = await _run(
            llm,
            tools,
            client_context=ClientContextInput(workspace_root="/w"),
        )

        assert _types(events) == [
            "preparing",
            "file_proposal_start",
            "file_edit_delta",
            "tool_start",
            "tool_result",
            "file_proposal",
            "text_delta",
        ]
        sse = _sse(events)
        assert sse[1] == {
            "type": "file_proposal_start",
            "summary": "a.py",
            "suggestedRelativePath": "a.py",
            "title": "a.py",
            "detail": "0",
            "mode": "edit",
            "operation": "edit",
        }
        # str_replace 的增量是 old/new 双通道（前端据此渲染局部 diff）
        assert sse[2] == {
            "type": "file_edit_delta",
            "imagePath": "a.py",
            "oldDelta": "x",
            "newDelta": "y",
        }
        # 契约细节：写类工具 **未** 产出 __doc_proposal__ 时不做 display 摘要化，
        # tool_result 直接回传原始 JSON（与成功路径的 "summary" 展示不对称）。
        assert sse[4] == {
            "type": "tool_result",
            "toolCallId": "s1",
            "result": (
                '{"ok": false, "tool": "str_replace_workspace_file", '
                '"status": "error", "summary": "未找到 old_string"}'
            ),
        }
        assert sse[5] == {
            "type": "file_proposal",
            "content": "",
            "status": "dismissed",
            "summary": "a.py",
            "suggestedRelativePath": "a.py",
            "title": "a.py",
            "mode": "edit",
            "operation": "edit",
        }
        # ToolMessage 与 tool_start/tool_result 的 id 对齐，内容同为原始 JSON
        tool_messages = _tool_messages(llm.seen_messages[1])
        assert [m.tool_call_id for m in tool_messages] == ["s1"]
        assert tool_messages[0].content == sse[4]["result"]
        assert executions["str_replace_workspace_file"] == [
            {"relative_path": "a.py", "old_string": "x", "new_string": "y"}
        ]


# ── 6. 工具错误 ─────────────────────────────────────────────────────────


class TestToolError:
    """阶段 0 基线 / 阶段 2、8 依赖：工具异常转结构化错误、不重试、不中断循环。"""

    async def test_raising_tool_becomes_error_tool_result_without_retry(self):
        tools, executions = make_tools(
            {
                "read_workspace_file": {
                    "raises": RuntimeError("磁盘炸了"),
                    "properties": {"relative_path": {"type": "string"}},
                }
            }
        )
        llm = ScriptedChat(
            [
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "e1",
                                "name": "read_workspace_file",
                                "args": {"relative_path": "a.md"},
                            }
                        ]
                    )
                ],
                [Chunk(content="读取失败，已停止。")],
            ]
        )

        events = await _run(
            llm,
            tools,
            client_context=ClientContextInput(workspace_root="/w"),
        )

        # 旧路径没有 error 事件：错误以 tool_result 承载
        assert "error" not in _types(events)
        assert _types(events) == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        assert _sse(events)[2] == {
            "type": "tool_result",
            "toolCallId": "e1",
            "result": "工具执行失败: 磁盘炸了",
        }
        # 不自动重试：恰好一次
        assert executions["read_workspace_file"] == [{"relative_path": "a.md"}]
        # 错误以 ToolMessage 回填，id 对齐，循环继续一轮
        tool_messages = _tool_messages(llm.seen_messages[1])
        assert [m.tool_call_id for m in tool_messages] == ["e1"]
        assert "工具执行失败" in tool_messages[0].content
        assert llm.astream_calls == 2

    async def test_unknown_tool_reports_error_json(self):
        """工具未在 fn_map 中（MCP 未就绪等）→ 未知工具错误，不抛异常。"""
        llm = ScriptedChat(
            [
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "u1",
                                "name": "memory_read",
                                "args": {"topic": "x"},
                            }
                        ]
                    )
                ],
                [Chunk(content="该工具当前不可用。")],
            ]
        )
        events = await _run(
            llm, [], client_context=ClientContextInput(workspace_root="/w")
        )
        assert _types(events) == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        assert _sse(events)[2] == {
            "type": "tool_result",
            "toolCallId": "u1",
            "result": "未知工具: memory_read",
        }


# ── 7. 预算耗尽（max_tool_rounds） ─────────────────────────────────────


class TestBudgetExhausted:
    """阶段 0 基线 / 阶段 2 依赖：预算耗尽后强制一次无工具回答，且不再执行工具。"""

    async def test_exhaustion_forces_final_answer_and_counts_executions(self):
        tools, executions = make_tools(
            {
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 a.md"},
                    "properties": {"relative_path": {"type": "string"}},
                }
            }
        )

        def _tool_round(call_id: str):
            return [
                Chunk(
                    tool_calls=[
                        {
                            "id": call_id,
                            "name": "read_workspace_file",
                            "args": {"relative_path": "a.md"},
                        }
                    ]
                )
            ]

        llm = ScriptedChat(
            [
                _tool_round("call-1"),
                _tool_round("call-2"),
                [Chunk(content="预算已用完。当前进展：已读取 a.md。")],
            ]
        )

        events = await _run(llm, tools, max_tool_rounds=1,
                            client_context=ClientContextInput(workspace_root="/w"))

        assert _types(events) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        # max_tool_rounds=1 → 两轮带工具调用（range(max_tool_rounds + 1)）
        assert len(executions["read_workspace_file"]) == 2
        assert llm.astream_calls == 3
        # 兜底调用不再 bind_tools（只在一开始 bind 过一次）
        assert llm.bind_tools_calls == 1
        # 兜底 HumanMessage 已追加
        wrapup_messages = llm.seen_messages[2]
        assert isinstance(wrapup_messages[-1], HumanMessage)
        assert "工具调用预算已用完" in wrapup_messages[-1].content
        assert _sse(events)[-1] == {
            "type": "text_delta",
            "content": "预算已用完。当前进展：已读取 a.md。",
        }

    async def test_wrapup_tool_call_is_ignored(self):
        """兜底回答即使吐出 tool_call 也不会被执行（无 execute_round）。"""
        tools, executions = make_tools(
            {
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 a.md"},
                    "properties": {"relative_path": {"type": "string"}},
                }
            }
        )

        def _tool_round(call_id: str):
            return [
                Chunk(
                    tool_calls=[
                        {
                            "id": call_id,
                            "name": "read_workspace_file",
                            "args": {"relative_path": "a.md"},
                        }
                    ]
                )
            ]

        llm = ScriptedChat(
            [
                _tool_round("call-1"),
                _tool_round("call-2"),
                [
                    Chunk(
                        content="预算已用完。",
                        tool_calls=[
                            {
                                "id": "wrapup-1",
                                "name": "read_workspace_file",
                                "args": {"relative_path": "b.md"},
                            }
                        ],
                    )
                ],
            ]
        )

        events = await _run(llm, tools, max_tool_rounds=1,
                            client_context=ClientContextInput(workspace_root="/w"))

        assert _types(events) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        # 兜底轮的 tool_call 未执行：执行次数仍为 2，且没有 b.md
        assert len(executions["read_workspace_file"]) == 2
        assert all(
            args != {"relative_path": "b.md"}
            for args in executions["read_workspace_file"]
        )


# ── 8. 取消（cancel） ──────────────────────────────────────────────────


class TestCancel:
    """阶段 0 基线 / 阶段 8 依赖：取消点决定已发事件与工具执行次数。"""

    async def test_cancel_during_model_stream_stops_before_any_tool_execution(self):
        """第一轮流式期间取消：已流出的文本保留，工具零执行。"""
        tools, executions = make_tools(
            {
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 a.md"},
                    "properties": {"relative_path": {"type": "string"}},
                }
            }
        )
        llm = ScriptedChat(
            [
                [
                    Chunk(content="正在分析"),
                    Chunk(
                        tool_calls=[
                            {
                                "id": "x1",
                                "name": "read_workspace_file",
                                "args": {"relative_path": "a.md"},
                            }
                        ]
                    ),
                ]
            ]
        )
        cancel = CancelAfter(3)  # 第 3 次检查（第二个 chunk 前）取消

        events = await _run(
            llm,
            tools,
            is_cancelled=cancel,
            client_context=ClientContextInput(workspace_root="/w"),
        )

        assert _types(events) == ["preparing", "text_delta"]
        assert _sse(events)[1] == {"type": "text_delta", "content": "正在分析"}
        assert executions["read_workspace_file"] == []
        assert llm.astream_calls == 1

    async def test_cancel_between_tool_rounds_stops_next_model_call(self):
        """工具轮执行完后取消：不再发起下一轮模型调用。"""
        tools, executions = make_tools(
            {
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 a.md"},
                    "properties": {"relative_path": {"type": "string"}},
                }
            }
        )
        llm = ScriptedChat(
            [
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "x1",
                                "name": "read_workspace_file",
                                "args": {"relative_path": "a.md"},
                            }
                        ]
                    )
                ],
                [Chunk(content="不会到达这里。")],
            ]
        )
        cancel = CancelAfter(4)  # 第二轮循环顶部取消

        events = await _run(
            llm,
            tools,
            is_cancelled=cancel,
            client_context=ClientContextInput(workspace_root="/w"),
        )

        assert _types(events) == ["preparing", "tool_start", "tool_result"]
        assert executions["read_workspace_file"] == [{"relative_path": "a.md"}]
        assert llm.astream_calls == 1


# ── 9. 只读工具 ────────────────────────────────────────────────────────


class TestReadOnlyTools:
    """阶段 0 基线 / 阶段 5 依赖：只读路径零写入提案、零挂起、写工具零执行。"""

    async def test_read_only_rounds_emit_no_proposal_and_never_run_write_tools(self):
        tools, executions = make_tools(
            {
                "grep_workspace": {
                    "result": {"ok": True, "summary": "grep 命中 1 处"},
                    "properties": {"pattern": {"type": "string"}},
                },
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 annotations.json"},
                    "properties": {"relative_path": {"type": "string"}},
                },
                "write_workspace_file": {
                    "result": {"ok": True, "summary": "不应被调用"},
                    "properties": {
                        "relative_path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                },
            }
        )
        llm = ScriptedChat(
            [
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "ro1",
                                "name": "grep_workspace",
                                "args": {"pattern": "annotations"},
                            }
                        ]
                    )
                ],
                [
                    Chunk(
                        tool_calls=[
                            {
                                "id": "ro2",
                                "name": "read_workspace_file",
                                "args": {"relative_path": "annotations.json"},
                            }
                        ]
                    )
                ],
                [Chunk(content="只读核对完成，未做任何写入。")],
            ]
        )

        events = await _run(
            llm,
            tools,
            client_context=ClientContextInput(workspace_root="/w"),
        )

        assert _types(events) == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_result",
            "text_delta",
        ]
        # 只读路径不产生提案、不挂起客户端工具
        assert not any(
            e.type in ("file_proposal", "file_proposal_start", "file_proposal_delta")
            for e in events
        )
        assert not any(e.type == "tool_pending" for e in events)
        sse = _sse(events)
        assert [sse[1]["toolCallId"], sse[3]["toolCallId"]] == ["ro1", "ro2"]
        assert sse[2] == {
            "type": "tool_result",
            "toolCallId": "ro1",
            "result": "grep 命中 1 处",
        }
        assert sse[4] == {
            "type": "tool_result",
            "toolCallId": "ro2",
            "result": "已读取 annotations.json",
        }
        # 写工具即使可见也零执行
        assert executions["write_workspace_file"] == []
        assert len(executions["grep_workspace"]) == 1
        assert len(executions["read_workspace_file"]) == 1
        # 写入工具仍在 bind 列表中（阶段门禁不在 bind 时增删，保前缀缓存）
        assert "write_workspace_file" in llm.bound_tool_names


# ── 10. MCP 不可用（HTTP 层） ──────────────────────────────────────────


class _FakeChatOpenAI:
    """替代 ChatOpenAI：assist 流被整体 patch，实例不被真正调用。"""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


def _http_body(mcp_server_url=None, client_job_id="job-baseline-http"):
    return LocalChatStreamRequest(
        api_key="k",
        base_url="https://api.example.com/v1",
        model="test-model",
        messages=[{"role": "user", "content": "hi"}],
        user_content="hi",
        client_job_id=client_job_id,
        client_context=ClientContextInput(
            workspace_root="/tmp/ws",
            mcp_server_url=mcp_server_url,
        ),
    )


async def _collect_sse(body, monkeypatch, *, mcp_loader, assist_stream):
    """驱动 HTTP 层 _stream_local_chat 并解析 SSE data: 行为事件 dict。"""
    from app.api.v1.agent import _stream_local_chat
    from app.core.config import get_settings

    monkeypatch.setattr("app.api.v1.agent.ChatOpenAI", _FakeChatOpenAI)
    monkeypatch.setattr(
        "app.api.v1.agent.load_mcp_tools_from_servers", mcp_loader
    )
    monkeypatch.setattr("app.agent.assist_service.stream_assist", assist_stream)

    events: list[dict] = []
    async for chunk in _stream_local_chat(body, get_settings()):
        for line in chunk.split("\n"):
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if payload:
                events.append(json.loads(payload))
    return events


class TestMcpUnavailable:
    """阶段 0 基线 / 阶段 5、7 依赖：单台 MCP 不可用不阻断本轮，也不产生 error 帧。"""

    async def test_mcp_discovery_failure_keeps_turn_alive_and_uses_local_tools(
        self, monkeypatch
    ):
        from app.agent.tools.tool_registry_meta import LOCAL_CANONICAL_TOOL_NAMES

        async def _raising_loader(*args, **kwargs):
            raise ConnectionError("MCP server unreachable")

        captured: dict = {}

        async def _fake_assist(*args, **kwargs):
            captured["tools"] = list(args[2])
            yield StreamEventPayload(type="preparing", stage="streaming")
            yield StreamEventPayload(type="text_delta", content="本地工具就绪")

        events = await _collect_sse(
            _http_body("http://127.0.0.1:9000"),
            monkeypatch,
            mcp_loader=_raising_loader,
            assist_stream=_fake_assist,
        )

        assert events == [
            {"type": "preparing", "stage": "mcp"},
            {"type": "preparing", "stage": "streaming"},
            {"type": "text_delta", "content": "本地工具就绪"},
            {"type": "done"},
        ]
        # MCP 失败后仍装配了本地工具，且没有 MCP 工具混入
        tool_names = [t.name for t in captured["tools"]]
        assert tool_names, "MCP 失败后本地工具集不应为空"
        assert set(tool_names) <= set(LOCAL_CANONICAL_TOOL_NAMES)
        assert tool_names == sorted(tool_names)

    async def test_mcp_empty_result_keeps_turn_alive(self, monkeypatch):

        async def _empty_loader(*args, **kwargs):
            return []

        async def _fake_assist(*args, **kwargs):
            yield StreamEventPayload(type="preparing", stage="streaming")
            yield StreamEventPayload(type="text_delta", content="ok")

        events = await _collect_sse(
            _http_body("http://127.0.0.1:9000"),
            monkeypatch,
            mcp_loader=_empty_loader,
            assist_stream=_fake_assist,
        )
        assert [e["type"] for e in events] == [
            "preparing",
            "preparing",
            "text_delta",
            "done",
        ]
        assert not any(e["type"] == "error" for e in events)


# ── 取消（HTTP 层）：流中断仍以 done 收尾 ──────────────────────────────


class TestCancelHttpLevel:
    """阶段 0 基线 / 阶段 7 依赖：取消时已取出的帧被丢弃，SSE 仅以 done 收尾。"""

    async def test_cancelled_job_emits_only_done_frame(self, monkeypatch):
        from app.api.v1.agent import _cancel_events

        async def _fake_assist(*args, **kwargs):
            yield StreamEventPayload(type="preparing", stage="streaming")
            yield StreamEventPayload(type="text_delta", content="不应出现")

        async def _unused_loader(*args, **kwargs):
            return []

        job_id = "job-baseline-cancelled"
        event = asyncio.Event()
        event.set()
        _cancel_events[job_id] = event
        try:
            events = await _collect_sse(
                _http_body(None, client_job_id=job_id),
                monkeypatch,
                mcp_loader=_unused_loader,
                assist_stream=_fake_assist,
            )
        finally:
            _cancel_events.pop(job_id, None)

        # 取消检查在 yield 之前：已从生成器取出的那一帧也被丢弃，
        # 因此取消后只剩 done 帧 —— 前端靠它关闭 job。
        assert events == [{"type": "done"}]
