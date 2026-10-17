"""预算收尾探针：before_model 的 wrap_up 判定与 state 通道。"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field

from app.agent.langchain_runtime import AgentContext, build_business_middleware
from app.agent.langchain_runtime.middleware import BudgetWrapUpMiddleware

EXEC: list = []


def mk(name):
    def _fn(path: str = "") -> str:
        EXEC.append({"path": path})
        return json.dumps({"ok": True, "summary": "ok"})
    return StructuredTool.from_function(func=_fn, name=name, description="d")


class M(BaseChatModel):
    rounds: list = Field(default_factory=list)
    counters: dict = Field(default_factory=dict)
    seen: list = Field(default_factory=list)

    @property
    def _llm_type(self):
        return "m"

    def bind_tools(self, tools, **kw):  # type: ignore[override]
        self.counters["bind_tools_calls"] = int(self.counters.get("bind_tools_calls", 0)) + 1
        return self

    def _r(self):
        i = int(self.counters.get("calls", 0))
        self.counters["calls"] = i + 1
        return self.rounds[i] if i < len(self.rounds) else [AIMessageChunk(content="")]

    def _generate(self, messages, stop=None, run_manager=None, **kw):
        ch = self._r()
        m = None
        for c in ch:
            m = c if m is None else m + c
        return ChatResult(generations=[ChatGeneration(message=AIMessage(
            content=m.content if m else "", tool_calls=list(m.tool_calls) if m else []))])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kw):
        self.seen.append(list(messages))
        return self._generate(messages)

    async def _astream(self, messages, stop=None, run_manager=None, **kw):
        self.seen.append(list(messages))
        for c in self._r():
            yield ChatGenerationChunk(message=c)


def tc(i, n, a):
    return AIMessageChunk(content="", tool_call_chunks=[
        {"name": n, "args": json.dumps(a), "id": i, "index": 0, "type": "tool_call_chunk"}])


async def main():
    tools = [mk("read_workspace_file")]
    MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    mws = build_business_middleware(max_tool_rounds=MAX)
    bwu = next(m for m in mws if isinstance(m, BudgetWrapUpMiddleware))
    brm = mws[0]
    print("max_tool_rounds =", MAX, " wrap_up_at =", bwu.wrap_up_at)

    _obo = brm.before_model
    _oao = brm.after_model

    def tb(state, runtime):
        out = _obo(state, runtime)
        print(f"  [brm.before_model] in end_after={state.get('end_after_round')!r} "
              f"executed={state.get('round_executed')!r} -> {out}")
        return out

    def ta(state, runtime):
        out = _oao(state, runtime)
        print(f"  [brm.after_model] -> {out}")
        return out

    brm.before_model = tb  # type: ignore[method-assign]
    brm.after_model = ta  # type: ignore[method-assign]

    orig = bwu.before_model

    def traced(state, runtime):
        out = orig(state, runtime)
        print(f"  [bwu.before_model] count_in={state.get('wrap_up_calls')!r} "
              f"active_in={state.get('wrap_up_active')!r} -> {out}")
        return out

    bwu.before_model = traced  # type: ignore[method-assign]

    _tool_round = [[tc("call-1", "read_workspace_file", {"path": "a.md"})],
                   [tc("call-2", "read_workspace_file", {"path": "a.md"})],
                   [AIMessageChunk(content="预算已用完。")]]
    m = M(rounds=_tool_round)
    ag = create_agent(m, tools, context_schema=AgentContext, middleware=mws)
    evs = [e async for e in ag.astream({"messages": [HumanMessage(content="go")]},
                                       context=AgentContext(mode="assist"),
                                       stream_mode=["messages", "updates"], version="v2")]
    print("calls =", m.counters.get("calls"), "bind_tools =", m.counters.get("bind_tools_calls"))
    print("EXEC =", EXEC)
    for i, msgs in enumerate(m.seen):
        print(f"  round{i} tail = {[(type(x).__name__, str(getattr(x,'content',''))[:30]) for x in msgs[-3:]]}")
    for e in evs:
        if isinstance(e, dict) and e.get("type") == "updates":
            print("  node:", sorted(e["data"]))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
