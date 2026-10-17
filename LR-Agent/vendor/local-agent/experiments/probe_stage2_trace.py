"""逐轮追踪：after_model 的返回值与 model_to_tools 收到的 jump_to / messages。"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import langchain.agents.factory as F
from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field

from app.agent.langchain_runtime import AgentContext, build_business_middleware

EXEC: list = []


def mk(name):
    def _fn(**kw):
        EXEC.append((name, kw))
        return json.dumps({"ok": True, "summary": "ok"})
    return StructuredTool(name=name, description="d", func=_fn,
                          args_schema={"type": "object", "properties": {}})


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
        if i < len(self.rounds):
            return self.rounds[i]
        self.counters["ex"] = self.counters.get("ex", 0) + 1
        if int(self.counters["ex"]) > 3:
            raise RuntimeError("routing loop")
        return [AIMessageChunk(content="done")]

    def _generate(self, messages, stop=None, run_manager=None, **kw):
        ch = self._r()
        m = None
        for c in ch:
            m = c if m is None else m + c
        return ChatResult(generations=[ChatGeneration(message=AIMessage(
            content=m.content if m else "", tool_calls=list(m.tool_calls) if m else []))])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kw):
        return self._generate(messages)

    async def _astream(self, messages, stop=None, run_manager=None, **kw):
        for c in self._r():
            yield ChatGenerationChunk(message=c)


def tc(i, n, a):
    return AIMessageChunk(content="", tool_call_chunks=[
        {"name": n, "args": json.dumps(a), "id": i, "index": 0, "type": "tool_call_chunk"}])


async def main():
    orig = F._make_model_to_tools_edge

    def patched(**kw):
        inner = orig(**kw)

        def wrapper(state):
            out = inner(state)
            msgs = state.get("messages", [])
            print(f"  [edge] jump_to={state.get('jump_to')!r} "
                  f"n={len(msgs)} processing={state.get('round_plan_message_id')!r} "
                  f"end_after={state.get('end_after_round')!r} "
                  f"-> {'SEND' if isinstance(out, list) else out}")
            return out
        return wrapper

    F._make_model_to_tools_edge = patched

    mws = build_business_middleware(max_tool_rounds=5)
    brm = mws[3]
    o = brm.after_model

    def traced(state, runtime):
        out = o(state, runtime)
        print(f"  [brm.after_model] last={type(state['messages'][-1]).__name__} "
              f"-> jump_to={out.get('jump_to') if out else None!r} "
              f"end={out.get('end_after_round') if out else None!r} "
              f"ninj={len(out.get('messages', [])) if out else 0}")
        return out

    brm.after_model = traced  # type: ignore[method-assign]

    model = M(rounds=[[tc("a1", "auto_annotate", {"paths": ["x"]})],
                      [AIMessageChunk(content="done")]])
    tools = [mk("auto_annotate")]
    ag = create_agent(model, tools, context_schema=AgentContext, middleware=mws)
    evs = [e async for e in ag.astream({"messages": [HumanMessage(content="go")]},
                                       context=AgentContext(mode="assist"),
                                       stream_mode=["messages", "updates"], version="v2")]
    print("EXEC =", EXEC)
    print("model calls =", m.counters.get("calls"))
    for e in evs:
        if isinstance(e, dict) and e.get("type") == "updates":
            print("  node:", sorted(e["data"]))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
