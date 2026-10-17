"""只跑混合轮，统计 model 节点真实执行次数。"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import langchain.agents.factory as F
from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field

from app.agent.langchain_runtime import AgentContext, build_business_middleware

CALLS: list = []


def mk(name, props):
    def _fn(**kw):
        CALLS.append((name, kw))
        return json.dumps({"ok": True, "summary": "ok"})
    return StructuredTool(name=name, description="d", func=_fn,
                          args_schema={"type": "object", "properties": props})


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
        return self.rounds[i] if i < len(self.rounds) else [AIMessageChunk(content="")]

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


async def main():
    # 统计 model 节点真实执行次数（不看 updates 流，直接数模型调用）
    tools = [mk("read_workspace_file", {"relative_path": {"type": "string"}}),
             mk("auto_annotate", {"paths": {"type": "array"}, "all_files": {"type": "boolean"}})]
    mws = build_business_middleware(max_tool_rounds=5)
    brm = mws[0]
    _ob, _oa = brm.before_model, brm.after_model

    def tb(state, runtime):
        out = _ob(state, runtime)
        print(f"  [brm.before] end_after={state.get('end_after_round')!r} "
              f"executed={state.get('round_executed')!r} n_msgs={len(state['messages'])} -> {out}")
        return out

    def ta(state, runtime):
        out = _oa(state, runtime)
        summary = None if out is None else {k: v for k, v in out.items() if k != "round_plan"}
        print(f"  [brm.after] -> {summary}")
        return out

    brm.before_model = tb  # type: ignore[method-assign]
    brm.after_model = ta  # type: ignore[method-assign]
    m = M(rounds=[
        [tc("r1", "read_workspace_file", {"relative_path": "a.md"}),
         tc("a1", "auto_annotate", {"paths": ["data/1.jpg"], "all_files": False})],
        [AIMessageChunk(content="done")],
    ])
    ag = create_agent(m, tools, context_schema=AgentContext, middleware=mws)
    evs = [e async for e in ag.astream(
        {"messages": [HumanMessage(content="go")]},
        context=AgentContext(mode="assist"),
        stream_mode=["messages", "updates"], version="v2")]
    print("model._round calls (模型真实调用次数) =", m.counters.get("calls"))
    print("CALLS =", CALLS)
    # 数 updates 流里 model 节点出现的次数
    n_model = sum(
        1 for e in evs
        if isinstance(e, dict) and e.get("type") == "updates" and "model" in e["data"]
    )
    print("updates 流中 model 节点条数 =", n_model)
    seq = []
    for e in evs:
        if isinstance(e, dict) and e.get("type") == "updates":
            seq.append(sorted(e["data"])[0])
    print("节点序列 =", seq)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
