"""阶段 4a：SSE 适配器骨架（``app/agent/langchain_runtime/sse_adapter.py``）对照测试。

覆盖 ``docs/阶段4-SSE适配设计备忘.md`` §8 实施清单的 **第 1-5、7、8 项**：

1. 公开面与驱动方式（``astream`` 而非 ``astream_events``）；
2. 取消：放弃适配器必须 ``cancel``/``aclose`` 底层框架流，工具零执行；
3. ``_delta_events`` 复用 ``events_from_chunk(emit_tool_chunks=False)``、同 chunk 内
   text 先于 reasoning、尾随空 chunk 零事件；
4. 按轮重建 ``ProposalStreamInterceptor``（跨 chunk 拆分的 JSON 字符串）；
5. ``_resolve_round_calls(updates)`` + ``_tool_results(parts)``（双源去重）；
7. 首帧 ``preparing{streaming}``、**不发** ``done`` / ``preparing(mcp)``；
8. 框架异常策略：无 ``error`` 帧、上抛、部分帧。

第 6 项（轮末 ``tool_start`` / ``tool_result`` / ``tool_pending``）与第 9 项
（harness 改造）**不在本文件**；本文件只钉住它的接缝
（:func:`_round_tail` / :class:`RoundTailState` 在每个轮边界收到正确的素材）。

全部离线、确定性：脚本化流式模型（无网络、无真实 provider）、假图替身、
工具一律为结构化存根（零磁盘写入、零副作用）。
"""

from __future__ import annotations

import asyncio
import inspect
import json
from typing import Any

import pytest

# baseline 环境（只有 langchain-core，无 langchain/langgraph）应整体 skip 而不是 collect error
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

from app.agent.assist.proposal_streamer import (  # noqa: E402
    ProposalStreamInterceptor,
)
from app.agent.langchain_runtime import runtime as _runtime  # noqa: E402
from app.agent.langchain_runtime import sse_adapter  # noqa: E402
from app.agent.langchain_runtime.runtime import (  # noqa: E402
    AgentContext,
    build_langchain_agent,
)
from app.agent.langchain_runtime.sse_adapter import (  # noqa: E402
    FrameworkErrorPolicy,
    SseStreamConfig,
    stream_agent_events,
)
from app.agent.stream_adapter import events_from_chunk  # noqa: E402

pytestmark = pytest.mark.filterwarnings(
    "ignore:Pydantic serializer warnings:UserWarning"
)

WRITE_TOOL = "write_workspace_file"
READ_TOOL = "read_workspace_file"


# ── 分片构造辅助 ───────────────────────────────────────────────────────


def text_chunk(text: str, reasoning: str | None = None) -> AIMessageChunk:
    extra = {"reasoning_content": reasoning} if reasoning is not None else {}
    return AIMessageChunk(content=text, additional_kwargs=extra)


def call_chunk(name: str, args_fragment: str, call_id: str, index: int = 0) -> AIMessageChunk:
    """工具调用的**首块**（带 name + id）。"""
    return AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "name": name,
                "args": args_fragment,
                "id": call_id,
                "index": index,
                "type": "tool_call_chunk",
            }
        ],
    )


def call_chunk_cont(args_fragment: str, index: int = 0) -> AIMessageChunk:
    """工具调用的**后续块**（``name``/``id`` 为 ``None``，同 ``index``）。"""
    return AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "name": None,
                "args": args_fragment,
                "id": None,
                "index": index,
                "type": "tool_call_chunk",
            }
        ],
    )


def merged_ai(chunks: list[AIMessageChunk]) -> AIMessage:
    merged: AIMessageChunk | None = None
    for chunk in chunks:
        merged = chunk if merged is None else merged + chunk
    if merged is None:
        return AIMessage(content="")
    return AIMessage(
        content=merged.content, tool_calls=list(merged.tool_calls or [])
    )


# ── 脚本化流式模型（``_generate`` + 块级 ``_astream``）──────────────────


class ScriptedStreamChat(BaseChatModel):
    """按轮次返回预设 chunk 的假聊天模型（离线、确定性）。

    ``counters`` 跨 ``bind_tools`` 的 pydantic 浅拷贝共享——``create_agent``
    在模型节点执行时才 ``bind_tools``（``langchain/agents/factory.py:1432``）。
    """

    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)
    seen_messages: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "lr-agent-scripted-stream-stage4a"

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
        return ChatResult(generations=[ChatGeneration(message=merged_ai(self._round()))])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self.seen_messages.append(list(messages))
        return self._generate(messages)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen_messages.append(list(messages))
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


# ── 工具存根（零副作用）────────────────────────────────────────────────


def make_write_tool(executions: list[dict[str, Any]]) -> StructuredTool:
    def write_stub(relative_path: str, content: str) -> str:
        executions.append({"relative_path": relative_path, "content": content})
        return json.dumps(
            {
                "ok": True,
                "tool": WRITE_TOOL,
                "relative_path": relative_path,
                "content": content,
                "status": "proposal_pending",
            },
            ensure_ascii=False,
        )

    return StructuredTool.from_function(
        func=write_stub, name=WRITE_TOOL, description="写文件提案（存根）"
    )


def make_read_tool(executions: list[dict[str, Any]]) -> StructuredTool:
    def read_stub(relative_path: str = "") -> str:
        executions.append({"relative_path": relative_path})
        return json.dumps(
            {"ok": True, "tool": READ_TOOL, "summary": relative_path},
            ensure_ascii=False,
        )

    return StructuredTool.from_function(
        func=read_stub, name=READ_TOOL, description="读工作区文件（存根）"
    )


# ── 事件读取辅助 ───────────────────────────────────────────────────────


async def collect(
    agent: Any,
    *,
    messages: list[Any] | None = None,
    config: Any = None,
    client_context: Any = None,
    task_phase_ctx: Any = None,
) -> list[Any]:
    frames: list[Any] = []
    async for frame in stream_agent_events(
        agent,
        messages=messages if messages is not None else [HumanMessage(content="执行任务")],
        config=SseStreamConfig() if config is None else config,
        client_context=client_context,
        task_phase_ctx=task_phase_ctx,
    ):
        frames.append(frame)
    return frames


def frame_types(frames: list[Any]) -> list[str]:
    return [frame.type for frame in frames]


def sse(frames: list[Any]) -> list[dict[str, Any]]:
    return [frame.to_sse_dict() for frame in frames]


# ── 清单第 1 项：公开面 + 驱动方式 ─────────────────────────────────────


class RecordingGraph:
    """只实现 ``astream`` 的假图：记录入参，产出给定分片。

    刻意**不**提供 ``astream_events`` —— 若适配器误用该入口会立刻 ``AttributeError``
    （备忘 §7：``astream_events`` 会让 ``data[0]`` 变成协议事件 dict，
    ``isinstance(..., AIMessageChunk)`` 静默全假 → 零事件）。
    """

    def __init__(self, parts: list[dict[str, Any]]) -> None:
        self.parts = parts
        self.kwargs: dict[str, Any] = {}
        self.closed = False

    async def astream(self, _input, **kwargs):
        self.kwargs = dict(kwargs)
        try:
            for part in self.parts:
                yield part
        finally:
            self.closed = True


def message_part(message: Any, **metadata: Any) -> dict[str, Any]:
    meta = {"langgraph_node": "model", "langgraph_step": 1}
    meta.update(metadata)
    return {"type": "messages", "ns": (), "data": (message, meta)}


class TestPublicSurfaceAndDriver:
    """清单第 1 项：``stream_agent_events`` 是素 async generator，且只走 ``astream``。"""

    def test_is_async_generator_function(self):
        assert inspect.isasyncgenfunction(stream_agent_events)

    def test_signature_matches_spec(self):
        params = inspect.signature(stream_agent_events).parameters
        assert list(params) == [
            "agent",
            "messages",
            "config",
            "client_context",
            "task_phase_ctx",
        ]
        assert params["agent"].kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
        for name in ("messages", "config", "client_context", "task_phase_ctx"):
            assert params[name].kind is inspect.Parameter.KEYWORD_ONLY
        # ``config`` 必填（无默认值），但显式允许 None → 全默认
        assert params["config"].default is inspect.Parameter.empty
        assert params["client_context"].default is None
        assert params["task_phase_ctx"].default is None

    async def test_drives_astream_with_messages_and_updates(self):
        graph = RecordingGraph([message_part(text_chunk("嗨"))])
        frames = await collect(graph)

        assert not hasattr(graph, "astream_events")
        assert graph.kwargs["stream_mode"] == ["messages", "updates"]
        assert graph.kwargs["version"] == "v2"
        assert isinstance(graph.kwargs["context"], AgentContext)
        assert graph.kwargs["context"].mode == "assist"
        assert "messages" not in graph.kwargs or graph.kwargs["messages"]
        assert frame_types(frames) == ["preparing", "text_delta"]
        assert frames[1].content == "嗨"
        assert graph.closed is True

    async def test_config_is_dynamic_over_runtime_constants(self):
        """默认流模式/版本在**调用时**取 ``runtime`` 常量（阶段 5 追加 ``custom`` 可跟随）。"""
        assert SseStreamConfig().resolved_stream_modes() == tuple(_runtime.STREAM_MODES)
        assert SseStreamConfig().resolved_version() == _runtime.STREAM_VERSION

        graph = RecordingGraph([message_part(text_chunk("x"))])
        await collect(graph, config=SseStreamConfig(stream_modes=("messages", "updates", "custom")))
        assert graph.kwargs["stream_mode"] == ["messages", "updates", "custom"]

    async def test_context_is_built_from_config_and_kwargs(self):
        graph = RecordingGraph([message_part(text_chunk("x"))])
        await collect(
            graph,
            config=SseStreamConfig(mode="annotation"),
            client_context="ctx-sentinel",
            task_phase_ctx="phase-sentinel",
        )
        context = graph.kwargs["context"]
        assert context.mode == "annotation"
        assert context.client_context == "ctx-sentinel"
        assert context.task_phase_context == "phase-sentinel"

    async def test_config_rejects_unknown_mapping_keys(self):
        with pytest.raises(TypeError, match="未知键"):
            await collect(
                RecordingGraph([]),
                config={"stream_modes": ("messages", "updates"), "thread_id": "x"},
            )

    async def test_config_accepts_mapping_of_known_keys(self):
        graph = RecordingGraph([message_part(text_chunk("m"))])
        frames = await collect(graph, config={"mode": "editor"})
        assert graph.kwargs["context"].mode == "editor"
        assert frame_types(frames) == ["preparing", "text_delta"]


# ── 清单第 3 项：增量事件与顺序 ────────────────────────────────────────


class TestDeltaOrder:
    def test_text_precedes_reasoning_within_one_chunk(self):
        chunk = text_chunk("答", reasoning="想")
        events = sse_adapter._delta_events(chunk)
        assert [event.type for event in events] == ["text_delta", "reasoning_delta"]
        assert [event.content for event in events] == ["答", "想"]

    def test_delegates_to_events_from_chunk_without_tool_chunks(self):
        chunk = AIMessageChunk(
            content="正文",
            additional_kwargs={"reasoning_content": "推理"},
            tool_call_chunks=[
                {
                    "name": READ_TOOL,
                    "args": '{"relative_path": "a.md"}',
                    "id": "c1",
                    "index": 0,
                    "type": "tool_call_chunk",
                }
            ],
        )
        assert sse_adapter._delta_events(chunk) == events_from_chunk(
            chunk, emit_tool_chunks=False
        )
        # tool_call_chunks 绝不在此处变成 tool_start（备忘 §2 映射表）
        assert [event.type for event in sse_adapter._delta_events(chunk)] == [
            "text_delta",
            "reasoning_delta",
        ]

    def test_trailing_empty_chunk_produces_zero_events(self):
        trailing = AIMessageChunk(content="", chunk_position="last")
        assert sse_adapter._delta_events(trailing) == []
        assert ProposalStreamInterceptor().on_chunk(trailing) == []

    async def test_text_before_reasoning_through_the_framework_stream(self):
        model = ScriptedStreamChat(rounds=[[text_chunk("答", reasoning="想")]])
        agent = build_langchain_agent(model, [make_read_tool([])])

        frames = await collect(agent)

        assert frame_types(frames) == [
            "preparing",
            "text_delta",
            "reasoning_delta",
        ]
        assert [frame.content for frame in frames[1:]] == ["答", "想"]


class TestTrailingEmptyChunk:
    async def test_all_empty_round_yields_only_the_preparing_frame(self):
        """整轮只有空分片（含框架自加的尾随空 chunk）→ 零 delta 帧。"""
        model = ScriptedStreamChat(rounds=[[AIMessageChunk(content="")]])
        agent = build_langchain_agent(model, [make_read_tool([])])

        frames = await collect(agent)

        assert frame_types(frames) == ["preparing"]
        assert model.invoke_calls == 1

    async def test_no_frame_carries_an_empty_content(self):
        model = ScriptedStreamChat(rounds=[[text_chunk("只有这一段")]])
        agent = build_langchain_agent(model, [make_read_tool([])])

        frames = await collect(agent)

        # 框架为每个模型轮追加一个 chunk_position="last" 的空分片（实测），
        # 它不得产出任何帧
        assert [frame.content for frame in frames if frame.type == "text_delta"] == [
            "只有这一段"
        ]
        assert all(frame.content for frame in frames if frame.type.endswith("_delta"))


# ── 清单第 4 项：按轮重建提案拦截器 ────────────────────────────────────


def _write_round(
    relative_path: str,
    head: str,
    tail: str,
    call_id: str,
) -> list[AIMessageChunk]:
    """一轮 write 调用，args 被拆成两块（首块带 id，续块 id=None、同 index）。"""
    head_args = f'{{"relative_path": "{relative_path}", "content": "{head}'
    return [
        call_chunk(WRITE_TOOL, head_args, call_id),
        call_chunk_cont(f'{tail}"}}'),
    ]


class TestProposalAcrossRounds:
    """同一 ``index`` / 同一 ``tool_call_id`` 跨轮复用 → 必须按轮重建拦截器。"""

    async def test_two_write_rounds_keep_their_own_proposals(self):
        executions: list[dict[str, Any]] = []
        model = ScriptedStreamChat(
            rounds=[
                _write_round("notes/a.md", "AA", "A", "call_same"),
                _write_round("notes/b.md", "BB", "B", "call_same"),
                [text_chunk("完成")],
            ]
        )
        agent = build_langchain_agent(model, [make_write_tool(executions)])

        frames = await collect(agent)

        # 阶段 4b 起 `_round_tail` 落地，轮尾会补齐工具帧与 dismissed 终态帧
        # （旧路径同等语义：提案载荷未落盘 → 补发 file_proposal(status="dismissed")，
        #  见 app/agent/assist/tool_loop.py:289-302）。本列表为 4b 实测冻结值。
        assert [frame.type for frame in frames] == [
            "preparing",
            "file_proposal_start",
            "file_proposal_delta",
            "file_proposal_delta",
            "tool_start",
            "tool_result",
            "file_proposal",
            "file_proposal_start",
            "file_proposal_delta",
            "file_proposal_delta",
            "tool_start",
            "tool_result",
            "file_proposal",
            "text_delta",
        ]
        assert sse(frames)[1] == {
            "type": "file_proposal_start",
            "summary": "notes/a.md",
            "suggestedRelativePath": "notes/a.md",
            "title": "notes/a.md",
            "detail": "0",
        }
        assert [frame.content for frame in frames if frame.type == "file_proposal_delta"] == [
            "AA",
            "A",
            "BB",
            "B",
        ]
        # 阶段 4b 起轮尾补齐工具帧，第二轮提案帧的下标由 4 后移到 7
        assert sse(frames)[7] == {
            "type": "file_proposal_start",
            "summary": "notes/b.md",
            "suggestedRelativePath": "notes/b.md",
            "title": "notes/b.md",
            "detail": "0",
        }
        # 两个提案的 delta 归属路径各自正确（未被上一轮污染）
        assert [frame.image_path for frame in frames if frame.type == "file_proposal_delta"] == [
            "notes/a.md",
            "notes/a.md",
            "notes/b.md",
            "notes/b.md",
        ]
        # 工具确实执行了两次（存根，无副作用）
        assert [item["relative_path"] for item in executions] == [
            "notes/a.md",
            "notes/b.md",
        ]
        assert model.invoke_calls == 3

    def test_control_shared_interceptor_would_swallow_the_second_round(self):
        """反证：同一个拦截器实例跨轮复用 → 第二轮零事件（证明上一用例真的在钉重建）。"""
        interceptor = ProposalStreamInterceptor()
        first = _write_round("notes/a.md", "AA", "A", "call_same")
        second = _write_round("notes/b.md", "BB", "B", "call_same")

        round1 = [event for chunk in first for event in interceptor.on_chunk(chunk)]
        round2 = [event for chunk in second for event in interceptor.on_chunk(chunk)]

        assert [event.type for event in round1] == [
            "file_proposal_start",
            "file_proposal_delta",
            "file_proposal_delta",
        ]
        assert round2 == []

    async def test_edit_proposal_streams_old_and_new_deltas(self):
        executions: list[dict[str, Any]] = []
        args = '{"relative_path": "a.py", "old_string": "x", "new_string": "y"}'

        def edit_stub(relative_path: str, old_string: str, new_string: str) -> str:
            executions.append({"relative_path": relative_path})
            return json.dumps(
                {"ok": True, "tool": "str_replace_workspace_file"},
                ensure_ascii=False,
            )

        tool = StructuredTool.from_function(
            func=edit_stub, name="str_replace_workspace_file", description="局部替换（存根）"
        )
        model = ScriptedStreamChat(
            rounds=[
                [
                    call_chunk("str_replace_workspace_file", args[:20], "e1"),
                    call_chunk_cont(args[20:]),
                ],
                [text_chunk("改好了")],
            ]
        )
        agent = build_langchain_agent(model, [tool])

        frames = await collect(agent)

        # 阶段 4b 起 `_round_tail` 落地：此序列与阶段 0 冻结基线
        # `tests/test_agent_baseline_contract.py::TestDismissAndReject::`
        # `test_failed_edit_after_streaming_emits_dismissed_terminal_frame` 逐字相同。
        assert [frame.type for frame in frames] == [
            "preparing",
            "file_proposal_start",
            "file_edit_delta",
            "tool_start",
            "tool_result",
            "file_proposal",
            "text_delta",
        ]
        assert sse(frames)[1] == {
            "type": "file_proposal_start",
            "summary": "a.py",
            "suggestedRelativePath": "a.py",
            "title": "a.py",
            "detail": "0",
            "mode": "edit",
            "operation": "edit",
        }
        assert sse(frames)[2] == {
            "type": "file_edit_delta",
            "imagePath": "a.py",
            "oldDelta": "x",
            "newDelta": "y",
        }

    async def test_lr_agent_internal_path_emits_no_proposal(self):
        executions: list[dict[str, Any]] = []
        model = ScriptedStreamChat(
            rounds=[
                _write_round(
                    ".lr-agent/annotations/files/a.json", "x", "", "c-internal"
                ),
                [text_chunk("ok")],
            ]
        )
        agent = build_langchain_agent(model, [make_write_tool(executions)])

        frames = await collect(agent)

        # `.lr-agent/` 内部路径被抑制 → 零提案帧；工具仍真实执行 1 次。
        # 阶段 4b 起轮尾补齐 tool_start/tool_result；旧路径同形（4b 在 baseline
        # 环境复跑旧侧亦为这 4 帧、执行 1 次）。
        assert frame_types(frames) == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
        ]


# ── 清单第 5 项：轮末素材抽取 ──────────────────────────────────────────


class TestRoundCallExtraction:
    def test_reads_calls_from_the_model_update_in_order(self):
        ai = AIMessage(
            content="",
            tool_calls=[
                {"id": "c1", "name": READ_TOOL, "args": {"relative_path": "a.md"}},
                {"id": "c2", "name": WRITE_TOOL, "args": {"relative_path": "b.md"}},
            ],
        )
        calls = sse_adapter._resolve_round_calls({"model": {"messages": [ai]}})

        assert [call.tool_call_id for call in calls] == ["c1", "c2"]
        assert [call.name for call in calls] == [READ_TOOL, WRITE_TOOL]
        assert calls[1].arguments == {"relative_path": "b.md"}

    def test_reads_the_last_ai_message_of_an_after_model_node(self):
        ai = AIMessage(
            content="",
            tool_calls=[{"id": "c9", "name": READ_TOOL, "args": {"relative_path": "z"}}],
        )
        injected = ToolMessage(content="{}", tool_call_id="c0")
        calls = sse_adapter._resolve_round_calls(
            {"BusinessRoundMiddleware.after_model": {"messages": [ai, injected]}}
        )

        assert [call.tool_call_id for call in calls] == ["c9"]

    def test_dedupes_repeated_tool_call_ids(self):
        ai = AIMessage(
            content="",
            tool_calls=[
                {"id": "c1", "name": READ_TOOL, "args": {}},
                {"id": "c1", "name": READ_TOOL, "args": {}},
                {"id": "c2", "name": READ_TOOL, "args": {}},
            ],
        )
        calls = sse_adapter._resolve_round_calls({"model": {"messages": [ai]}})

        assert [call.tool_call_id for call in calls] == ["c1", "c2"]

    def test_ignores_tool_only_and_non_mapping_payloads(self):
        assert sse_adapter._resolve_round_calls({"tools": {"messages": []}}) == []
        assert sse_adapter._resolve_round_calls(None) == []
        assert sse_adapter._resolve_round_calls({"model": {"messages": []}}) == []

    def test_ai_message_without_tool_calls_yields_nothing(self):
        ai = AIMessage(content="只是文本")
        assert sse_adapter._resolve_round_calls({"model": {"messages": [ai]}}) == []


class TestToolResultsDualSource:
    def _messages_part(self, message: ToolMessage) -> dict[str, Any]:
        return message_part(message, langgraph_node="tools", langgraph_step=2)

    def test_dual_source_is_deduped_by_tool_call_id(self):
        parts = [
            self._messages_part(ToolMessage(content="r1", tool_call_id="c1")),
            {
                "type": "updates",
                "ns": (),
                "data": {
                    "tools": {
                        "messages": [
                            ToolMessage(content="r1", tool_call_id="c1"),
                            ToolMessage(content="r2", tool_call_id="c2"),
                        ]
                    }
                },
            },
        ]

        results = sse_adapter._tool_results(parts)

        assert [item.tool_call_id for item in results] == ["c1", "c2"]
        assert [item.content for item in results] == ["r1", "r2"]

    def test_non_tool_messages_are_ignored(self):
        parts = [
            message_part(text_chunk("文本")),
            self._messages_part(ToolMessage(content="r1", tool_call_id="c1")),
        ]
        assert [item.tool_call_id for item in sse_adapter._tool_results(parts)] == ["c1"]

    def test_tool_messages_without_id_are_all_kept(self):
        parts = [
            self._messages_part(ToolMessage(content="a", tool_call_id="")),
            self._messages_part(ToolMessage(content="b", tool_call_id="")),
        ]
        assert [item.content for item in sse_adapter._tool_results(parts)] == ["a", "b"]


class TestRoundTailSeam:
    """清单第 6 项的接缝：每个轮边界交出完整素材，且此刻不产任何帧。"""

    async def test_round_tail_receives_calls_results_and_fresh_interceptor(
        self, monkeypatch
    ):
        captured: list[Any] = []

        async def recorder(state):
            captured.append(state)
            if False:  # pragma: no cover - 保持 async generator 语义
                yield

        monkeypatch.setattr(sse_adapter, "_round_tail", recorder)

        executions: list[dict[str, Any]] = []
        args = json.dumps({"relative_path": "a.md"}, ensure_ascii=False)
        model = ScriptedStreamChat(
            rounds=[
                [
                    call_chunk(READ_TOOL, args, "c1"),
                ],
                [text_chunk("读完了")],
            ]
        )
        agent = build_langchain_agent(model, [make_read_tool(executions)])

        frames = await collect(agent)

        # 接缝不产帧：4a 阶段工具帧全部由第 6 项负责
        assert frame_types(frames) == ["preparing", "text_delta"]
        assert executions == [{"relative_path": "a.md"}]

        assert len(captured) == 2
        first, second = captured

        # 轮 1：模型调用序的调用表 + 双源去重后的工具结果
        assert first.index == 1
        assert [call.tool_call_id for call in first.calls] == ["c1"]
        assert [call.name for call in first.calls] == [READ_TOOL]
        assert [item.tool_call_id for item in first.results] == ["c1"]
        assert first.interrupted is False
        assert set(first.updates) == {"model", "tools"}
        assert first.plan_frame is None
        assert isinstance(first.interceptor, ProposalStreamInterceptor)
        # 原始分片按到达顺序保留（含 metadata，供第 6 项排序/子代理事件使用）
        kinds = [part["type"] for part in first.parts]
        assert kinds[0] == "messages"
        assert kinds[-1] == "updates"
        assert kinds.count("updates") == 2
        assert set(kinds) <= {"messages", "updates", "custom"}
        assert first.parts[0]["data"][1]["langgraph_node"] == "model"
        assert first.parts[0]["data"][1]["langgraph_step"] == 1
        assert any(
            isinstance(part["data"][0], ToolMessage)
            for part in first.parts
            if part["type"] == "messages"
        )

        # 轮 2：纯文本轮，无调用无结果；拦截器是**不同实例**（按轮重建）
        assert second.index == 2
        assert second.calls == ()
        assert second.results == ()
        assert second.interceptor is not first.interceptor

    async def test_control_frame_is_captured_not_forwarded(self, monkeypatch):
        captured: list[Any] = []

        async def recorder(state):
            captured.append(state)
            if False:  # pragma: no cover
                yield

        monkeypatch.setattr(sse_adapter, "_round_tail", recorder)

        plan = {"type": "round_plan", "calls": [{"tool_call_id": "c1"}]}
        graph = RecordingGraph(
            [
                message_part(text_chunk("想一下")),
                {"type": "updates", "ns": (), "data": {"model": {"messages": []}}},
                {"type": "custom", "ns": (), "data": plan},
            ]
        )

        frames = await collect(
            graph,
            config=SseStreamConfig(stream_modes=("messages", "updates", "custom")),
        )

        # 控制帧不产 SSE 帧（阶段 3 备忘 §2：空/控制帧不得产帧）
        assert frame_types(frames) == ["preparing", "text_delta"]
        assert len(captured) == 1
        assert captured[0].control_frames == (plan,)
        assert captured[0].plan_frame == plan


# ── 阶段 5 反向依赖：custom 帧直通 ─────────────────────────────────────


class TestCustomFramePassthrough:
    async def test_custom_payload_is_forwarded_as_event_payload(self):
        graph = RecordingGraph(
            [
                {
                    "type": "custom",
                    "ns": ("model",),
                    "data": {
                        "type": "subagent_text_delta",
                        "content": "子代理输出",
                        "inner_tool_call_id": "i1",
                    },
                },
                message_part(text_chunk("主输出")),
            ]
        )

        frames = await collect(
            graph,
            config=SseStreamConfig(stream_modes=("messages", "updates", "custom")),
        )

        assert frame_types(frames) == [
            "preparing",
            "subagent_text_delta",
            "text_delta",
        ]
        assert sse(frames)[1] == {
            "type": "subagent_text_delta",
            "content": "子代理输出",
            "innerToolCallId": "i1",
        }

    async def test_prebuilt_payload_instance_passes_through_unchanged(self):
        from app.schemas.agent import StreamEventPayload

        payload = StreamEventPayload(type="subagent_done", summary="ok", status="done")
        graph = RecordingGraph(
            [{"type": "custom", "ns": (), "data": payload}]
        )

        frames = await collect(
            graph,
            config=SseStreamConfig(stream_modes=("messages", "updates", "custom")),
        )

        assert frames[1] is payload


# ── 清单第 7 项：首帧 / 绝不发的帧 ─────────────────────────────────────


class TestPreparingAndAbsentFrames:
    async def test_first_frame_is_preparing_streaming(self):
        executions: list[dict[str, Any]] = []
        model = ScriptedStreamChat(
            rounds=[
                [call_chunk(READ_TOOL, '{"relative_path": "a.md"}', "c1")],
                [text_chunk("读完了")],
            ]
        )
        agent = build_langchain_agent(model, [make_read_tool(executions)])

        frames = await collect(
            agent, client_context=None, task_phase_ctx=None
        )

        assert sse(frames)[0] == {"type": "preparing", "stage": "streaming"}
        assert frames[0].stage == "streaming"

    async def test_never_emits_done_or_mcp_stage(self):
        executions: list[dict[str, Any]] = []
        model = ScriptedStreamChat(
            rounds=[
                [call_chunk(READ_TOOL, '{"relative_path": "a.md"}', "c1")],
                [text_chunk("读完了")],
            ]
        )
        agent = build_langchain_agent(model, [make_read_tool(executions)])

        frames = await collect(agent)

        assert "done" not in frame_types(frames)
        assert [frame for frame in frames if frame.type == "preparing"] == [frames[0]]
        assert not any(
            frame.type == "preparing" and frame.stage == "mcp" for frame in frames
        )

    async def test_client_tool_round_also_emits_no_done(self):
        """客户端工具轮（阶段 1 早停语义）同样只有适配器自己该发的帧。"""
        model = ScriptedStreamChat(
            rounds=[
                [call_chunk("auto_annotate", '{"user_request": "标一下"}', "cl1")],
                [text_chunk("不应发生")],
            ]
        )
        agent = build_langchain_agent(model, [make_read_tool([])])

        frames = await collect(
            agent,
            config=SseStreamConfig(
                context=AgentContext(
                    mode="annotation",
                    client_tool_names=frozenset({"auto_annotate"}),
                )
            ),
        )

        assert "done" not in frame_types(frames)
        assert not any(frame.type == "error" for frame in frames)
        assert frames[0].type == "preparing"


# ── 清单第 2 项：取消必须关掉底层框架流 ────────────────────────────────


class GatedGraph:
    """假图：模型分片之后是「工具执行超步」，只有流仍活着才会被推进。"""

    def __init__(self) -> None:
        self.gate = asyncio.Event()
        self.pulls = 0
        self.closed = False
        self.tool_executed = False

    async def astream(self, _input, **_kwargs):
        try:
            self.pulls += 1
            yield message_part(text_chunk("处理中"))
            await self.gate.wait()  # 闸永不开：aclose 必须取消在这里
            self.pulls += 1
            self.tool_executed = True
            yield {
                "type": "updates",
                "ns": (),
                "data": {"tools": {"messages": []}},
            }
        finally:
            self.closed = True


class TestCancelAbandonsFrameworkStream:
    async def test_aclose_cancels_underlying_stream_and_runs_no_tool(self):
        graph = GatedGraph()
        adapter = stream_agent_events(
            graph,
            messages=[HumanMessage(content="x")],
            config=SseStreamConfig(),
        )

        assert (await adapter.__anext__()).type == "preparing"
        assert (await adapter.__anext__()).content == "处理中"
        await adapter.aclose()

        assert graph.closed is True
        assert graph.pulls == 1
        assert graph.tool_executed is False

    async def test_no_orphan_asyncio_task_after_aclose(self):
        graph = GatedGraph()
        before = {task for task in asyncio.all_tasks() if task is not asyncio.current_task()}

        adapter = stream_agent_events(
            graph,
            messages=[HumanMessage(content="x")],
            config=SseStreamConfig(),
        )
        await adapter.__anext__()
        await adapter.__anext__()
        await adapter.aclose()
        await asyncio.sleep(0)

        after = {task for task in asyncio.all_tasks() if task is not asyncio.current_task()}
        assert after <= before

    async def test_abandoning_a_real_agent_leaves_the_tool_unexecuted(self):
        """真实 ``create_agent``：模型仍在流式（被闸住）时放弃适配器 → 工具零执行。"""
        executions: list[dict[str, Any]] = []
        gate = asyncio.Event()

        class GatedWriteModel(BaseChatModel):
            @property
            def _llm_type(self) -> str:
                return "lr-agent-gated-write"

            def bind_tools(self, tools, **kwargs):  # type: ignore[override]
                return self

            def _generate(self, messages, stop=None, run_manager=None, **kwargs):
                # 只走块级流式；本方法仅为满足 BaseChatModel 抽象面
                return ChatResult(
                    generations=[ChatGeneration(message=AIMessage(content=""))]
                )

            async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
                yield ChatGenerationChunk(
                    message=call_chunk(
                        WRITE_TOOL,
                        '{"relative_path": "notes/gated.md", "content": "X',
                        "call_gate",
                    )
                )
                await gate.wait()
                yield ChatGenerationChunk(message=call_chunk_cont('"}'))

        agent = build_langchain_agent(GatedWriteModel(), [make_write_tool(executions)])
        adapter = stream_agent_events(
            agent,
            messages=[HumanMessage(content="写文件")],
            config=SseStreamConfig(),
        )

        collected: list[str] = []
        async for frame in adapter:
            collected.append(frame.type)
            if frame.type == "file_proposal_start":
                break

        assert collected == ["preparing", "file_proposal_start"]
        await adapter.aclose()

        # 模型的 astream 被取消 → 工具节点从未被调度 → 工具零执行
        assert executions == []
        assert gate.is_set() is False


# ── 清单第 8 项：框架异常策略 ──────────────────────────────────────────


class ExplodingGraph:
    def __init__(self) -> None:
        self.closed = False

    async def astream(self, _input, **_kwargs):
        try:
            yield message_part(text_chunk("部分输出"))
            raise RuntimeError("磁盘炸了")
        finally:
            self.closed = True


class TestFrameworkErrorEmitsNoErrorFrame:
    def test_policy_declares_no_error_frame_and_propagation(self):
        policy = sse_adapter._framework_error_policy()

        assert isinstance(policy, FrameworkErrorPolicy)
        assert policy.emit_error_frame is False
        assert policy.emit_done_frame is False
        assert policy.propagate is True
        assert "error" in policy.tool_errors_arrive_as
        assert "1285" in policy.reason

    async def test_raised_framework_error_yields_partial_frames_only(self):
        graph = ExplodingGraph()
        frames: list[Any] = []

        with pytest.raises(RuntimeError, match="磁盘炸了"):
            async for frame in stream_agent_events(
                graph,
                messages=[HumanMessage(content="x")],
                config=SseStreamConfig(),
            ):
                frames.append(frame)

        assert frame_types(frames) == ["preparing", "text_delta"]
        assert frames[1].content == "部分输出"
        assert "done" not in frame_types(frames)
        assert "error" not in frame_types(frames)
        assert not any(frame.type.endswith("error") for frame in frames)
        # 异常路径也必须把底层框架流关掉
        assert graph.closed is True

    async def test_error_path_leaves_no_orphan_asyncio_task(self):
        before = {task for task in asyncio.all_tasks() if task is not asyncio.current_task()}

        frames: list[Any] = []
        with pytest.raises(RuntimeError, match="磁盘炸了"):
            async for frame in stream_agent_events(
                ExplodingGraph(),
                messages=[HumanMessage(content="x")],
                config=SseStreamConfig(),
            ):
                frames.append(frame)
        await asyncio.sleep(0)

        after = {task for task in asyncio.all_tasks() if task is not asyncio.current_task()}
        assert after <= before


# ── 元信息 ─────────────────────────────────────────────────────────────


def test_round_tail_is_deferred_but_wired():
    """第 6 项留白：函数存在、是 async generator、且当前不产帧。"""
    assert inspect.isasyncgenfunction(sse_adapter._round_tail)
    assert "round_tail" in inspect.getsource(sse_adapter.stream_agent_events)


def test_sse_adapter_does_not_call_astream_events():
    """代码体（去掉模块 docstring 后的正文）不得调用 ``astream_events``。

    适配器只经 ``runtime.stream_agent_raw_events`` 走 ``agent.astream``
    （备忘 §7 的**已核实但极易踩**条目：``astream_events`` 会让 ``data[0]``
    变成协议事件 dict → ``isinstance(..., AIMessageChunk)`` 静默全假 → 零事件）。
    """
    body = inspect.getsource(sse_adapter).split('"""', 2)[2]
    assert "astream_events" not in body
    assert "stream_agent_raw_events(" in body
