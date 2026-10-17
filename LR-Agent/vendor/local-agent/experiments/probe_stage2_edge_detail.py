"""精确追踪：model_to_tools 的 pending_tool_calls 计算过程。"""

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
    orig = F._make_model_to_tools_edge

    def patched(**kw):
        inner = orig(**kw)

        def wrapper(state):
            ai, tms = F._fetch_last_ai_and_tool_messages(state["messages"])
            ids = [m.tool_call_id for m in tms]
            calls = list(getattr(ai, "tool_calls", None) or []) if ai else []
            pending = [c["id"] for c in calls if c["id"] not in ids]
            out = inner(state)
            tgt = "SEND" if isinstance(out, list) else out
            print(f"  [edge] ai_calls={[c['id'] for c in calls]} tool_msg_ids={ids} "
                  f"pending={pending} jump_to={state.get('jump_to')!r} -> {tgt}")
            if isinstance(out, list):
                for s in out:
                    print(f"        SEND args={s.arg!r}")
            return out
        return wrapper

    F._make_model_to_tools_edge = patched

    tools = [mk("read_workspace_file", {"relative_path": {"type": "string"}}),
             mk("auto_annotate", {"paths": {"type": "array"}, "all_files": {"type": "boolean"}})]
    mws = build_business_middleware(max_tool_rounds=5)
    m = M(rounds=[
        [tc("r1", "read_workspace_file", {"relative_path": "a.md"}),
         tc("a1", "auto_annotate", {"paths": ["data/1.jpg"], "all_files": False})],
        [AIMessageChunk(content="done")],
    ])
    ag = create_agent(m, tools, context_schema=AgentContext, middleware=mws)
    evs = [e async for e in ag.astream({"messages": [HumanMessage(content="go")]},
                                       context=AgentContext(mode="assist"),
                                       stream_mode=["messages", "updates"], version="v2")]
    print("CALLS =", CALLS)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
