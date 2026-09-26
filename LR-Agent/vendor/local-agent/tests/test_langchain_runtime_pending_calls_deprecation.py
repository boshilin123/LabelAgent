"""阶段 8 收尾 F3：``pending_calls_out`` 的**弃用钉子**（钉住近似语义，指向权威来源）。

## 本文件存在的理由

阶段 5 §6-4 / 阶段 7 §7-1 留下的遗留项是「``pending_calls_out`` 未接线」。阶段 8 收尾
（2026-09-23）判定为**弃用**而不是接线，理由有三条，全部由本文件钉住：

1. **无生产消费者**：候选入口 ``entry.py`` 不传该参数；适配器
   ``sse_adapter.stream_agent_events`` 不读它——权威的「本轮挂起集合」是阶段 2/3 的
   ``BusinessRoundMiddleware.after_model`` 写进 state 的 ``round_plan.deferred``，
   适配器经 ``_resolve_round_plan(updates)`` 直接读，与本参数无关。
2. **构成不同**：``pending_calls_out`` 是**按客户端工具名的近似**——它记入
   「模型发起了、id 不在输入消息里」的全部调用，**包括后端真要执行的 SYNC 调用**；
   ``round_plan.deferred`` 只含**合并后存活**的 ASYNC 挂起项，抑制项在
   ``round_plan.suppressed``、执行项在 ``round_plan.execute_now``。
3. **不能接线（时序）**：该参数在 ``stream_agent_raw_events`` 的 ``finally`` 里、
   **流结束之后**才回填；而 ``tool_pending`` 帧是**流中**由适配器的轮末发出的。
   改成权威集合也无法供任何真实消费者使用，反而会改动
   ``tests/test_langchain_runtime_stage{1,3}.py`` 中已冻结的近似断言（禁改）。

因此：**保留近似语义不变**，在 ``runtime.py`` / ``resume.py`` / ``sse_adapter.py``
写弃用声明，并用本文件把「它是什么、它不是什么、权威在哪里」钉死。

依赖 ``langchain``：``app.agent.langchain_runtime.runtime`` 在模块顶部 import
``langchain.agents``。baseline 环境（无 ``langchain``）整模块 skip——这是既有约定
（阶段 1-8 的候选测试同款守卫）。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import pytest

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
from pydantic import Field, create_model  # noqa: E402

from app.agent.langchain_runtime import AgentContext  # noqa: E402
from app.agent.langchain_runtime.middleware import (  # noqa: E402
    build_business_middleware,
)
from app.agent.langchain_runtime.round_plan import RoundPlan  # noqa: E402
from app.agent.langchain_runtime.runtime import (  # noqa: E402
    PendingToolCall,
    build_langchain_agent,
    stream_agent_raw_events,
)

pytestmark = pytest.mark.filterwarnings(
    "ignore:Pydantic serializer warnings:UserWarning"
)

CLIENT_TOOLS = frozenset({"auto_annotate"})
"""只把 ``auto_annotate`` 当客户端工具（与 ``CLIENT_TOOL_NAMES`` 真相源一致）。"""


# ── 假图：只驱动 ``stream_agent_raw_events``，不依赖 langgraph ──────────


class FakeClientToolGraph:
    """最小 ``astream`` 替身：一轮模型消息（含两个调用）+ 一个 ``updates``。

    ``updates`` 里刻意放一个 **非** ``RoundPlan`` 的同名字段：用来证明
    ``pending_calls_out`` 的来源是**模型消息 + 客户端工具名**，
    而不是 state 里的计划对象（旧实现只扫 ``messages`` 分片）。
    """

    def __init__(self) -> None:
        self.pulls = 0

    async def astream(self, _input: Any, **_kwargs: Any):
        self.pulls += 1
        yield {
            "type": "messages",
            "ns": (),
            "data": (
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "auto_annotate",
                            "args": {"paths": ["data/1.jpg"]},
                            "id": "p1",
                            "type": "tool_call",
                        },
                        {
                            "name": "auto_annotate",
                            "args": {"paths": ["data/2.jpg"]},
                            "id": "p2",
                            "type": "tool_call",
                        },
                    ],
                ),
                {"langgraph_node": "model"},
            ),
        }
        yield {
            "type": "updates",
            "ns": (),
            "data": {"model": {"round_plan": {"deferred": "not-a-RoundPlan"}}},
        }

    async def aclose(self) -> None:
        return None


# ── 业务路径用的脚本化模型与工具桩（与阶段 3 同形，就地最小复刻）──────


class ScriptedChat(BaseChatModel):
    """按轮次返回预设 ``AIMessageChunk`` 的假聊天模型（离线、确定性）。"""

    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)

    @property
    def _llm_type(self) -> str:
        return "lr-agent-scripted-pending-pin"

    @property
    def invoke_calls(self) -> int:
        return int(self.counters.get("invoke_calls", 0))

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        return self

    def _round(self) -> list[AIMessageChunk]:
        index = int(self.counters.get("invoke_calls", 0))
        self.counters["invoke_calls"] = index + 1
        return self.rounds[index] if index < len(self.rounds) else []

    def _merge(self) -> AIMessageChunk | None:
        merged: AIMessageChunk | None = None
        for chunk in self._round():
            merged = chunk if merged is None else merged + chunk
        return merged

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        merged = self._merge()
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="" if merged is None else merged.content,
                        tool_calls=[] if merged is None else list(merged.tool_calls or []),
                    )
                )
            ]
        )

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


def tool_call_chunk(name: str, args: dict[str, Any], call_id: str) -> AIMessageChunk:
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


_JSON_TYPE_TO_PY: dict[str, Any] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
}


def make_tool(specs: Mapping[str, Mapping[str, Any]]):
    """造真 ``StructuredTool`` 并记录真实执行次数（执行次数 = 列表长度）。"""
    calls: dict[str, list[dict[str, Any]]] = {}
    tools: list[StructuredTool] = []
    for name, spec in specs.items():
        props = dict(spec.get("properties") or {})
        schema = create_model(
            f"{name}_args",
            **{
                prop: (_JSON_TYPE_TO_PY.get(cfg.get("type", "string"), Any), ...)
                for prop, cfg in props.items()
            },
        )

        def _build(tool_name=name):
            def _impl(**kwargs: Any) -> str:
                calls.setdefault(tool_name, []).append(dict(kwargs))
                return json.dumps(
                    {"ok": True, "tool": tool_name, "status": "ok", "summary": "stub"},
                    ensure_ascii=False,
                )

            return _impl

        tools.append(
            StructuredTool.from_function(
                func=_build(),
                name=name,
                description=f"stub {name}",
                args_schema=schema,
            )
        )
    return tools, calls


def _update_round_plans(events: list[Any]) -> list[RoundPlan]:
    plans: list[RoundPlan] = []
    for event in events:
        if not (isinstance(event, dict) and event.get("type") == "updates"):
            continue
        data = event.get("data")
        if not isinstance(data, Mapping):
            continue
        for update in data.values():
            plan = update.get("round_plan") if isinstance(update, Mapping) else None
            if isinstance(plan, RoundPlan):
                plans.append(plan)
    return plans


# ── 钉子 1 + 3：近似语义 = 按工具名 + 流结束后才回填 ────────────────────


class TestPendingCallsOutIsANameBasedApproximation:
    """``pending_calls_out`` = 「模型发起的客户端工具名」近似，且**流结束后**才有值。"""

    async def test_records_by_client_tool_name_and_excludes_answered_ids(self):
        """按 ``context.client_tool_names`` 判定、排除输入里已有 ``ToolMessage`` 的 id。"""
        graph = FakeClientToolGraph()
        messages = [
            HumanMessage(content="标注"),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "auto_annotate",
                        "args": {"paths": ["data/1.jpg"]},
                        "id": "p1",
                        "type": "tool_call",
                    }
                ],
            ),
            ToolMessage(content="{}", tool_call_id="p1"),
        ]
        pending: list[PendingToolCall] = []
        consumed = [
            event
            async for event in stream_agent_raw_events(
                graph,
                messages,
                context=AgentContext(client_tool_names=CLIENT_TOOLS),
                pending_calls_out=pending,
            )
        ]

        assert consumed, "事件必须照常产出"
        # 近似口径：p1 已在输入消息里被回答 ⇒ 不再当作待执行；p2 记入。
        assert [call["tool_call_id"] for call in pending] == ["p2"]
        assert isinstance(pending[0], PendingToolCall)
        assert pending[0]["type"] == "client_tool_pending"
        assert pending[0]["name"] == "auto_annotate"
        assert pending[0]["arguments"] == {"paths": ["data/2.jpg"]}

    async def test_the_out_parameter_is_only_filled_after_the_stream_ends(self):
        """**时序钉子**：迭代过程中恒为空，``finally`` 之后才有值。

        这正是「不能接线」的根据：``tool_pending`` 帧由适配器在**流中**发出，
        一个流结束才回填的 out-parameter 无论装什么都赶不上那些帧。
        """
        graph = FakeClientToolGraph()
        pending: list[PendingToolCall] = []
        sizes_during_iteration: list[int] = []
        async for _event in stream_agent_raw_events(
            graph,
            [HumanMessage(content="标注")],
            context=AgentContext(client_tool_names=CLIENT_TOOLS),
            pending_calls_out=pending,
        ):
            sizes_during_iteration.append(len(pending))

        assert sizes_during_iteration and set(sizes_during_iteration) == {0}
        assert len(pending) == 2  # 流结束后才回填

    async def test_a_non_round_plan_payload_does_not_leak_into_the_out_parameter(self):
        """``updates`` 里同名字段（非 ``RoundPlan``）不影响本参数 —— 来源是 messages 流。"""
        graph = FakeClientToolGraph()
        pending: list[PendingToolCall] = []
        async for _event in stream_agent_raw_events(
            graph,
            [HumanMessage(content="标注")],
            context=AgentContext(client_tool_names=CLIENT_TOOLS),
            pending_calls_out=pending,
        ):
            pass

        assert all(call["type"] == "client_tool_pending" for call in pending)
        assert [call["tool_call_id"] for call in pending] == ["p1", "p2"]


# ── 钉子 2：与权威集合 ``round_plan.deferred`` 的构成差异 ───────────────


class TestAuthoritativeDeferredDiffersInComposition:
    """同一轮里 ``pending_calls_out`` 与 ``round_plan.deferred`` **不相等**。"""

    async def test_coalesced_calls_keep_every_id_in_pending_but_only_the_survivor_is_deferred(
        self,
    ):
        """同轮两个 ``auto_annotate``：近似集合留 **2 个 id**，权威集合只有**合并后的存活者**。

        这是两份集合构成差异最有代表性的一例（阶段 3 §「合并/去重」）：被 ``coalesced``
        抑制的那一条在 ``round_plan.suppressed`` 里，**不是**挂起项，但
        ``pending_calls_out`` 按工具名照记。
        """
        tools, calls = make_tool(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}}
                },
                "auto_annotate": {
                    "properties": {
                        "paths": {"type": "array"},
                        "all_files": {"type": "boolean"},
                    }
                },
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk("read_workspace_file", {"relative_path": "a.md"}, "r1"),
                    tool_call_chunk(
                        "auto_annotate",
                        {"paths": ["1.jpg"], "all_files": False},
                        "c1",
                    ),
                    tool_call_chunk(
                        "auto_annotate",
                        {"paths": ["2.jpg"], "all_files": True},
                        "c2",
                    ),
                ],
                [AIMessageChunk(content="读完了，标注交给客户端。")],
            ]
        )
        agent = build_langchain_agent(
            model,
            tools,
            middleware=build_business_middleware(max_tool_rounds=5),
            name="lr_agent_candidate_pending_pin",
        )
        pending: list[PendingToolCall] = []
        events = [
            event
            async for event in stream_agent_raw_events(
                agent,
                [HumanMessage(content="读 a.md 并标注 1.jpg、2.jpg")],
                context=AgentContext(
                    mode="annotation", client_tool_names=CLIENT_TOOLS
                ),
                pending_calls_out=pending,
            )
        ]

        # SYNC 调用真的执行了；它不是客户端工具，故不记入近似集合（另一种偏差）。
        assert calls.get("read_workspace_file") == [{"relative_path": "a.md"}]
        # 近似集合：按客户端工具名记下**两条**原始调用（含将被合并掉的那条）。
        assert [call["tool_call_id"] for call in pending] == ["c1", "c2"]

        plans = [plan for plan in _update_round_plans(events) if plan.calls]
        assert plans, "业务件必须写出 round_plan（权威来源）"
        plan = plans[0]
        assert [call.tool_call_id for call in plan.execute_now] == ["r1"]
        # 权威集合：只有合并后的存活者 c1（合并参数 = 两条 paths 的并集）。
        assert [call.tool_call_id for call in plan.deferred] == ["c1"]
        assert [call.tool_call_id for call in plan.suppressed] == ["c2"]
        assert plan.deferred[0].arguments["paths"] == ["1.jpg", "2.jpg"]

        pending_ids = [call["tool_call_id"] for call in pending]
        deferred_ids = [call.tool_call_id for call in plan.deferred]
        assert pending_ids != deferred_ids, "近似集合与权威集合的构成不同"
        assert set(deferred_ids) < set(pending_ids), "权威集合是近似集合的真子集（本场景）"

    async def test_without_a_business_middleware_there_is_no_authoritative_set(self):
        """阶段 1 兼容路径（无 ``after_model`` 业务件）**没有** ``round_plan``。

        此时 ``pending_calls_out`` 是唯一可得的记录 —— 它仍有值，而
        ``round_plan.deferred`` 根本不存在。这解释了为什么不能把本参数
        重定义为「权威集合」：那会让这条路径**丢失全部信息**。
        """
        tools, calls = make_tool(
            {"auto_annotate": {"properties": {"paths": {"type": "array"}}}}
        )
        model = ScriptedChat(
            rounds=[[tool_call_chunk("auto_annotate", {"paths": ["data/1.jpg"]}, "p1")]]
        )
        agent = build_langchain_agent(model, tools)  # 无 middleware
        pending: list[PendingToolCall] = []
        events = [
            event
            async for event in stream_agent_raw_events(
                agent,
                [HumanMessage(content="标注 data/1.jpg")],
                context=AgentContext(
                    mode="annotation", client_tool_names=CLIENT_TOOLS
                ),
                pending_calls_out=pending,
            )
        ]

        assert [call["tool_call_id"] for call in pending] == ["p1"]
        # 早停生效（无业务件 + client_tool_names 非空）：客户端工具后端零执行。
        assert calls.get("auto_annotate") is None
        assert _update_round_plans(events) == []
