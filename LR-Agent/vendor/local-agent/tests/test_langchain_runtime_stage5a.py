"""阶段 5a：只读子代理带内通道（``custom``）+ 视觉兜底 middleware 对照测试。

覆盖 ``docs/阶段5-MCP与子代理与视觉设计备忘.md`` §2/§3/§5 的两条实施项：

- §2 / 清单第 4 项：``explore_readonly`` 保持**单个工具**，内部跑既有
  :class:`~app.agent.assist.explore_readonly.ExploreReadonlyRunner`，
  事件经 ``runtime.stream_writer`` 走 ``custom`` 流；
- §3 / 清单第 5 项：``VisionFallbackMiddleware``（``after_model``）复刻旧
  「第一轮无 tool call → 加载附图」。

全部离线、确定性：脚本化模型（无网络、无真实 provider）、假 vision 函数、
工具一律为结构化存根（零磁盘写入；工作区只读）。

**已知外观性告警**：声明 ``runtime: ToolRuntime`` 的工具在 ``messages`` 流下会触发
``PydanticSerializationUnexpectedValue(field_name='context')``——外观性，工具照样
恰好执行一次（``experiments/PROBE-STAGE5-FINDINGS.md`` 新风险 5），本文件按类别忽略。
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

import pytest

# baseline 环境（只有 langchain-core，无 langchain/langgraph）应整体 skip 而不是 collect error
pytest.importorskip("langchain")

from langchain.agents import create_agent  # noqa: E402
from langchain.agents.middleware import AgentMiddleware  # noqa: E402
from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import (  # noqa: E402
    AIMessage,
    AIMessageChunk,
    ToolMessage,
)
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
)
from langchain_core.tools import StructuredTool  # noqa: E402
from pydantic import Field  # noqa: E402

from app.agent.assist.explore_readonly import (  # noqa: E402
    EXPLORE_READONLY_TOOL_NAME,
)
from app.agent.chat_message_builder import (  # noqa: E402
    build_multimodal_user_message,
)
from app.agent.langchain_runtime.middleware import (  # noqa: E402
    BusinessRoundMiddleware,
    BudgetWrapUpMiddleware,
    build_business_middleware,
)
from app.agent.langchain_runtime.runtime import AgentContext  # noqa: E402
from app.agent.langchain_runtime.subagent import (  # noqa: E402
    SUBAGENT_EVENT_TYPES,
    build_explore_readonly_agent_tool,
    subagent_event_payload,
)
from app.agent.langchain_runtime.vision import (  # noqa: E402
    VISION_FALLBACK_ID_PREFIX,
    VISION_FALLBACK_IMAGE_TEXT,
    VisionFallbackMiddleware,
    VisionToolResultMiddleware,
)
from app.agent.tools.workspace_file_reader import (  # noqa: E402
    VISION_PATH_MARKER,
    VISION_TOOL_NAME,
)
from app.schemas.agent import ClientContextInput  # noqa: E402

pytestmark = pytest.mark.filterwarnings(
    "ignore:Pydantic serializer warnings:UserWarning"
)

WRITE_TOOL = "write_workspace_file"
GREP_TOOL = "grep_workspace"
SUBAGENT_BUDGET = 3
STREAM_MODES = ["messages", "updates", "custom"]

# 2x2 RGB PNG（75 字节，离线常量；**可被 PIL 识别**）。
#
# **不要换回阶段 5a 原来那串 34 字节「1x1 PNG」**：它的 IHDR CRC 是错的，
# ``PIL.Image.open`` 直接抛 ``UnidentifiedImageError`` → ``_encode_image_data_url``
# 返回 ``None`` → ``build_multimodal_user_message`` 静默退化成纯文本
# ``HumanMessage``。于是阶段 5a 那条「第二次调用里没有 image_url」的断言是
# **空过**的（不管候选实现好坏都成立）。阶段 5b 起本条常量必须是真 PNG，
# 否则「第二次调用含图」的断言同样是假绿。
PNG_2X2 = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a73"
    "0000001249444154789c633c21a7c1c0c0c0c40006000d720112415a2335000000"
    "0049454e44ae426082"
)


class SimpleSettings:
    """只带视觉/子代理相关字段的最小 settings 替身（避免构造完整 Settings）。"""

    def __init__(self, **kwargs: Any) -> None:
        self.agent_subagent_max_tool_rounds = kwargs.pop(
            "agent_subagent_max_tool_rounds", 8
        )
        self.agent_chat_vision_max_edge = kwargs.pop("agent_chat_vision_max_edge", 1280)
        self.agent_chat_vision_jpeg_quality = kwargs.pop(
            "agent_chat_vision_jpeg_quality", 85
        )
        for key, value in kwargs.items():
            setattr(self, key, value)


# ── 脚本化模型 ─────────────────────────────────────────────────────────


def tc_chunk(name: str, args: dict, call_id: str) -> AIMessageChunk:
    return AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "name": name,
                "args": json.dumps(args, ensure_ascii=False),
                "id": call_id,
                "index": 0,
                "type": "tool_call_chunk",
            }
        ],
    )


class ScriptedChat(BaseChatModel):
    """按轮次返回预设 chunk 的假聊天模型（离线、确定性）。"""

    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)

    @property
    def _llm_type(self) -> str:
        return "s5a-scripted-chat"

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [
            getattr(t, "name", str(t)) for t in tools
        ]
        return self

    def _round(self) -> list[AIMessageChunk]:
        index = int(self.counters.get("calls", 0))
        self.counters["calls"] = index + 1
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
                        content=merged.content if merged else "",
                        tool_calls=list(merged.tool_calls) if merged else [],
                    )
                )
            ]
        )

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        return self._generate(messages)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.counters.setdefault("inputs", []).append(list(messages))
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


class InnerScriptedChat(ScriptedChat):
    """子代理内层模型：前 ``tool_rounds`` 次调用吐工具调用，之后吐摘要。

    用来验证「自带预算」= ``settings.agent_subagent_max_tool_rounds``，
    与父预算无关（``app/agent/assist/explore_readonly.py:259-261``）。
    注意：runner 在跑满 ``max_rounds`` 后会再额外调一次模型要摘要
    （``explore_readonly.py:402-421`` 的收尾请求），因此「模型调用数」
    恒为 ``max_rounds + 1``（上限内），而「工具轮数」才是 ``max_rounds``。
    """

    tool_rounds: int = Field(default=0)
    summary: str = Field(default="查阅摘要：结论")

    @property
    def _llm_type(self) -> str:
        return "s5a-inner-scripted-chat"

    def _round(self) -> list[AIMessageChunk]:
        index = int(self.counters.get("calls", 0))
        self.counters["calls"] = index + 1
        if index < self.tool_rounds:
            self.counters["tool_calls"] = int(self.counters.get("tool_calls", 0)) + 1
            return [tc_chunk(GREP_TOOL, {"pattern": "Foo"}, f"inner-{index + 1}")]
        return [AIMessageChunk(content=self.summary)]


# ── 工具存根（零磁盘写入）──────────────────────────────────────────────


def counting_tool(name: str, counters: dict[str, int]) -> StructuredTool:
    def _stub(**kwargs) -> str:
        counters[name] = counters.get(name, 0) + 1
        return json.dumps({"ok": True, "tool": name}, ensure_ascii=False)

    return StructuredTool.from_function(func=_stub, name=name, description=name)


def tool_fn_map(tools: list[StructuredTool]) -> dict[str, Any]:
    return {tool.name: tool.func for tool in tools if tool.func is not None}


def noop_tool() -> StructuredTool:
    """占位工具（视觉用例需要）：让图存在 ``tools`` 节点，从而保留
    ``loop_exit_node → model`` 的条件边（``factory.py:1707-1718``）。

    没有工具时 ``create_agent`` 走 ``factory.py:1735`` 的 ``else`` 分支，把
    ``after_model`` 直连 END——此时注入合成 AI 也**无法**回跳模型。
    生产候选必然挂了工具（``read_image_for_vision`` / ``explore_readonly`` 等），
    所以这里补一个零副作用占位件，而不是去掉断言。
    """

    def _noop(message: str = "") -> str:
        return json.dumps({"ok": True, "message": message}, ensure_ascii=False)

    return StructuredTool.from_function(func=_noop, name="noop", description="noop")


async def _never_cancelled() -> bool:
    return False


def make_explore_tool(
    *,
    inner_llm: Any,
    counters: dict[str, int],
    max_rounds: int = SUBAGENT_BUDGET,
    is_cancelled=_never_cancelled,
) -> StructuredTool:
    """同步构造（``build_explore_readonly_agent_tool`` 本身不需要事件循环）。"""
    tools = [counting_tool(GREP_TOOL, counters), counting_tool(WRITE_TOOL, counters)]
    return build_explore_readonly_agent_tool(
        llm=inner_llm,
        settings=SimpleSettings(agent_subagent_max_tool_rounds=max_rounds),
        is_cancelled=is_cancelled,
        parent_tools=tools,
        parent_fn_map=tool_fn_map(tools),
        client_context=None,
    )


# ── 驱动辅助 ───────────────────────────────────────────────────────────


async def drive(agent: Any, *, text: str = "go", modes: list[str] | None = None):
    raw: list[Any] = []
    async for event in agent.astream(
        {"messages": [AIMessage(content=text)]},
        context=AgentContext(),
        stream_mode=modes or STREAM_MODES,
        version="v2",
    ):
        raw.append(event)
    return raw


def custom_frames(raw: list[Any]) -> list[dict[str, Any]]:
    return [
        event["data"]
        for event in raw
        if isinstance(event, dict) and event.get("type") == "custom"
    ]


def update_nodes(raw: list[Any]) -> list[list[str]]:
    return [
        sorted(event["data"])
        for event in raw
        if isinstance(event, dict) and event.get("type") == "updates"
    ]


def updates_of(raw: list[Any]) -> list[dict[str, Any]]:
    return [
        event["data"]
        for event in raw
        if isinstance(event, dict) and event.get("type") == "updates"
    ]


def injected_messages(raw: list[Any]) -> list[Any]:
    """``updates`` 流里节点输出携带的消息（按到达顺序）。"""
    out: list[Any] = []
    for data in updates_of(raw):
        for update in data.values():
            if isinstance(update, dict):
                out.extend(update.get("messages") or [])
    return out


def streamed_tool_messages(raw: list[Any]) -> list[ToolMessage]:
    """``messages`` 流里的 ``ToolMessage``（v1 handler 不过滤它们）。"""
    out: list[ToolMessage] = []
    for event in raw:
        if not isinstance(event, dict) or event.get("type") != "messages":
            continue
        data = event.get("data")
        if isinstance(data, tuple) and data and isinstance(data[0], ToolMessage):
            out.append(data[0])
    return out


# ── A. 只读子代理：带内通道 + 旧保证 ───────────────────────────────────


@pytest.mark.asyncio
async def test_subagent_events_go_through_custom_channel_with_old_names():
    """``subagent_*`` 事件经 ``runtime.stream_writer`` 出现在 ``custom`` 流，名与载荷同旧。"""
    counters: dict[str, int] = {}
    tool = make_explore_tool(
        inner_llm=InnerScriptedChat(tool_rounds=1), counters=counters
    )
    parent = ScriptedChat(
        rounds=[
            [tc_chunk(EXPLORE_READONLY_TOOL_NAME, {"query": "找 Foo"}, "p-call-1")],
            [AIMessageChunk(content="查完了")],
        ]
    )
    agent = create_agent(
        parent, [tool], context_schema=AgentContext, name="s5a_subagent_channel"
    )
    raw = await drive(agent)
    frames = custom_frames(raw)

    types = [frame["type"] for frame in frames]
    assert types == [
        "subagent_start",
        "subagent_tool_start",
        "subagent_tool_result",
        "subagent_text_delta",
        "subagent_done",
    ], types
    assert set(types) <= set(SUBAGENT_EVENT_TYPES)

    start = frames[0]
    assert start["tool_call_id"] == "p-call-1"  # 父工具 id，与父的 tool_result 对齐
    assert start["query"] == "找 Foo"
    assert "focus_path" not in start  # None 字段不出现（同 to_sse_dict）

    tool_start = frames[1]
    assert tool_start["inner_tool_call_id"] == "inner-1"
    assert tool_start["name"] == GREP_TOOL
    assert json.loads(tool_start["arguments"]) == {"pattern": "Foo"}

    tool_result = frames[2]
    assert tool_result["inner_tool_call_id"] == "inner-1"
    assert tool_result["status"] == "done"
    assert GREP_TOOL in tool_result["result"]

    done = frames[-1]
    assert done["status"] == "done"
    assert done["summary"] == "查阅摘要：结论"
    assert counters == {GREP_TOOL: 1}
    # 内层不产出父的 text_delta：父 messages 流里没有内层摘要文本
    assert "查阅摘要：结论" not in json.dumps(
        [
            str(getattr(event["data"][0], "content", ""))
            for event in raw
            if isinstance(event, dict)
            and event.get("type") == "messages"
            and isinstance(event.get("data"), tuple)
        ]
    )


def test_subagent_payload_field_names_match_old_stream_event_payload():
    """帧字段名与旧 ``StreamEventPayload`` 一致，且 ``None`` 字段不出现。"""
    from app.schemas.agent import StreamEventPayload

    old = StreamEventPayload(
        type="subagent_tool_result",
        tool_call_id="parent-1",
        inner_tool_call_id="inner-1",
        result="ok",
        status="done",
    )
    payload = subagent_event_payload(old)
    assert payload == {
        "type": "subagent_tool_result",
        "status": "done",
        "tool_call_id": "parent-1",
        "result": "ok",
        "inner_tool_call_id": "inner-1",
    }
    # 与旧载荷同一套字段名（``to_sse_dict`` 只做 snake→camel 重命名）
    assert set(payload) <= set(StreamEventPayload.model_fields)


@pytest.mark.asyncio
async def test_subagent_never_reaches_write_tools_and_only_summary_in_parent():
    """写工具零执行；父消息链里只有摘要（内层轨迹不进父 ``messages``）。"""
    counters: dict[str, int] = {}
    tool = make_explore_tool(
        inner_llm=InnerScriptedChat(tool_rounds=1), counters=counters
    )
    parent = ScriptedChat(
        rounds=[
            [tc_chunk(EXPLORE_READONLY_TOOL_NAME, {"query": "找 Foo"}, "p1")],
            [AIMessageChunk(content="结论")],
        ]
    )
    agent = create_agent(parent, [tool], context_schema=AgentContext, name="s5a_no_write")
    raw = await drive(agent)

    assert counters.get(WRITE_TOOL, 0) == 0
    assert counters.get(GREP_TOOL, 0) == 1

    tool_messages = streamed_tool_messages(raw)
    assert len(tool_messages) == 1
    assert tool_messages[0].tool_call_id == "p1"
    # 旧路径 ``tool_loop.py:140-146,253-260``：父侧 tool_result 文本 = 摘要
    assert tool_messages[0].content == "查阅摘要：结论"
    # 内层轨迹（grep 结果、内层提示词）不得进入父消息链
    joined = json.dumps([str(m.content) for m in streamed_tool_messages(raw)])
    assert GREP_TOOL not in joined
    assert "查阅任务" not in joined


@pytest.mark.asyncio
async def test_subagent_self_budget_limits_inner_rounds_and_returns_summary():
    """自带预算：内层最多 ``agent_subagent_max_tool_rounds`` 轮，且仍给出摘要。"""
    counters: dict[str, int] = {}
    inner = InnerScriptedChat(tool_rounds=SUBAGENT_BUDGET, summary="轮次用尽后的摘要")
    tool = make_explore_tool(inner_llm=inner, counters=counters)
    agent = create_agent(
        ScriptedChat(
            rounds=[
                [tc_chunk(EXPLORE_READONLY_TOOL_NAME, {"query": "大范围"}, "p2")],
                [AIMessageChunk(content="完成")],
            ]
        ),
        [tool],
        context_schema=AgentContext,
        name="s5a_budget",
    )
    raw = await drive(agent)

    assert inner.counters["tool_calls"] == SUBAGENT_BUDGET
    assert inner.counters["calls"] == SUBAGENT_BUDGET + 1  # 收尾摘要那次不算工具轮
    assert counters.get(GREP_TOOL, 0) == SUBAGENT_BUDGET
    assert counters.get(WRITE_TOOL, 0) == 0
    done = [f for f in custom_frames(raw) if f["type"] == "subagent_done"]
    assert len(done) == 1
    assert done[0]["status"] == "done"
    assert done[0]["summary"] == "轮次用尽后的摘要"
    assert streamed_tool_messages(raw)[0].content == "轮次用尽后的摘要"


@pytest.mark.asyncio
async def test_subagent_budget_is_independent_of_parent_budget():
    """父预算与子代理预算互不参与：父 ``max_tool_rounds=1`` 不影响内层 3 轮。"""
    counters: dict[str, int] = {}
    inner = InnerScriptedChat(tool_rounds=SUBAGENT_BUDGET, summary="子摘要")
    tool = make_explore_tool(inner_llm=inner, counters=counters)
    agent = create_agent(
        ScriptedChat(
            rounds=[
                [tc_chunk(EXPLORE_READONLY_TOOL_NAME, {"query": "大范围"}, "p2b")],
                [AIMessageChunk(content="父结束")],
            ]
        ),
        [tool],
        context_schema=AgentContext,
        middleware=build_business_middleware(max_tool_rounds=1),
        name="s5a_parent_budget",
    )
    await drive(agent)
    assert inner.counters["tool_calls"] == SUBAGENT_BUDGET
    assert counters.get(GREP_TOOL, 0) == SUBAGENT_BUDGET
    assert counters.get(WRITE_TOOL, 0) == 0


@pytest.mark.asyncio
async def test_subagent_cancellation_stops_it_inside_the_graph():
    """取消信号置位后子代理立即停：``subagent_done.status == "error"``、零工具执行。"""
    counters: dict[str, int] = {}
    cancelled = {"flag": False}

    async def is_cancelled() -> bool:
        return cancelled["flag"]

    tool = make_explore_tool(
        inner_llm=InnerScriptedChat(tool_rounds=99),
        counters=counters,
        is_cancelled=is_cancelled,
    )
    agent = create_agent(
        ScriptedChat(
            rounds=[
                [tc_chunk(EXPLORE_READONLY_TOOL_NAME, {"query": "取消我"}, "p3")],
                [AIMessageChunk(content="结束")],
            ]
        ),
        [tool],
        context_schema=AgentContext,
        name="s5a_cancel",
    )

    frames: list[dict[str, Any]] = []

    async def consume() -> None:
        async for event in agent.astream(
            {"messages": [AIMessage(content="go")]},
            context=AgentContext(),
            stream_mode=STREAM_MODES,
            version="v2",
        ):
            if isinstance(event, dict) and event.get("type") == "custom":
                frames.append(event["data"])
                # 第一个 subagent_tool_start 之后立刻取消：这是在 runner 的
                # 「每轮开头」检查之后、工具真正执行之前（explore_readonly.py:357-362）。
                if event["data"]["type"] == "subagent_tool_start":
                    cancelled["flag"] = True

    await asyncio.wait_for(consume(), timeout=60)

    assert frames[0]["type"] == "subagent_start"
    done = [f for f in frames if f["type"] == "subagent_done"]
    assert len(done) == 1
    assert done[0]["status"] == "error"
    assert "停止" in done[0]["summary"]
    # 取消生效：第 1 轮执行完之后立即停，绝不会有第 2 轮
    assert counters.get(GREP_TOOL, 0) == 1
    assert counters.get(WRITE_TOOL, 0) == 0
    assert len([f for f in frames if f["type"] == "subagent_tool_start"]) == 1


@pytest.mark.asyncio
async def test_subagent_frames_are_silently_dropped_without_custom_stream_mode():
    """缺 ``"custom"`` 时：工具照常执行、**零 custom 帧、零异常**（静默丢弃）。

    这是阶段 4 适配器必须硬断言 ``stream_mode`` 的原因，也是本文件**如实记录**
    的实测结论。它同时修正了探针 1 B 组的机制表述：
    ``Runtime.merge``（``langgraph/runtime.py:248-250``）在**有父流**时用外层
    astream 的真 writer 覆盖内层 no-op，因此工具侧拿到的 writer 不是
    ``_no_op_stream_writer``，写帧不会报错，但帧在**外层**被按模式过滤掉。
    也就是说「工具侧自检模式清单」做不到——必须在装配 ``stream_mode`` 的那一层断言。
    """
    counters: dict[str, int] = {}
    tool = make_explore_tool(
        inner_llm=InnerScriptedChat(tool_rounds=0), counters=counters
    )
    agent = create_agent(
        ScriptedChat(
            rounds=[
                [tc_chunk(EXPLORE_READONLY_TOOL_NAME, {"query": "x"}, "p4")],
                [AIMessageChunk(content="done")],
            ]
        ),
        [tool],
        context_schema=AgentContext,
        name="s5a_no_custom",
    )
    raw = await drive(agent, modes=["messages", "updates"])  # 故意不含 custom

    assert custom_frames(raw) == []  # 静默丢弃
    assert counters.get(GREP_TOOL, 0) == 0  # 工具仍执行（InnerScriptedChat tool_rounds=0）
    # 工具结果照常回到父消息链（子代理摘要依然可见）
    assert [m.content for m in streamed_tool_messages(raw)] == ["查阅摘要：结论"]

    # 对照：同一场景（全新 agent，避免脚本模型轮次串台）含 custom 时有帧
    tool_with = make_explore_tool(
        inner_llm=InnerScriptedChat(tool_rounds=0), counters={}
    )
    agent_with = create_agent(
        ScriptedChat(
            rounds=[
                [tc_chunk(EXPLORE_READONLY_TOOL_NAME, {"query": "x"}, "p5")],
                [AIMessageChunk(content="done")],
            ]
        ),
        [tool_with],
        context_schema=AgentContext,
        name="s5a_with_custom",
    )
    raw_with = await drive(agent_with, modes=STREAM_MODES)
    assert [f["type"] for f in custom_frames(raw_with)] == [
        "subagent_start",
        "subagent_text_delta",
        "subagent_done",
    ]


@pytest.mark.asyncio
async def test_explore_tool_schema_unchanged_and_runtime_not_exposed():
    """工具 schema 与旧注册表同源：``query`` 必填 / ``focus_path`` 可选，不含 ``runtime``。"""
    from langchain_core.utils.function_calling import convert_to_openai_tool

    counters: dict[str, int] = {}
    tool = make_explore_tool(
        inner_llm=InnerScriptedChat(tool_rounds=0), counters=counters
    )
    assert tool.name == EXPLORE_READONLY_TOOL_NAME
    openai_tool = convert_to_openai_tool(tool)
    params = openai_tool["function"]["parameters"]
    assert sorted(params["properties"]) == ["focus_path", "query"]
    assert params["required"] == ["query"]
    assert "runtime" not in json.dumps(openai_tool)
    # 旧描述逐字（registry.py:539-544）
    assert openai_tool["function"]["description"].startswith("只读查阅子代理")


@pytest.mark.asyncio
async def test_tool_body_can_be_driven_directly_with_a_fake_runtime():
    """直接驱动工具体（不经图）：帧进入 sink，返回摘要化文本。"""
    counters: dict[str, int] = {}

    class FakeRuntime:
        tool_call_id = "direct-1"

        def __init__(self) -> None:
            self.frames: list[dict[str, Any]] = []

        def stream_writer(self, payload: dict[str, Any]) -> None:
            self.frames.append(payload)

    tool = make_explore_tool(
        inner_llm=InnerScriptedChat(tool_rounds=1), counters=counters
    )
    runtime = FakeRuntime()
    result = await tool.coroutine(query="找 Foo", focus_path=None, runtime=runtime)

    assert result == "查阅摘要：结论"
    assert [frame["type"] for frame in runtime.frames] == [
        "subagent_start",
        "subagent_tool_start",
        "subagent_tool_result",
        "subagent_text_delta",
        "subagent_done",
    ]
    assert all(frame["tool_call_id"] == "direct-1" for frame in runtime.frames)


# ── B. 视觉兜底 middleware ─────────────────────────────────────────────


class RecordingVision(VisionFallbackMiddleware):
    """记录每次 ``after_model`` 的状态增量，用于钉住「轮次计数无条件落盘」。"""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.updates: list[dict[str, Any]] = []
        self.seen_rounds: list[int] = []
        self.seen_tool_calls: list[int] = []

    async def _compute(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        if isinstance(state, dict):
            self.seen_rounds.append(int(state.get("vision_rounds") or 0))
            messages = state["messages"]
            last = messages[-1] if messages else None
            self.seen_tool_calls.append(len(getattr(last, "tool_calls", None) or []))
        update = await super()._compute(state, runtime)
        self.updates.append(dict(update or {}))
        return update


def make_workspace(tmp_path, *, image: bool = True) -> tuple[ClientContextInput, str]:
    if image:
        (tmp_path / "demo.png").write_bytes(PNG_2X2)
    return ClientContextInput(workspace_root=str(tmp_path)), "demo.png"


def vision_result(tmp_path, rel: str) -> str:
    absolute = str(tmp_path / rel)
    return json.dumps(
        {
            "ok": True,
            "path": absolute,
            "name": rel,
            "width": 2,
            "height": 2,
            "format": "PNG",
            VISION_PATH_MARKER: absolute,
            "message": f"已加载图片 {rel}（2x2 PNG）。",
        },
        ensure_ascii=False,
    )


def image_blocks(messages: list[Any]) -> list[dict[str, Any]]:
    """按顺序收集 ``messages`` 里所有 ``image_url`` 内容块。"""
    out: list[dict[str, Any]] = []
    for message in messages:
        content = getattr(message, "content", None)
        if isinstance(content, list):
            out.extend(
                block
                for block in content
                if isinstance(block, dict) and block.get("type") == "image_url"
            )
    return out


def multimodal_messages(messages: list[Any]) -> list[Any]:
    """``messages`` 里 content 为「text + image_url」两块的 HumanMessage。"""
    out: list[Any] = []
    for message in messages:
        content = getattr(message, "content", None)
        if not isinstance(content, list) or len(content) != 2:
            continue
        if (
            isinstance(content[0], dict)
            and content[0].get("type") == "text"
            and isinstance(content[1], dict)
            and content[1].get("type") == "image_url"
        ):
            out.append(message)
    return out


def build_vision_agent(
    *,
    middleware: list[Any],
    rounds: list[list[AIMessageChunk]] | None = None,
    tools: list[Any] | None = None,
    name: str = "s5a_vision",
) -> tuple[Any, ScriptedChat]:
    model = ScriptedChat(
        rounds=rounds
        or [
            [AIMessageChunk(content="直接回答")],
            [AIMessageChunk(content="补充")],
        ]
    )
    agent = create_agent(
        model,
        tools if tools is not None else [noop_tool()],
        context_schema=AgentContext,
        middleware=middleware,
        name=name,
    )
    return agent, model


@pytest.mark.asyncio
async def test_vision_fallback_triggers_on_first_round_without_tool_call(tmp_path):
    """正路径：第一轮无调用 → 读图 + 注入「AI（伪调用）+ 匹配 ToolMessage」→ +1 次模型调用。"""
    ctx, rel = make_workspace(tmp_path)
    vision_calls: list[dict[str, Any]] = []

    def vision_fn(relative_path: str = "") -> str:
        vision_calls.append({"relative_path": relative_path})
        return vision_result(tmp_path, rel)

    vision = RecordingVision(
        vision_fn=vision_fn,
        provider_is_vision=True,
        settings=SimpleSettings(),
        client_context=ctx,
        user_content=f"看看 {rel}",
    )
    agent, model = build_vision_agent(middleware=[vision])
    raw = await drive(agent, text=f"看看 {rel}")

    assert model.counters["calls"] == 2  # 恰好 +1
    assert all("tools" not in nodes for nodes in update_nodes(raw))
    assert vision_calls == [{"relative_path": rel}]

    frames = custom_frames(raw)
    assert [frame["type"] for frame in frames] == ["tool_start", "tool_result"]
    assert frames[0]["name"] == VISION_TOOL_NAME
    assert json.loads(frames[0]["arguments"]) == {"relative_path": rel}
    assert VISION_PATH_MARKER not in frames[1]["result"]
    assert "已加载图片" in frames[1]["result"]

    # 唯一可用注入形状：AI（伪调用）在前 + id 匹配的 ToolMessage 在后
    assert vision.updates[0]["vision_attempted"] is True
    assert vision.updates[0]["vision_rounds"] == 1
    messages = injected_messages(raw)
    ai = [m for m in messages if isinstance(m, AIMessage) and m.tool_calls]
    tools = [m for m in messages if isinstance(m, ToolMessage)]
    assert len(ai) == 1 and len(tools) == 1
    assert ai[0].tool_calls[0]["id"] == tools[0].tool_call_id
    assert str(ai[0].tool_calls[0]["id"]).startswith(VISION_FALLBACK_ID_PREFIX)
    assert tools[0].name == VISION_TOOL_NAME
    assert "已加载图片" in str(tools[0].content)

    # 第二次模型调用确实拿到了伪调用 + 工具结果
    second_input = model.counters["inputs"][1]
    assert any(
        isinstance(m, ToolMessage) and m.tool_call_id == tools[0].tool_call_id
        for m in second_input
    )

    # **阶段 5b 修复的核心断言**：第二次调用的输入里**必须**有 ``image_url`` 块。
    # 旧路径在工具结果之后追加多模态 HumanMessage（``assist_vision.py:96-104``），
    # 没有它 = 纯文本模型看不到图 = 兜底功能退化。
    human_images = multimodal_messages(second_input)
    assert len(human_images) == 1, [str(m) for m in second_input]
    injected_human = human_images[0]
    # 位置 = 工具结果之后、链尾（旧顺序：ToolMessage → 附图消息）
    assert second_input[-1] is injected_human
    assert isinstance(second_input[-2], ToolMessage)
    assert injected_human.content[0] == {
        "type": "text",
        "text": VISION_FALLBACK_IMAGE_TEXT,
    }
    data_url = injected_human.content[1]["image_url"]["url"]
    assert data_url.startswith("data:image/jpeg;base64,")
    assert len(base64.b64decode(data_url.split(",", 1)[1])) > 0
    # 同一条消息也必须经 ``updates`` 的 state 增量落盘（不只是 wrap 层临时追加）
    assert any(m is injected_human for m in injected_messages(raw))

    # 旧侧形状回归：用**旧路径的 helper** 组装同一个 payload，逐字节相等。
    old_message = await build_multimodal_user_message(
        VISION_FALLBACK_IMAGE_TEXT,
        image_absolute_path=str(tmp_path / rel),
        max_edge=1280,
        jpeg_quality=85,
    )
    assert old_message.content[0] == {
        "type": "text",
        "text": VISION_FALLBACK_IMAGE_TEXT,
    }
    assert old_message.content[1]["image_url"]["url"].startswith(
        "data:image/jpeg;base64,"
    )
    assert injected_human.content == old_message.content


@pytest.mark.asyncio
async def test_vision_fallback_skipped_when_first_round_has_real_tool_call(tmp_path):
    """触发条件是**第一轮无 tool call**；第一轮调了真实工具时不兜底。"""
    ctx, rel = make_workspace(tmp_path)
    vision_calls: list[str] = []
    executed: list[str] = []

    def vision_fn(relative_path: str = "") -> str:
        vision_calls.append(relative_path)
        return "{}"

    def echo(message: str = "") -> str:
        executed.append(message)
        return json.dumps({"ok": True, "echo": message})

    echo_tool = StructuredTool.from_function(func=echo, name="echo", description="echo")
    vision = RecordingVision(
        vision_fn=vision_fn,
        provider_is_vision=True,
        settings=SimpleSettings(),
        client_context=ctx,
        user_content=f"看看 {rel}",
    )
    agent, model = build_vision_agent(
        middleware=[vision],
        tools=[echo_tool],
        rounds=[
            [tc_chunk("echo", {"message": "hi"}, "real1")],
            [AIMessageChunk(content="工具跑完了")],
        ],
    )
    raw = await drive(agent, text=f"看看 {rel}")

    assert executed == ["hi"]
    assert vision_calls == []
    assert custom_frames(raw) == []
    assert model.counters["calls"] == 2
    assert any("tools" in nodes for nodes in update_nodes(raw))
    # 轮次计数仍无条件落盘（第 1 轮记 1），但没触发
    assert vision.seen_rounds == [0, 1]
    assert all("vision_attempted" not in update for update in vision.updates)


@pytest.mark.asyncio
async def test_vision_fallback_round_guard_counts_second_round_unconditionally(tmp_path):
    """朴素守卫的 bug 回归：第一轮真工具、第二轮无调用 → 不得兜底（``model_calls=2``）。

    探针 Q4d 实测朴素实现会 ``model_calls=3``（第二轮被当成首轮）。
    """
    ctx, rel = make_workspace(tmp_path)
    vision_calls: list[str] = []

    def vision_fn(relative_path: str = "") -> str:
        vision_calls.append(relative_path)
        return "{}"

    def echo(message: str = "") -> str:
        return json.dumps({"ok": True, "echo": message})

    echo_tool = StructuredTool.from_function(func=echo, name="echo", description="echo")
    vision = RecordingVision(
        vision_fn=vision_fn,
        provider_is_vision=True,
        settings=SimpleSettings(),
        client_context=ctx,
        user_content=f"看看 {rel}",
    )
    agent, model = build_vision_agent(
        middleware=[vision],
        tools=[echo_tool],
        rounds=[
            [tc_chunk("echo", {"message": "hi"}, "real1")],
            [AIMessageChunk(content="工具跑完了")],
            [AIMessageChunk(content="补充回答")],
        ],
    )
    raw = await drive(agent, text=f"看看 {rel}")

    assert vision.seen_rounds == [0, 1]  # 第二次 after_model 看到的是「已计过 1」
    assert vision.seen_tool_calls == [1, 0]  # 第一轮是真实工具调用，第二轮无调用
    assert vision_calls == []
    assert custom_frames(raw) == []
    assert model.counters["calls"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "no_vision_fn",
        "provider_not_vision",
        "no_image_in_user_content",
        "missing_file",
        "resume",
    ],
)
async def test_vision_fallback_not_triggered_for_each_false_branch(tmp_path, case):
    """五个不触发分支（与 ``test_vision_bootstrap.py`` 四分支 + 路径存在性同源）。"""
    ctx, rel = make_workspace(tmp_path, image=case != "missing_file")
    vision_calls: list[str] = []

    def vision_fn(relative_path: str = "") -> str:
        vision_calls.append(relative_path)
        return "{}"

    kwargs: dict[str, Any] = {
        "vision_fn": vision_fn,
        "provider_is_vision": True,
        "settings": SimpleSettings(),
        "client_context": ctx,
        "user_content": f"看看 {rel}",
    }
    if case == "no_vision_fn":
        kwargs["vision_fn"] = None
    elif case == "provider_not_vision":
        kwargs["provider_is_vision"] = False
    elif case == "no_image_in_user_content":
        kwargs["user_content"] = "没有图片路径"
    elif case == "resume":
        kwargs["is_resume"] = True
    elif case == "missing_file":
        kwargs["user_content"] = "看看 demo.png"

    vision = RecordingVision(**kwargs)
    agent, model = build_vision_agent(middleware=[vision])
    raw = await drive(agent, text=str(kwargs["user_content"]))

    assert vision_calls == []
    assert custom_frames(raw) == []
    assert model.counters["calls"] == 1  # 没有第二次调用
    assert vision.seen_rounds == [0]  # 轮次计数仍无条件落盘


@pytest.mark.asyncio
async def test_vision_fallback_read_failure_becomes_tool_result_not_error_frame(tmp_path):
    """读图失败 → ``工具执行失败: {exc}`` 出现在工具结果里，且**不发** ``error`` 帧。"""
    ctx, rel = make_workspace(tmp_path)

    def boom(relative_path: str = "") -> str:
        raise RuntimeError("磁盘炸了")

    vision = RecordingVision(
        vision_fn=boom,
        provider_is_vision=True,
        settings=SimpleSettings(),
        client_context=ctx,
        user_content=f"看看 {rel}",
    )
    agent, model = build_vision_agent(middleware=[vision])
    raw = await drive(agent, text=f"看看 {rel}")

    frames = custom_frames(raw)
    assert [frame["type"] for frame in frames] == ["tool_start", "tool_result"]
    assert frames[1]["result"] == "工具执行失败: 磁盘炸了"
    assert all(frame["type"] != "error" for frame in frames)
    tools = [m for m in injected_messages(raw) if isinstance(m, ToolMessage)]
    assert len(tools) == 1
    assert tools[0].content == "工具执行失败: 磁盘炸了"
    assert model.counters["calls"] == 2
    # 旧路径的附图分支是 ``if vision_path and provider_is_vision``（``assist_vision.py:96``）：
    # 读失败时结果里没有 ``__vision_image_path__`` 标记 → **不得**追加附图消息。
    assert image_blocks(model.counters["inputs"][1]) == []


@pytest.mark.asyncio
async def test_vision_fallback_does_not_conflict_with_business_middleware(tmp_path):
    """与 ``build_business_middleware`` 共存：占末位、BusinessRound 对注入消息返回 None。"""
    ctx, rel = make_workspace(tmp_path)

    def vision_fn(relative_path: str = "") -> str:
        return vision_result(tmp_path, rel)

    vision = RecordingVision(
        vision_fn=vision_fn,
        provider_is_vision=True,
        settings=SimpleSettings(),
        client_context=ctx,
        user_content=f"看看 {rel}",
    )
    stack = build_business_middleware(max_tool_rounds=2, extra=[vision])
    # 末位 = after_model 最先执行；BusinessRound 仍是 loop_exit_node（factory.py:1664-1665）
    assert stack[-1] is vision
    assert stack[0].name == "BusinessRoundMiddleware"

    agent, model = build_vision_agent(middleware=stack)
    raw = await drive(agent, text=f"看看 {rel}")

    assert model.counters["calls"] == 2
    assert [frame["type"] for frame in custom_frames(raw)] == ["tool_start", "tool_result"]
    assert any(
        "BusinessRoundMiddleware.after_model" in nodes for nodes in update_nodes(raw)
    )
    assert all("tools" not in nodes for nodes in update_nodes(raw))

    # 直接钉住探针 Q4 的观测：BusinessRoundMiddleware.after_model 对整批注入消息返回
    # None（``plan_round`` 对非 AIMessage 的末条返回空计划，round_plan.py:249-255）。
    round_mw = BusinessRoundMiddleware()
    fake_ai = AIMessage(
        content="",
        tool_calls=[
            {
                "name": VISION_TOOL_NAME,
                "args": {"relative_path": rel},
                "id": "lr-vision-fallback-x",
                "type": "tool_call",
            }
        ],
    )
    fake_tool = ToolMessage(
        content="{}", tool_call_id="lr-vision-fallback-x", name=VISION_TOOL_NAME
    )
    assert round_mw.after_model({"messages": [fake_ai, fake_tool]}, None) is None
    # 只给 AI 时它会算出计划（工具本身合法）——说明「Must be ToolsMessage 收尾」是
    # 两种排序都不冲突的**结构性原因**，不是巧合。
    assert round_mw.after_model({"messages": [fake_ai]}, None) is not None


@pytest.mark.asyncio
async def test_vision_fallback_state_guard_prevents_second_injection(tmp_path):
    """幂等：``vision_attempted`` 已置位时不再注入（无守卫会 ``GraphRecursionError``）。"""
    ctx, rel = make_workspace(tmp_path)

    def vision_fn(relative_path: str = "") -> str:
        return vision_result(tmp_path, rel)

    vision = RecordingVision(
        vision_fn=vision_fn,
        provider_is_vision=True,
        settings=SimpleSettings(),
        client_context=ctx,
        user_content=f"看看 {rel}",
    )
    agent, model = build_vision_agent(
        middleware=[vision],
        rounds=[[AIMessageChunk(content="第一轮")]]
        + [[AIMessageChunk(content="继续")] for _ in range(5)],
    )
    raw = await drive(agent, text=f"看看 {rel}")

    assert model.counters["calls"] == 2
    assert len([f for f in custom_frames(raw) if f["type"] == "tool_start"]) == 1
    assert vision.seen_rounds == [0, 1]
    assert vision.updates[1].get("vision_attempted") is None


@pytest.mark.asyncio
async def test_vision_fallback_budget_interaction_is_reported_not_fixed(tmp_path):
    """**记录**探针 Q7 的预算交互：``max_tool_rounds=0`` 时兜底轮撞上收尾轮。

    不修（旧路径没有这个概念），只钉住现状：调用总数仍是 2，
    但 call#2 的输入末尾多出一条「预算已用完」的 ``HumanMessage``
    —— 即兜底**占用了收尾轮**。
    """
    ctx, rel = make_workspace(tmp_path)

    def vision_fn(relative_path: str = "") -> str:
        return vision_result(tmp_path, rel)

    vision = RecordingVision(
        vision_fn=vision_fn,
        provider_is_vision=True,
        settings=SimpleSettings(),
        client_context=ctx,
        user_content=f"看看 {rel}",
    )
    stack = build_business_middleware(max_tool_rounds=0, extra=[vision])
    wrap_up = [m for m in stack if isinstance(m, BudgetWrapUpMiddleware)][0]
    assert wrap_up.wrap_up_at == 2

    agent, model = build_vision_agent(middleware=stack)
    raw = await drive(agent, text=f"看看 {rel}")

    assert model.counters["calls"] == 2
    second_input = model.counters["inputs"][1]
    assert any(
        "工具调用预算已用完" in str(getattr(m, "content", "")) for m in second_input
    )
    assert [frame["type"] for frame in custom_frames(raw)] == ["tool_start", "tool_result"]

    # 对照：max_tool_rounds=1（wrap_up_at=3）不受影响
    vision_b = RecordingVision(
        vision_fn=vision_fn,
        provider_is_vision=True,
        settings=SimpleSettings(),
        client_context=ctx,
        user_content=f"看看 {rel}",
    )
    agent_b, model_b = build_vision_agent(
        middleware=build_business_middleware(max_tool_rounds=1, extra=[vision_b]),
        name="s5a_vision_budget1",
    )
    await drive(agent_b, text=f"看看 {rel}")
    second_b = model_b.counters["inputs"][1]
    assert all(
        "工具调用预算已用完" not in str(getattr(m, "content", "")) for m in second_b
    )


@pytest.mark.asyncio
async def test_vision_fallback_never_runs_before_first_model_call(tmp_path):
    """旧契约：不得在进模型前预加载（没有 ``try_bootstrap``，也不实现 ``before_model``）。"""
    from app.agent.assist.vision_bootstrap import VisionAutoLoader

    assert not hasattr(VisionAutoLoader, "try_bootstrap")
    assert hasattr(VisionAutoLoader, "try_fallback")
    # 只挂 after_model：不实现 before_model / wrap_model_call
    assert VisionFallbackMiddleware.before_model is AgentMiddleware.before_model
    assert VisionFallbackMiddleware.abefore_model is AgentMiddleware.abefore_model
    assert VisionFallbackMiddleware.wrap_model_call is AgentMiddleware.wrap_model_call
    assert VisionFallbackMiddleware.after_model is not AgentMiddleware.after_model
    assert VisionFallbackMiddleware.aafter_model is not AgentMiddleware.aafter_model

    ctx, rel = make_workspace(tmp_path)
    vision_calls: list[str] = []

    def vision_fn(relative_path: str = "") -> str:
        vision_calls.append(relative_path)
        return vision_result(tmp_path, rel)

    vision = RecordingVision(
        vision_fn=vision_fn,
        provider_is_vision=True,
        settings=SimpleSettings(),
        client_context=ctx,
        user_content=f"看看 {rel}",
    )
    agent, model = build_vision_agent(middleware=[vision])
    await drive(agent, text=f"看看 {rel}")
    assert len(vision_calls) == 1  # 只在 after_model 里读过一次
    assert model.counters["calls"] == 2


# ── C. sibling 路径：模型**主动**调用 read_image_for_vision 后的附图 ──────


def vision_read_tool(tmp_path, rel: str, executed: list[str]) -> StructuredTool:
    """真实 ``read_image_for_vision`` 存的桩：结果里带 ``VISION_PATH_MARKER``。

    与候选里该工具的真实行为同形（``workspace_file_reader.py:250`` 把解析出的
    绝对路径放进结果 JSON），因此 ``extract_vision_path_from_tool_result`` 能命中。
    """

    def _read(relative_path: str = "") -> str:
        executed.append(relative_path)
        return vision_result(tmp_path, rel)

    return StructuredTool.from_function(
        func=_read, name=VISION_TOOL_NAME, description="读图"
    )


@pytest.mark.asyncio
async def test_active_vision_tool_call_appends_multimodal_message_after_tool_result(
    tmp_path,
):
    """旧 ``tool_loop.py:339-347``：模型主动调视觉工具 → 工具结果之后追加多模态消息。

    候选落点 ``wrap_tool_call``（返回 ``Command``，``middleware/types.py:677``）。
    断言：真工具恰好执行 1 次、``tools`` 节点照常、第二次调用输入是
    ``[..., ToolMessage(结果), HumanMessage(图)]`` 且图与旧 helper 逐字节相等。
    """
    ctx, rel = make_workspace(tmp_path)
    executed: list[str] = []
    middleware = [
        VisionToolResultMiddleware(provider_is_vision=True, settings=SimpleSettings())
    ]
    agent, model = build_vision_agent(
        middleware=middleware,
        tools=[vision_read_tool(tmp_path, rel, executed), noop_tool()],
        rounds=[
            [tc_chunk(VISION_TOOL_NAME, {"relative_path": rel}, "real-vision-1")],
            [AIMessageChunk(content="看到了")],
        ],
        name="s5a_vision_sibling",
    )
    raw = await drive(agent, text=f"看看 {rel}")

    assert executed == [rel]  # 真工具恰好执行一次（不是伪调用）
    assert model.counters["calls"] == 2
    assert any("tools" in nodes for nodes in update_nodes(raw))  # 走的是真 tools 节点

    second_input = model.counters["inputs"][1]
    human_images = multimodal_messages(second_input)
    assert len(human_images) == 1, [str(m) for m in second_input]
    assert second_input[-1] is human_images[0]
    assert isinstance(second_input[-2], ToolMessage)
    assert second_input[-2].tool_call_id == "real-vision-1"

    old_message = await build_multimodal_user_message(
        VISION_FALLBACK_IMAGE_TEXT,
        image_absolute_path=str(tmp_path / rel),
        max_edge=1280,
        jpeg_quality=85,
    )
    assert human_images[0].content == old_message.content
    # 只追加一次：链上没有第二条附图、也没有重复的 ToolMessage
    assert len(image_blocks(second_input)) == 1
    assert len([m for m in second_input if isinstance(m, ToolMessage)]) == 1


@pytest.mark.asyncio
async def test_active_vision_tool_call_skips_attachment_when_provider_not_vision(
    tmp_path,
):
    """旧守卫 ``if vision_path and provider_is_vision``：provider 不支持视觉时不附图。"""
    ctx, rel = make_workspace(tmp_path)
    executed: list[str] = []
    middleware = [
        VisionToolResultMiddleware(provider_is_vision=False, settings=SimpleSettings())
    ]
    agent, model = build_vision_agent(
        middleware=middleware,
        tools=[vision_read_tool(tmp_path, rel, executed), noop_tool()],
        rounds=[
            [tc_chunk(VISION_TOOL_NAME, {"relative_path": rel}, "real-vision-2")],
            [AIMessageChunk(content="看到了")],
        ],
        name="s5a_vision_sibling_novision",
    )
    await drive(agent, text=f"看看 {rel}")

    assert executed == [rel]
    second_input = model.counters["inputs"][1]
    assert image_blocks(second_input) == []
    assert [m for m in second_input if isinstance(m, ToolMessage)][0].content == (
        vision_result(tmp_path, rel)
    )


@pytest.mark.asyncio
async def test_active_non_vision_tool_does_not_get_an_image_attached(tmp_path):
    """工具名不是 ``read_image_for_vision``（或结果无标记）→ 不附图。"""
    ctx, rel = make_workspace(tmp_path)
    executed: list[str] = []

    def plain(message: str = "") -> str:
        executed.append(message)
        # 故意混入 vision 标记：``extract_vision_path_from_tool_result`` 对
        # 非视觉工具名恒返回 ``None``（``workspace_file_reader.py:322``）。
        return json.dumps(
            {VISION_PATH_MARKER: str(tmp_path / rel), "message": message},
            ensure_ascii=False,
        )

    plain_tool = StructuredTool.from_function(
        func=plain, name="plain_tool", description="plain"
    )
    middleware = [
        VisionToolResultMiddleware(provider_is_vision=True, settings=SimpleSettings())
    ]
    agent, model = build_vision_agent(
        middleware=middleware,
        tools=[plain_tool],
        rounds=[
            [tc_chunk("plain_tool", {"message": "hi"}, "plain-1")],
            [AIMessageChunk(content="完成")],
        ],
        name="s5a_vision_sibling_plain",
    )
    await drive(agent, text=f"看看 {rel}")

    assert executed == ["hi"]
    assert image_blocks(model.counters["inputs"][1]) == []


def test_vision_tool_result_middleware_sync_wrap_tool_call_also_attaches_image(tmp_path):
    """同步版 ``wrap_tool_call``（``invoke`` / ``stream``）同样返回 ``Command`` 带图。"""
    from langgraph.types import Command

    ctx, rel = make_workspace(tmp_path)
    middleware = VisionToolResultMiddleware(
        provider_is_vision=True, settings=SimpleSettings()
    )

    class FakeRequest:
        tool_call = {
            "name": VISION_TOOL_NAME,
            "args": {"relative_path": rel},
            "id": "sync-1",
        }

    def handler(request: Any) -> ToolMessage:
        return ToolMessage(
            content=vision_result(tmp_path, rel),
            tool_call_id="sync-1",
            name=VISION_TOOL_NAME,
        )

    result = middleware.wrap_tool_call(FakeRequest(), handler)
    assert isinstance(result, Command)
    messages = result.update["messages"]
    assert isinstance(messages[0], ToolMessage)
    assert multimodal_messages(messages) == [messages[1]]
    assert messages[1].content[1]["image_url"]["url"].startswith(
        "data:image/jpeg;base64,"
    )


@pytest.mark.asyncio
async def test_active_vision_attachment_survives_business_middleware_stack(tmp_path):
    """与 ``build_business_middleware`` 共存：门禁/重试在外层，附图仍落在工具结果之后。

    ``extra`` 在列表末位 → 本件是**最内层** ``wrap_tool_call``；外层
    ``BusinessRoundMiddleware``（门禁）/``ToolErrorMiddleware``/
    ``ToolRetryMiddleware`` 都直接 ``return handler(request)``
    （``tool_error.py:153``、``tool_retry.py:325``），因此 ``Command`` 原样穿出，
    且真工具仍恰好执行 1 次（``Command`` 不是异常，不触发重试）。
    """
    ctx, rel = make_workspace(tmp_path)
    executed: list[str] = []
    stack = build_business_middleware(
        max_tool_rounds=2,
        extra=[
            VisionToolResultMiddleware(
                provider_is_vision=True, settings=SimpleSettings()
            )
        ],
    )
    assert isinstance(stack[-1], VisionToolResultMiddleware)

    agent, model = build_vision_agent(
        middleware=stack,
        tools=[vision_read_tool(tmp_path, rel, executed), noop_tool()],
        rounds=[
            [tc_chunk(VISION_TOOL_NAME, {"relative_path": rel}, "real-vision-3")],
            [AIMessageChunk(content="看到了")],
        ],
        name="s5a_vision_sibling_stack",
    )
    raw = await drive(agent, text=f"看看 {rel}")

    assert executed == [rel]  # 没有重复执行
    assert model.counters["calls"] == 2
    assert any("tools" in nodes for nodes in update_nodes(raw))
    second_input = model.counters["inputs"][1]
    human_images = multimodal_messages(second_input)
    assert len(human_images) == 1, [str(m) for m in second_input]
    assert second_input[-1] is human_images[0]
    assert len([m for m in second_input if isinstance(m, ToolMessage)]) == 1
