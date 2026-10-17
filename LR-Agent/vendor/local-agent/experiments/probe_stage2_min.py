"""最小复现：单个 ASYNC 工具调用是否真的被抑制。"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
import traceback

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field

from app.agent.langchain_runtime import AgentContext, build_business_middleware
from app.agent.langchain_runtime.round_plan import plan_round

CALLS: list = []


def boom(**kwargs):
    CALLS.append((kwargs, [f.filename + ":" + str(f.lineno) + " " + f.name
                           for f in traceback.extract_stack()[-6:-1]]))
    return json.dumps({"ok": True, "summary": "ok"})


class M(BaseChatModel):
    rounds: list = Field(default_factory=list)
    counters: dict = Field(default_factory=dict)

    @property
    def _llm_type(self):
        return "m"

    def bind_tools(self, tools, **kw):  # type: ignore[override]
        return self

    def _r(self):
        i = int(self.counters.get("calls", 0))
        self.counters["calls"] = i + 1
        return self.rounds[i] if i < len(self.rounds) else []

    def _generate(self, messages, stop=None, run_manager=None, **kw):
        ch = self._r()
        m = None
        for c in ch:
            m = c if m is None else m + c
        return ChatResult(generations=[ChatGeneration(message=AIMessage(
            content=m.content if m else "",
            tool_calls=list(m.tool_calls) if m else []))])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kw):
        return self._generate(messages)

    async def _astream(self, messages, stop=None, run_manager=None, **kw):
        for c in self._r():
            yield ChatGenerationChunk(message=c)


def tc(i, n, a):
    return AIMessageChunk(content="", tool_call_chunks=[
        {"name": n, "args": json.dumps(a), "id": i, "index": 0, "type": "tool_call_chunk"}])


class Spy(AgentMiddleware):
    def __init__(self):
        super().__init__()
        self.log: list[str] = []

    def after_model(self, state, runtime):
        last = state["messages"][-1]
        self.log.append(f"spy.after_model tool_calls={getattr(last, 'tool_calls', None)!r}")
        return None


async def main():
    import langchain.agents.factory as F

    orig_edge = F._make_model_to_tools_edge

    def patched(**kw):
        inner = orig_edge(**kw)

        def wrapper(state):
            out = inner(state)
            print("  [model_to_tools] jump_to=", state.get("jump_to"),
                  " n_msgs=", len(state.get("messages", [])),
                  " -> ", "SEND" if isinstance(out, list) else out)
            return out

        return wrapper

    F._make_model_to_tools_edge = patched

    p = plan_round(AIMessage(content="", tool_calls=[
        {"name": "auto_annotate", "args": {"paths": ["x"]}, "id": "a1", "type": "tool_call"}]))
    print("plan: defer=", [c.name for c in p.deferred], " exec=", [c.name for c in p.execute_now])

    tools = [StructuredTool.from_function(func=boom, name="auto_annotate", description="d")]
    mws = build_business_middleware(max_tool_rounds=5)
    brm = mws[3]
    print("brm =", type(brm).__name__)
    # 包一层 spy 观察 hook 返回值
    orig = brm.after_model

    def traced(state, runtime):
        out = orig(state, runtime)
        print("  [after_model] ->", out)
        return out

    brm.after_model = traced  # type: ignore[method-assign]

    m = M(rounds=[[tc("a1", "auto_annotate", {"paths": ["x"]})], [AIMessageChunk(content="done")]])
    ag = create_agent(m, tools, context_schema=AgentContext, middleware=mws)
    evs = [e async for e in ag.astream(
        {"messages": [HumanMessage(content="go")]},
        context=AgentContext(mode="assist"),
        stream_mode=["messages", "updates"], version="v2")]
    print("CALLS =", CALLS)
    print("model calls =", m.counters.get("calls"))
    for e in evs:
        if isinstance(e, dict) and e.get("type") == "updates":
            print("  update:", sorted(e["data"]))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
