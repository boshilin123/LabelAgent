"""阶段 5 探针 2（一次性、throwaway）：``after_model`` 注入「合成 AIMessage + ToolMessage」能否回跳 model。

回答阶段 5 备忘 §3 的 inferred 假设（``docs/阶段5-MCP与子代理与视觉设计备忘.md:52-56``）与
风险 2/4（``:82,84``）。框架支点：``langchain/agents/factory.py:1950-1957``（pending 过滤）、
``:1970-1972``（"injection of artificial tool messages. Jump to the model node"）。

Q1  注入合成 AIMessage（带伪 tool_call id）+ 匹配 ToolMessage，是否真的产生**第二次模型调用**？计数。
Q2  能工作的**精确消息形状**：顺序 / id / tool_calls 结构 / ToolMessage.status / name。
    （含 3 个负面对照：只注 ToolMessage、顺序颠倒、伪 id 与 ToolMessage 不匹配。）
Q3  第二调用**仍无 tool call** 时会不会无限循环？（有 state 守卫 / 无守卫两种）
Q4  与真实阶段 2 栈 ``build_business_middleware`` 的相互作用：``BusinessRoundMiddleware.after_model``
    会不会把合成调用当成真实 round plan 去合批/门禁？两种排序都测。
Q5  面向 SSE 的 ``updates`` 流长什么样（节点键 / state 字段），适配器如何区分
    「合成视觉轮」与「正常工具轮」？
附送 Q6：``after_model`` 的 middleware ``runtime.stream_writer`` 是否可用、自定义帧落在何处。

运行（工作目录 ``LR-Agent\\vendor\\local-agent``）：
    ..\\..\\..\\.venvs\\langchain-migration\\Scripts\\python.exe experiments\\probe_stage5_after_model_vision.py
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, AgentState
from langchain.tools import ToolRuntime, tool
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import Field
from typing_extensions import NotRequired

from app.agent.langchain_runtime.middleware import (
    BusinessRoundMiddleware,
    build_business_middleware,
)
from app.agent.langchain_runtime.runtime import AgentContext

VISION_CALL_ID = "lr-vision-fallback-1"
VISION_TOOL = "read_image_for_vision"


# ── 观测 ────────────────────────────────────────────────────────────────
SEEN_LAST_MESSAGES: list[str] = []
CUSTOM_FRAMES: list[Any] = []


@tool
def echo(x: int = 0) -> str:
    """普通只读工具。"""
    return json.dumps({"ok": True, "x": x})


class ScriptedChat(BaseChatModel):
    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)

    @property
    def _llm_type(self) -> str:
        return "probe-stage5-vision-scripted-chat"

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        return self

    def _round(self) -> list[AIMessageChunk]:
        i = int(self.counters.get("calls", 0))
        self.counters["calls"] = i + 1
        return self.rounds[i] if i < len(self.rounds) else []

    def _record_inputs(self, messages) -> None:
        seen = self.counters.setdefault("inputs", [])
        seen.append(
            [
                (getattr(m, "type", "?"), getattr(m, "tool_call_id", None), getattr(m, "content", "")[:40])
                for m in messages
            ]
        )

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self._record_inputs(messages)
        chunks = self._round()
        merged: AIMessageChunk | None = None
        for c in chunks:
            merged = c if merged is None else merged + c
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
        self.counters["stream_calls"] = int(self.counters.get("stream_calls", 0)) + 1
        self._record_inputs(messages)
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


def tc(name: str, args: dict, call_id: str) -> AIMessageChunk:
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


class VisionState(AgentState):
    vision_attempted: NotRequired[bool]
    vision_rounds: NotRequired[int]


class VisionFallbackProbe(AgentMiddleware):
    """复刻计划中的 ``VisionFallbackMiddleware``（after_model 版）。

    ``shape`` 控制注入形态；``guard`` 控制是否有 state 守卫（Q3）。
    ``round_guard``：``"flag"`` = 只在真正触发兜底时置位（朴素实现）；
    ``"first_round"`` = 只要过一次 after_model 就自增轮次计数、只在**第一轮**触发
    （= 旧路径 ``assist_service.py:158-167`` 的「首轮无 tool call」语义）。
    """

    state_schema = VisionState

    def __init__(
        self,
        *,
        shape: str = "ai_then_tool",
        guard: bool = True,
        round_guard: str = "flag",
        emit_custom: bool = True,
        emit_jump: bool = False,
    ) -> None:
        super().__init__()
        self.shape = shape
        self.guard = guard
        self.round_guard = round_guard
        self.emit_custom = emit_custom
        self.emit_jump = emit_jump
        self.calls = 0
        self.observed: list[str] = []

    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        self.calls += 1
        messages = state["messages"] if isinstance(state, dict) else state.messages
        last = messages[-1] if messages else None
        rounds = int(state.get("vision_rounds") or 0) + 1 if isinstance(state, dict) else 1
        self.observed.append(
            f"call#{self.calls} last={type(last).__name__} "
            f"tool_calls={len(getattr(last, 'tool_calls', None) or [])} "
            f"round={rounds} attempted={state.get('vision_attempted') if isinstance(state, dict) else '?'}"
        )
        SEEN_LAST_MESSAGES.append(self.observed[-1])

        # 注意：轮次计数必须**无条件**落盘——否则「第一轮有工具调用」那条路径
        # 直接 return None，计数丢失，第二轮仍被当成首轮（实测 model_calls=3）。
        base: dict[str, Any] = (
            {"vision_rounds": rounds} if self.round_guard == "first_round" else {}
        )

        if self.round_guard == "first_round" and rounds > 1:
            return base

        if not isinstance(last, AIMessage):
            return base or None
        if last.tool_calls:
            return base or None
        if self.guard and isinstance(state, dict) and state.get("vision_attempted"):
            return base or None

        writer = getattr(runtime, "stream_writer", None)
        if self.emit_custom and callable(writer):
            writer({"type": "tool_start", "tool": VISION_TOOL, "probe": True})
            writer({"type": "tool_result", "tool": VISION_TOOL, "probe": True})
            CUSTOM_FRAMES.append("emitted")

        fake_ai = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": VISION_TOOL,
                    "args": {"path": "demo.png"},
                    "id": VISION_CALL_ID,
                    "type": "tool_call",
                }
            ],
        )
        tool_msg = ToolMessage(
            content=json.dumps({"ok": True, "tool": VISION_TOOL}, ensure_ascii=False),
            tool_call_id=VISION_CALL_ID,
            name=VISION_TOOL,
        )
        wrong_id_tool = ToolMessage(
            content="mismatch",
            tool_call_id="lr-vision-fallback-WRONG",
            name=VISION_TOOL,
        )
        only_tool = ToolMessage(
            content=json.dumps({"ok": True, "tool": VISION_TOOL}, ensure_ascii=False),
            tool_call_id=VISION_CALL_ID,
            name=VISION_TOOL,
        )

        if self.shape == "ai_then_tool":
            batch: list[Any] = [fake_ai, tool_msg]
        elif self.shape == "tool_then_ai":
            batch = [tool_msg, fake_ai]
        elif self.shape == "only_tool":
            batch = [only_tool]
        elif self.shape == "wrong_id":
            batch = [fake_ai, wrong_id_tool]
        elif self.shape == "ai_only":
            batch = [fake_ai]
        elif self.shape == "status_error":
            batch = [
                fake_ai,
                ToolMessage(
                    content="err",
                    tool_call_id=VISION_CALL_ID,
                    name=VISION_TOOL,
                    status="error",
                ),
            ]
        elif self.shape == "no_name":
            batch = [fake_ai, ToolMessage(content="x", tool_call_id=VISION_CALL_ID)]
        else:  # pragma: no cover
            raise AssertionError(self.shape)

        update: dict[str, Any] = {"messages": batch, "vision_attempted": True}
        if base:
            update.update(base)
        if self.emit_jump:
            update["jump_to"] = "model"
        return update


class ObservingBusinessRound(BusinessRoundMiddleware):
    """记录 ``BusinessRoundMiddleware.after_model`` 实际看到的最后一条消息。"""

    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        messages = state["messages"] if isinstance(state, dict) else state.messages
        last = messages[-1] if messages else None
        SEEN_LAST_MESSAGES.append(
            f"BusinessRound.after_model sees last={type(last).__name__} "
            f"content={getattr(last, 'content', '')!r:.60} "
            f"tc={getattr(last, 'tool_calls', None) or []} "
            f"vision_attempted={state.get('vision_attempted') if isinstance(state, dict) else '?'}"
        )
        return super().after_model(state, runtime)


async def run_case(
    *,
    title: str,
    shape: str = "ai_then_tool",
    guard: bool = True,
    rounds: list[list[AIMessageChunk]] | None = None,
    middleware_mode: str = "none",  # none | stack_extra | stack_first | stack_extra_observe
    max_tool_rounds: int = 2,
    recursion_limit: int | None = None,
    verbose: bool = True,
    emit_custom: bool = True,
    emit_jump: bool = False,
    round_guard: str = "flag",
) -> dict[str, Any]:
    global SEEN_LAST_MESSAGES, CUSTOM_FRAMES
    SEEN_LAST_MESSAGES = []
    CUSTOM_FRAMES = []

    vision = VisionFallbackProbe(
        shape=shape,
        guard=guard,
        emit_custom=emit_custom,
        emit_jump=emit_jump,
        round_guard=round_guard,
    )
    if middleware_mode == "none":
        middleware: list[Any] = [vision]
    elif middleware_mode == "stack_extra":
        middleware = build_business_middleware(
            max_tool_rounds=max_tool_rounds, extra=[vision]
        )
    elif middleware_mode == "stack_extra_observe":
        stack = build_business_middleware(max_tool_rounds=max_tool_rounds, extra=[vision])
        stack[0] = ObservingBusinessRound(
            phase_ctx=None,
            completed_tool_ids=frozenset(),
            phase_ctx_getter=None,
            end_turn_on_deferred=True,
        )
        middleware = stack
    elif middleware_mode == "stack_first":
        stack = build_business_middleware(max_tool_rounds=max_tool_rounds)
        middleware = [vision, *stack]
    else:  # pragma: no cover
        raise AssertionError(middleware_mode)

    if rounds is None:
        rounds = [
            [AIMessageChunk(content="让我看看这张图")],
            [AIMessageChunk(content="图里是一只猫")],
        ]

    model = ScriptedChat(rounds=rounds)
    agent = create_agent(
        model,
        [echo],
        context_schema=AgentContext,
        middleware=middleware,
        name="probe_stage5_vision",
    )
    print(f"\n{'=' * 104}\n### {title}\n  shape={shape} guard={guard} mode={middleware_mode} "
          f"mw={[type(m).__name__ for m in middleware]}")

    cfg = {"recursion_limit": recursion_limit} if recursion_limit else None
    error: str | None = None
    raw: list[Any] = []
    try:
        async for ev in agent.astream(
            {"messages": [AIMessage(content="看看 @demo.png")]},
            context=AgentContext(),
            stream_mode=["messages", "updates", "custom"],
            version="v2",
            config=cfg,
        ):
            raw.append(ev)
    except BaseException as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"

    if verbose:
        for i, ev in enumerate(raw):
            print("   ", describe_event(i, ev))

    updates = [e["data"] for e in raw if isinstance(e, dict) and e.get("type") == "updates"]
    customs = [e for e in raw if isinstance(e, dict) and e.get("type") == "custom"]
    print(f"  --- error={error!r}")
    print(f"  --- model_calls={model.counters.get('calls')} stream_calls={model.counters.get('stream_calls')}")
    print(f"  --- update nodes sequence = {[sorted(d) for d in updates]}")
    print(f"  --- custom frames = {len(customs)}: {[c['data'] for c in customs]}")
    print(f"  --- vision.observed = {vision.observed}")
    print(f"  --- BusinessRound/其它观测 = {SEEN_LAST_MESSAGES}")
    print(f"  --- model inputs per call:")
    for i, inputs in enumerate(model.counters.get("inputs", [])):
        print(f"        call#{i + 1}: {inputs}")

    final_msgs: list[Any] = []
    for d in updates:
        for upd in d.values():
            if isinstance(upd, dict):
                for m in upd.get("messages", []) or []:
                    final_msgs.append((type(m).__name__, getattr(m, "tool_call_id", None),
                                       getattr(m, "id", None), str(getattr(m, "content", ""))[:40]))
    print(f"  --- messages appearing in updates (in arrival order): {final_msgs}")
    return {
        "title": title,
        "error": error,
        "model_calls": model.counters.get("calls"),
        "nodes": [sorted(d) for d in updates],
        "customs": customs,
        "raw": raw,
        "vision_calls": vision.calls,
        "observed": list(SEEN_LAST_MESSAGES),
        "final_msgs": final_msgs,
        "inputs": model.counters.get("inputs", []),
    }


def describe_event(idx: int, event: Any) -> str:
    if not isinstance(event, dict):
        return f"{idx:>3}  <raw tuple> {event!r}"
    etype, ns, data = event.get("type"), event.get("ns"), event.get("data")
    if etype == "messages" and isinstance(data, tuple) and data:
        msg = data[0]
        meta = data[1] if len(data) > 1 else {}
        node = meta.get("langgraph_node") if isinstance(meta, dict) else None
        return (f"{idx:>3}  messages  ns={ns} node={node} cls={type(msg).__name__} "
                f"tcid={getattr(msg, 'tool_call_id', None)} content={getattr(msg, 'content', '')!r:.70}")
    if etype == "custom":
        return f"{idx:>3}  custom    ns={ns} data={data!r}"
    if etype == "updates":
        return f"{idx:>3}  updates   ns={ns} nodes={sorted(data) if isinstance(data, dict) else data} data={data!r}"
    return f"{idx:>3}  {etype}  ns={ns} data={data!r}"


async def main() -> int:
    base_rounds = [
        [AIMessageChunk(content="让我看看这张图")],
        [AIMessageChunk(content="图里是一只猫")],
    ]

    print("\n" + "#" * 104)
    print("# Q1/Q2/Q5  基线：合成 AIMessage + ToolMessage（有守卫），无阶段 2 栈")
    print("#" * 104)
    q1 = await run_case(
        title="Q1/Q2  ai_then_tool + guard，单 middleware",
        shape="ai_then_tool",
        rounds=base_rounds,
    )

    print("\n" + "#" * 104)
    print("# Q2  形态对照：tool_then_ai / only_tool / wrong_id / ai_only / status_error / no_name")
    print("#" * 104)
    neg = {}
    for shape in ("tool_then_ai", "only_tool", "wrong_id", "ai_only", "status_error", "no_name"):
        neg[shape] = await run_case(
            title=f"Q2 对照 shape={shape}",
            shape=shape,
            rounds=base_rounds,
            verbose=True,
        )

    print("\n" + "#" * 104)
    print("# Q3  终止性：无 state 守卫 → 是否无限循环（recursion_limit=12 兜底）")
    print("#" * 104)
    q3_guard = await run_case(
        title="Q3a 有守卫：第二调用仍无 tool call → 应终止",
        guard=True,
        rounds=[base_rounds[0]] + [[AIMessageChunk(content="第二次仍无工具")]] * 10,
    )
    q3_noguard = await run_case(
        title="Q3b 无守卫：应无限循环（recursion_limit=12）",
        guard=False,
        rounds=[base_rounds[0]] + [[AIMessageChunk(content="仍无工具")]] * 10,
        recursion_limit=12,
        verbose=False,
    )

    print("\n" + "#" * 104)
    print("# Q4  与真实阶段 2 栈共同工作（extra 位置 + 观测 BusinessRound；再对比把 vision 放首位）")
    print("#" * 104)
    q4a = await run_case(
        title="Q4a 真实栈 + vision 作为 extra（列表末位 → after_model 最先执行）",
        middleware_mode="stack_extra_observe",
        rounds=base_rounds,
    )
    q4b = await run_case(
        title="Q4b 真实栈 + vision 放在列表首位（after_model 最后执行 = loop_exit_node）",
        middleware_mode="stack_first",
        rounds=base_rounds,
        verbose=False,
    )
    q4c = await run_case(
        title="Q4c 真实栈 + vision extra + 显式 jump_to=model",
        middleware_mode="stack_extra",
        rounds=base_rounds,
        verbose=False,
        emit_jump=True,
    )
    q4d = await run_case(
        title="Q4d 真实栈 + vision extra，但模型第一轮就调用真实工具（朴素 guard：兜底仍会在第 2 轮触发！）",
        middleware_mode="stack_extra",
        rounds=[
            [tc("echo", {"x": 1}, "real1")],
            [AIMessageChunk(content="工具跑完了")],
            [AIMessageChunk(content="补充回答")],
        ],
        verbose=False,
    )
    q4e = await run_case(
        title="Q4e 修正语义：round_guard=first_round，第一轮就调真实工具 → 兜底不触发",
        middleware_mode="stack_extra",
        rounds=[
            [tc("echo", {"x": 1}, "real1")],
            [AIMessageChunk(content="工具跑完了")],
            [AIMessageChunk(content="补充回答")],
        ],
        verbose=False,
        round_guard="first_round",
    )
    q4f = await run_case(
        title="Q4f round_guard=first_round 正常首轮无工具 → 仍应触发一次兜底并终止",
        middleware_mode="stack_extra",
        rounds=base_rounds,
        verbose=True,
        round_guard="first_round",
    )

    print("\n" + "#" * 104)
    print("# 附送 Q6：after_model 里的 runtime.stream_writer 与自定义帧位置")
    print("#" * 104)
    q6 = await run_case(
        title="Q6  after_model 写自定义帧（emit_custom）",
        middleware_mode="stack_extra",
        rounds=base_rounds,
    )

    print("\n" + "#" * 104)
    print("# Q7  预算交互（备忘风险 4）：兜底多出的那次模型调用是否被预算计数吃进收尾轮")
    print("#" * 104)
    q7a = await run_case(
        title="Q7a max_tool_rounds=0 + 兜底触发（wrap_up_at=2 → 兜底轮正好撞上收尾轮）",
        middleware_mode="stack_extra",
        rounds=base_rounds,
        verbose=False,
        round_guard="first_round",
        max_tool_rounds=0,
    )
    q7b = await run_case(
        title="Q7b max_tool_rounds=0 基线：第一轮就调真实工具（对照）",
        middleware_mode="stack_extra",
        rounds=[
            [tc("echo", {"x": 1}, "real1")],
            [AIMessageChunk(content="工具跑完了")],
            [AIMessageChunk(content="补充回答")],
        ],
        verbose=False,
        round_guard="first_round",
        max_tool_rounds=0,
    )
    q7c = await run_case(
        title="Q7c max_tool_rounds=1 + 兜底触发（wrap_up_at=3，应不受影响）",
        middleware_mode="stack_extra",
        rounds=base_rounds,
        verbose=False,
        round_guard="first_round",
        max_tool_rounds=1,
    )

    print("\n" + "=" * 104)
    print("### VERDICT")
    print(f"  Q1  合成 AI+ToolMessage 产生第二次模型调用        : "
          f"{q1['model_calls'] == 2}  (model_calls={q1['model_calls']})")
    print(f"  Q1  未进 tools 节点（无 'tools' update）           : "
          f"{all('tools' not in n for n in q1['nodes'])}  nodes={q1['nodes']}")
    print(f"  Q2  可用形态 ai_then_tool                          : "
          f"{q1['model_calls'] == 2 and q1['error'] is None}")
    for shape, res in neg.items():
        print(f"  Q2  shape={shape:<14} model_calls={res['model_calls']} "
              f"error={res['error']!r} nodes={res['nodes']}")
    print(f"  Q3a 有守卫终止                                     : "
          f"{q3_guard['error'] is None and q3_guard['model_calls'] == 2}")
    print(f"  Q3b 无守卫不终止（recursion 报错）                 : "
          f"{q3_noguard['error'] is not None}  error={q3_noguard['error']!r} "
          f"model_calls={q3_noguard['model_calls']}")
    print(f"  Q4a 真实栈+extra：第二次调用 + 无 tools 节点        : "
          f"{q4a['error'] is None and q4a['model_calls'] == 2 and all('tools' not in n for n in q4a['nodes'])}")
    print(f"  Q4b 真实栈+vision 首位                             : "
          f"error={q4b['error']!r} model_calls={q4b['model_calls']} nodes={q4b['nodes']}")
    print(f"  Q4c 真实栈+extra+显式 jump_to=model                : "
          f"error={q4c['error']!r} model_calls={q4c['model_calls']} nodes={q4c['nodes']}")
    print(f"  Q4d 朴素 guard：第一轮真工具后**误触发**兜底          : "
          f"model_calls={q4d['model_calls']} tools_ran={any('tools' in n for n in q4d['nodes'])} "
          f"custom={len(q4d['customs'])} (期望 2/True/0)")
    print(f"  Q4e first_round 守卫：真工具轮不触发兜底             : "
          f"{q4e['error'] is None and q4e['model_calls'] == 2 and any('tools' in n for n in q4e['nodes']) and not q4e['customs']} "
          f"(model_calls={q4e['model_calls']} nodes={[n for n in q4e['nodes'] if 'model' in n or 'tools' in n]})")
    print(f"  Q4f first_round 守卫：首轮无工具仍触发一次           : "
          f"{q4f['error'] is None and q4f['model_calls'] == 2 and len(q4f['customs']) == 2}")
    print(f"  Q6  after_model 自定义帧数量                       : {len(q6['customs'])}")
    print(f"  Q6  after_model 的 writer 是否 callable            : {q6['customs'] != [] }")
    for tag, res in (("Q7a", q7a), ("Q7b", q7b), ("Q7c", q7c)):
        print(f"  {tag} model_calls={res['model_calls']} error={res['error']!r}")
        for i, inputs in enumerate(res["inputs"]):
            print(f"        {tag} call#{i + 1}: {inputs}")
    print("\n  --- Q4a 观测明细（谁在什么时候看到什么）---")
    for line in q4a["observed"]:
        print("     ", line)
    print("\n  --- Q4a 完整事件序列 ---")
    for i, ev in enumerate(q4a["raw"]):
        print("     ", describe_event(i, ev))
    print("\n  --- Q6 完整事件序列 ---")
    for i, ev in enumerate(q6["raw"]):
        print("     ", describe_event(i, ev))
    print("\n  --- Q1 完整事件序列 ---")
    for i, ev in enumerate(q1["raw"]):
        print("     ", describe_event(i, ev))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
