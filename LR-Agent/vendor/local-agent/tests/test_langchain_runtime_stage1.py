"""阶段 1：官方 ``create_agent`` 候选内核（``app.agent.langchain_runtime``）最小测试。

覆盖计划 §5-阶段 1 要求的四件事：

1. **纯文本回答** —— 无工具调用、零真实工具执行、只有一轮模型调用；
2. **一个只读工具轮** —— 工具**恰好执行 1 次**，``tool_call_id`` 与模型的调用对齐，
   且运行上下文经 ``ToolRuntime.context`` 真的到达了工具；
3. **一个客户端（异步风格）工具轮** —— Agent 在工具节点执行前停下并暴露待执行调用，
   **后端零执行**；
4. **工具清单与 schema 原样透传** —— 用 ``app.agent.tools.registry`` 真实产出的
   ``list[StructuredTool]`` 构建，断言官方 Agent 绑定并交给 ``tools`` 节点的是
   同一批对象、``tool_call_schema`` 逐字段相同（不引入新的工具抽象）。

另含两个流入口自身的契约用例（早停真正抛弃底层 ``astream``、拒绝缺 ``messages`` 的流模式）。

全部离线、确定性：无网络、无真实模型、无 YOLO、无 Docker、无磁盘写入。
假模型实现 ``_generate``（同步）与 ``_astream``（块级流）；
不使用 ``tests/test_agent_baseline_contract.py`` 里那种「鸭子类型 + 手写 bind_tools」
的假对象，因为 ``create_agent`` 的 ``bind_tools`` 默认实现会抛 ``NotImplementedError``。

两条实现事实（实测，避免误判）：

- ``create_agent`` 是在**模型节点执行时**才 ``bind_tools``（``langchain/agents/factory.py:1432``），
  所以「绑定给模型的工具清单」必须在真实跑过一轮图之后才能观测；
- ``create_agent`` 会 ``bind_tools`` 出一个新的模型对象，因此假模型的可观测状态
  （调用轮数、绑定工具名）必须放在跨浅拷贝共享的 ``counters`` 里。

警告抑制说明：当某个工具声明了 ``runtime: ToolRuntime`` 形参时，官方 1.4.2 在
``messages`` 流模式下会对该工具调用发出 pydantic 序列化告警
（``PydanticSerializationUnexpectedValue ... field_name='context'``，
来自 ``langgraph/prebuilt/tool_node.py`` 的 runtime 注入路径）。它是**外观性**的：
工具只执行一次、结果正确。故在本文件按类别忽略该告警，而不是掩盖失败。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import pytest

# baseline 环境（只有 langchain-core，无 langchain/langgraph）应整体 skip 而不是 collect error
pytest.importorskip("langchain")

from langchain.tools import ToolRuntime  # noqa: E402
from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import (  # noqa: E402
    AIMessage,
    AIMessageChunk,
    HumanMessage,
)
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
)
from langchain_core.tools import StructuredTool  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from app.agent.langchain_runtime import (  # noqa: E402
    STREAM_MODES,
    STREAM_VERSION,
    AgentContext,
    PendingToolCall,
    build_langchain_agent,
    stream_agent_raw_events,
)

pytestmark = pytest.mark.filterwarnings(
    "ignore:Pydantic serializer warnings:UserWarning"
)


# ── 脚本化假模型（同步 + 块级流式） ─────────────────────────────────────


class ScriptedChat(BaseChatModel):
    """按轮次返回预设 chunk 的假聊天模型（离线、确定性）。

    - ``rounds``：第 *i* 次模型调用返回的 ``AIMessageChunk`` 列表；
    - ``counters``：跨 pydantic 浅拷贝共享的计数器
      （``create_agent`` 会 ``bind_tools`` 出一个新模型对象，
      只有共享容器才能观测到真实的调用轮数）；
    - ``bound_tool_names``：``create_agent`` 在模型上绑定了哪些工具；
    - ``_generate`` 供线程池里的同步执行路径使用，``_astream`` 提供真正的块级流事件。
    """

    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)
    seen_messages: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "lr-agent-scripted-chat"

    @property
    def bound_tool_names(self) -> list[str]:
        """``create_agent`` 在模型上绑定的工具名（跨 bind_tools 拷贝可见）。"""
        return list(self.counters.get("bound_tool_names", []))

    @property
    def invoke_calls(self) -> int:
        """真实模型调用轮数（跨 bind_tools 拷贝累计）。"""
        return int(self.counters.get("invoke_calls", 0))

    @property
    def astream_calls(self) -> int:
        return int(self.counters.get("astream_calls", 0))

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [
            getattr(t, "name", str(t)) for t in tools
        ]
        return self

    def _round(self) -> list[AIMessageChunk]:
        index = int(self.counters.get("invoke_calls", 0))
        self.counters["invoke_calls"] = index + 1
        return self.rounds[index] if index < len(self.rounds) else []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        chunks = self._round()
        merged: AIMessageChunk | None = None
        for chunk in chunks:
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
        self.seen_messages.append(list(messages))
        return self._generate(messages)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen_messages.append(list(messages))
        self.counters["astream_calls"] = int(self.counters.get("astream_calls", 0)) + 1
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


def tool_call_chunk(name: str, args: dict[str, Any], call_id: str) -> AIMessageChunk:
    """构造一个「模型发起工具调用」的流式分片。"""
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


# ── 事件读取辅助 ───────────────────────────────────────────────────────


def messages_events(events: list) -> list[Any]:
    """取出 ``messages`` 模式的事件负载（``data = (message, metadata)``）。"""
    return [
        event["data"][0]
        for event in events
        if isinstance(event, dict) and event.get("type") == "messages"
    ]


def updates_events(events: list) -> list[Any]:
    """取出 ``updates`` 模式的事件负载（``data = {node: {...}}``）。"""
    return [
        event["data"]
        for event in events
        if isinstance(event, dict) and event.get("type") == "updates"
    ]


def terminal_text(events: list) -> str:
    """从 ``updates`` 事件里拼出模型产出的文本（仅用于断言）。"""
    text = ""
    for data in updates_events(events):
        for update in data.values():
            for message in update.get("messages", []):
                if getattr(message, "type", None) == "ai":
                    content = getattr(message, "content", "")
                    if isinstance(content, str) and content:
                        text = content
    return text


async def drive(agent, context: AgentContext, text: str = "执行任务"):
    """消费 :func:`stream_agent_raw_events`，返回 ``(事件列表, 客户端待执行调用)``。"""
    pending: list[PendingToolCall] = []
    events = [
        event
        async for event in stream_agent_raw_events(
            agent,
            [HumanMessage(content=text)],
            context=context,
            pending_calls_out=pending,
        )
    ]
    return events, pending


# ── 1. 纯文本回答 ──────────────────────────────────────────────────────


class TestPlainTextAnswer:
    """阶段 1 门槛：纯文本回合零工具执行、单轮模型调用、含文本流事件。"""

    async def test_plain_text_answer_executes_no_tool(self):
        executions: list[dict] = []

        def read_stub(relative_path: str = "") -> str:
            executions.append({"relative_path": relative_path})
            return json.dumps({"ok": True, "summary": relative_path}, ensure_ascii=False)

        tools = [
            StructuredTool.from_function(
                func=read_stub, name="read_workspace_file", description="读工作区文件"
            )
        ]
        model = ScriptedChat(
            rounds=[[AIMessageChunk(content="你好，我可以帮你整理工作区。")]]
        )
        agent = build_langchain_agent(model, tools)

        events, pending = await drive(
            agent, AgentContext(mode="assist", workspace_root="/w"), text="你好"
        )

        # 事件形状：官方 v2 dict 事件，含 messages 与 updates 两种
        assert {event["type"] for event in events} == {"messages", "updates"}
        assert all(event["ns"] == () for event in events)
        assert terminal_text(events) == "你好，我可以帮你整理工作区。"
        assert [m.content for m in messages_events(events) if m.content] == [
            "你好，我可以帮你整理工作区。"
        ]

        # 零工具执行 + 只有一轮模型调用（未进入第二轮）
        assert executions == []
        assert model.invoke_calls == 1
        # 工具清单进了图，但没有被调用
        assert model.bound_tool_names == ["read_workspace_file"]
        assert pending == []


# ── 2. 只读工具轮 ──────────────────────────────────────────────────────


class TestReadOnlyToolRound:
    """阶段 1 门槛：只读工具恰好执行 1 次、``tool_call_id`` 对齐、上下文送达工具。"""

    async def test_tool_executes_exactly_once_and_call_id_matches(self):
        executions: list[dict] = []
        runtime_seen: list[Any] = []

        def read_stub(relative_path: str = "", runtime: ToolRuntime = None) -> str:
            executions.append({"relative_path": relative_path})
            runtime_seen.append(runtime)
            mode = getattr(getattr(runtime, "context", None), "mode", None)
            return json.dumps(
                {"ok": True, "tool": "read_workspace_file", "summary": f"{relative_path}@{mode}"},
                ensure_ascii=False,
            )

        tools = [
            StructuredTool.from_function(
                func=read_stub, name="read_workspace_file", description="读工作区文件"
            )
        ]
        model = ScriptedChat(
            rounds=[
                [tool_call_chunk("read_workspace_file", {"relative_path": "a.md"}, "call_1")],
                [AIMessageChunk(content="读完了。")],
            ]
        )
        agent = build_langchain_agent(model, tools)

        events, pending = await drive(agent, AgentContext(mode="assist"), text="读 a.md")

        # 工具恰好执行一次，参数来自模型的调用
        assert executions == [{"relative_path": "a.md"}]
        assert model.invoke_calls == 2
        assert pending == []

        # ToolMessage 与模型的 tool_call_id 对齐（模型调用 → 工具结果）
        model_calls = [
            call
            for message in messages_events(events)
            for call in (getattr(message, "tool_calls", None) or [])
        ]
        tool_messages = [
            message
            for message in messages_events(events)
            if getattr(message, "type", None) == "tool"
        ]
        assert [(call["name"], call["id"]) for call in model_calls] == [
            ("read_workspace_file", "call_1")
        ]
        assert [(m.name, m.tool_call_id) for m in tool_messages] == [
            ("read_workspace_file", "call_1")
        ]
        assert json.loads(tool_messages[0].content)["summary"] == "a.md@assist"

        # 运行上下文确实经 ToolRuntime 进入工具（不是全局变量、不是 Store）
        assert len(runtime_seen) == 1
        assert isinstance(runtime_seen[0], ToolRuntime)
        assert runtime_seen[0].tool_call_id == "call_1"
        assert isinstance(runtime_seen[0].context, AgentContext)
        assert runtime_seen[0].context.mode == "assist"

        assert terminal_text(events) == "读完了。"

    async def test_tool_schema_is_not_polluted_by_injected_runtime_arg(self):
        """``runtime`` 形参不得出现在模型可见的 schema 里（否则模型会自己编一个 context）。"""

        def read_stub(relative_path: str = "", runtime: ToolRuntime = None) -> str:
            return "ok"

        tool = StructuredTool.from_function(
            func=read_stub, name="read_workspace_file", description="读工作区文件"
        )
        schema = tool.tool_call_schema.model_json_schema()
        assert set(schema["properties"]) == {"relative_path"}


# ── 3. 客户端（异步风格）工具轮 ────────────────────────────────────────


class TestClientToolRound:
    """阶段 1 门槛：客户端工具零后端执行，Agent 在执行前停下并暴露待执行调用。"""

    async def test_client_tool_call_is_surfaced_without_server_execution(self):
        server_executions: list[dict] = []
        client_executions: list[dict] = []

        def read_stub(relative_path: str = "") -> str:
            server_executions.append({"relative_path": relative_path})
            return json.dumps({"ok": True, "summary": relative_path}, ensure_ascii=False)

        def auto_annotate_stub(user_request: str, paths: list[str] | None = None) -> str:
            # registry 里的客户端工具存根本不该被本地调用（见 registry._client_tool_stub）
            client_executions.append({"user_request": user_request})
            return "此工具应由前端执行，本地调用不应发生。"

        server_tools = [
            StructuredTool.from_function(
                func=read_stub, name="read_workspace_file", description="读工作区文件"
            )
        ]
        client_tools = [
            StructuredTool.from_function(
                func=auto_annotate_stub,
                name="auto_annotate",
                description="由前端执行的自动标注工具（schema 存根）",
            )
        ]
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk(
                        "auto_annotate", {"user_request": "标注全部图片"}, "client_1"
                    )
                ],
                [AIMessageChunk(content="这一轮不应该发生。")],
            ]
        )
        agent = build_langchain_agent(model, server_tools)
        context = AgentContext(
            mode="annotation", client_tool_names=frozenset({"auto_annotate"})
        )

        events, pending = await drive(agent, context, text="标注全部图片")

        # 1) Agent 停下：只发生一次模型调用（没有第二轮推理）
        assert model.invoke_calls == 1

        # 2) 待执行调用被暴露，载荷与阶段 4 的 tool_pending 素材对齐
        assert len(pending) == 1
        assert isinstance(pending[0], PendingToolCall)
        assert pending[0]["type"] == "client_tool_pending"
        assert pending[0]["name"] == "auto_annotate"
        assert pending[0]["tool_call_id"] == "client_1"
        assert pending[0]["arguments"] == {"user_request": "标注全部图片"}

        # 3) 后端零执行：服务端工具与客户端工具都没有被调用
        assert server_executions == []
        assert client_executions == []

        # 4) 没有任何工具节点更新被产出（即 tools 节点没有跑）
        assert all(set(data) == {"model"} for data in updates_events(events))
        # 5) 也没有「工具结果 / 无效工具」之类的 ToolMessage 混进事件流
        assert [m for m in messages_events(events) if getattr(m, "type", None) == "tool"] == []

    async def test_early_stop_works_when_client_tool_is_absent_from_agent_tools(self):
        """早停是第一道防线：客户端工具**不在** Agent 工具清单里，调用仍被拦下并暴露。

        这里刻意把客户端工具的存根**不**交给 ``build_langchain_agent``，
        模拟最严格的部署形态（后端结构上无法执行它）。若没有早停，图会走到
        ``tools`` 节点并产出 "not a valid tool" 的 ``ToolMessage``（无副作用的第二道防线，
        但会破坏「在工具执行前停下」的语义）。
        """

        def read_stub(relative_path: str = "") -> str:
            return json.dumps({"ok": True, "summary": relative_path}, ensure_ascii=False)

        server_tools = [
            StructuredTool.from_function(
                func=read_stub, name="read_workspace_file", description="读工作区文件"
            )
        ]
        model = ScriptedChat(
            rounds=[
                [tool_call_chunk("auto_annotate", {"user_request": "标一下"}, "client_9")],
                [AIMessageChunk(content="这一轮不应该发生。")],
            ]
        )
        agent = build_langchain_agent(model, server_tools)

        events, pending = await drive(
            agent,
            AgentContext(mode="annotation", client_tool_names=frozenset({"auto_annotate"})),
            text="标一下",
        )

        # Agent 的工具清单里**没有**客户端工具（后端结构上无法执行它），
        # 但调用依然被早停拦下并原样暴露
        assert model.bound_tool_names == ["read_workspace_file"]
        assert model.invoke_calls == 1
        assert [call["name"] for call in pending] == ["auto_annotate"]
        assert all(set(data) == {"model"} for data in updates_events(events))
        assert [m for m in messages_events(events) if getattr(m, "type", None) == "tool"] == []


# ── 4. 真实工具清单 / schema 原样透传 ──────────────────────────────────


def _real_tools():
    from app.agent.tools.registry import build_tools_p1
    from app.core.config import Settings
    from app.models.user import User
    from app.schemas.agent import ClientContextInput

    user = User(
        id=uuid.uuid4(),
        email="test@example.com",
        email_verified=True,
        username="tester",
        display_name="Tester",
        password_hash="x",
        is_active=True,
    )
    settings = Settings(
        _env_file=None,
        SECRET_KEY="stage1-test-secret",
        POSTGRES_PASSWORD="test",
        DATABASE_URL="postgresql+asyncpg://lr_agent:test@localhost:5432/lr_agent",
        REDIS_PASSWORD="test",
        REDIS_URL="redis://:test@localhost:6379/0",
    )
    client_context = ClientContextInput(workspace_root="/w", work_mode="annotation")
    return build_tools_p1(user, client_context, settings=settings)


class TestRegistryToolInventory:
    """阶段 1 门槛：消费现有 registry 输出，schema/序列化逐字段一致，无新工具抽象。

    注意 ``create_agent`` 是在**模型节点执行时**才调用 ``bind_tools``
    （``langchain/agents/factory.py:1432`` 的 ``_get_bound_model``），
    因此这里必须先真的跑一轮图，才能观测到「绑定给模型的工具清单」。
    """

    async def test_agent_binds_the_registry_inventory_unchanged(self):
        tools = _real_tools()
        assert tools, "registry 应产出非空工具清单"
        before = {
            tool.name: json.dumps(tool.tool_call_schema.model_json_schema(), sort_keys=True)
            for tool in tools
        }

        model = ScriptedChat(rounds=[[AIMessageChunk(content="ok")]])
        agent = build_langchain_agent(model, tools)
        events, pending = await drive(agent, AgentContext(mode="annotation"))

        # 官方 Agent 在模型上绑定的正是同一批工具（同名、同序）
        assert model.bound_tool_names == [tool.name for tool in tools]
        assert len(set(model.bound_tool_names)) == len(tools)
        assert pending == []

        # 构建前后 schema 逐字段相同（schema 原样透传，未被包装/改写）
        after = {
            tool.name: json.dumps(tool.tool_call_schema.model_json_schema(), sort_keys=True)
            for tool in tools
        }
        assert after == before

        # 对照现有迁移契约测试的约定：写工具仍在绑定清单里（阶段 0 §3-9）
        assert "write_workspace_file" in model.bound_tool_names
        assert terminal_text(events) == "ok"

    async def test_builder_does_not_add_extra_tools(self):
        tools = _real_tools()
        wanted = {"get_lr_agent_help", "read_workspace_file", "auto_annotate", "explore_readonly"}
        assert wanted <= {tool.name for tool in tools}

        model = ScriptedChat(rounds=[[AIMessageChunk(content="ok")]])
        agent = build_langchain_agent(model, tools)
        await drive(agent, AgentContext(mode="annotation"))

        # 既不多也不少：没有 middleware 注入的额外工具、没有结构化输出工具
        assert set(model.bound_tool_names) == {tool.name for tool in tools}


# ── 元信息：流模式常量与阶段 4 契约 ────────────────────────────────────


class TestStreamPlumbing:
    """流入口自身的契约：早停必须真正抛弃底层 astream（不留下后台工具执行）。"""

    async def test_early_stop_closes_the_underlying_agent_stream(self):
        """早停后底层生成器被 ``aclose()``，不会再推进（阶段 4 备忘 §7 的硬要求）。"""

        class FakeGraph:
            """最小 astream 替身：记录被推进的次数，并在推进后永久挂起。"""

            def __init__(self) -> None:
                self.pulls = 0
                self.closed = False

            async def astream(self, _input, **_kwargs):
                try:
                    while True:
                        self.pulls += 1
                        call = {
                            "name": "auto_annotate",
                            "args": {"user_request": "x"},
                            "id": "c9",
                            "type": "tool_call",
                        }
                        yield {
                            "type": "messages",
                            "ns": (),
                            "data": (
                                AIMessage(content="", tool_calls=[call]),
                                {"langgraph_node": "model"},
                            ),
                        }
                        await asyncio.sleep(3600)  # 若未被取消，这里永远不返回
                finally:
                    self.closed = True

        graph = FakeGraph()
        pending: list[PendingToolCall] = []
        consumed = 0
        async for _event in stream_agent_raw_events(
            graph,
            [HumanMessage(content="标一下")],
            context=AgentContext(client_tool_names=frozenset({"auto_annotate"})),
            pending_calls_out=pending,
        ):
            consumed += 1

        assert consumed == 1
        assert [call["name"] for call in pending] == ["auto_annotate"]
        # 底层生成器被关闭，且没有第二次被推进 → 不存在被弃置却仍在跑的工具任务
        assert graph.pulls == 1
        assert graph.closed is True

    async def test_rejects_stream_modes_without_messages(self):
        class NoOpGraph:
            async def astream(self, _input, **_kwargs):
                yield {"type": "updates", "ns": (), "data": {}}

        with pytest.raises(ValueError, match="messages"):
            async for _ in stream_agent_raw_events(
                NoOpGraph(), [HumanMessage(content="x")], stream_modes=("updates",)
            ):
                pass


def test_stream_contract_constants():
    assert STREAM_MODES == ("messages", "updates")
    assert STREAM_VERSION == "v2"
    assert issubclass(PendingToolCall, dict)
    assert issubclass(AgentContext, BaseModel)
