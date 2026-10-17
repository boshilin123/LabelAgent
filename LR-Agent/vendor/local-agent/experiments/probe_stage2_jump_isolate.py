"""隔离探针：after_model 返回 {"jump_to": "model"} 到底有没有生效？"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import langchain.agents.factory as F
from langchain.agents import create_agent
from langchain.agents.middleware import (
    AgentMiddleware,
    AgentState,
    ModelCallLimitMiddleware,
    ToolErrorMiddleware,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field
from typing_extensions import NotRequired

EXEC: list = []


def mk(name):
    def _fn(**kw):
        EXEC.append((name, kw))
        return json.dumps({"ok": True})
    return StructuredTool(name=name, description="d", func=_fn, args_schema={"type": "object", "properties": {}})


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
        self.counters["exhausted"] = self.counters.get("exhausted", 0) + 1
        if int(self.counters["exhausted"]) > 3:
            raise RuntimeError("scripted rounds exhausted (likely a routing loop)")
        return [AIMessageChunk(content="")]

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


class JumpAfter(AgentMiddleware):
    def __init__(self):
        super().__init__()
        self.log: list[str] = []

    def after_model(self, state, runtime):
        self.log.append("after_model -> jump_to=model")
        return {"jump_to": "model"}


class JumpBefore(AgentMiddleware):
    def __init__(self):
        super().__init__()
        self.log: list[str] = []

    def before_model(self, state, runtime):
        self.log.append(f"before_model jump_to_in_state={state.get('jump_to')!r}")
        return None


class OrigAfterJump(AgentMiddleware):
    """同时也返回 messages，模拟真实抑制。"""

    def after_model(self, state, runtime):
        last = state["messages"][-1]
        from langchain_core.messages import ToolMessage
        return {
            "messages": [ToolMessage(content="BLOCK", tool_call_id="a1")],
            "jump_to": "model",
        }


class JumpBeforeEnd(AgentMiddleware):
    """before_model 在第二轮 jump_to=end。"""

    def __init__(self):
        super().__init__()
        self.log: list[str] = []

    def before_model(self, state, runtime):
        n = len(state.get("messages", []))
        self.log.append(f"before_model n={n}")
        if n >= 3:
            return {"jump_to": "end"}
        return None


class SuppressThenEnd(AgentMiddleware):
    """after_model 抑制 + jump_to=model；before_model 下一轮 end。"""

    def __init__(self):
        super().__init__()
        self.log: list[str] = []
        self._suppressed = False

    def after_model(self, state, runtime):
        if self._suppressed:
            self.log.append("after_model: already suppressed")
            return None
        self._suppressed = True
        from langchain_core.messages import ToolMessage
        self.log.append("after_model: suppress + jump_to=model")
        return {
            "messages": [ToolMessage(content="BLOCK", tool_call_id="a1")],
            "jump_to": "model",
            "end_after": True,
        }

    def before_model(self, state, runtime):
        if state.get("end_after"):
            self.log.append("before_model: jump_to=end")
            return {"end_after": False, "jump_to": "end"}
        self.log.append("before_model: continue")
        return None

    class _S(AgentState):
        end_after: NotRequired[bool]

    state_schema = _S


async def run(title, mws, rounds, tools, patch_edge=False):
    global EXEC
    EXEC = []
    if patch_edge:
        orig = F._make_model_to_tools_edge

        def patched(**kw):
            inner = orig(**kw)

            def wrapper(state):
                out = inner(state)
                print(f"    [edge] jump_to={state.get('jump_to')!r} n={len(state.get('messages', []))} "
                      f"-> {'SEND' if isinstance(out, list) else out}")
                return out
            return wrapper
        F._make_model_to_tools_edge = patched
    m = M(rounds=rounds)
    ag = create_agent(m, tools, middleware=mws)
    evs = [e async for e in ag.astream({"messages": [HumanMessage(content="go")]},
                                       stream_mode=["messages", "updates"], version="v2")]
    nodes = [sorted(e["data"]) for e in evs if isinstance(e, dict) and e.get("type") == "updates"]
    print(f"\n===== {title} =====")
    print(f"  model calls = {m.counters.get('calls')}")
    print(f"  EXEC = {EXEC}")
    print(f"  nodes = {[n for n in nodes]}")
    for mw in mws:
        for line in getattr(mw, "log", []):
            print(f"    [{mw.name}] {line}")


async def main():
    tools = [mk("read_a")]

    # A: 只有 JumpAfter（无 messages）——实测会无限循环，故跳过
    #    await run(
    #        "A. after_model jump_to=model, no messages",
    #        [JumpBefore(), JumpAfter()], ...
    #    )

    # B: 带 messages + jump_to
    await run(
        "B. after_model messages + jump_to=model",
        [OrigAfterJump()],
        [[tc("a1", "read_a", {})], [AIMessageChunk(content="done")]],
        tools,
        patch_edge=True,
    )

    # E: before_model 能否 jump_to=end
    await run(
        "E. before_model jump_to=end",
        [JumpBeforeEnd()],
        [[tc("a1", "read_a", {})], [AIMessageChunk(content="done")]],
        tools,
        patch_edge=True,
    )

    # F: 真实两段式（抑制 + jump_to=model → before_model end）
    await run(
        "F. suppress + jump_to=model, then before_model end",
        [SuppressThenEnd()],
        [[tc("a1", "read_a", {})], [AIMessageChunk(content="done")]],
        tools,
        patch_edge=True,
    )

    # C: 模拟真实顺序：ModelCallLimit 在最外层（列表首位），自写件在后
    await run(
        "C. real order: ModelCallLimit first, then JumpAfter",
        [ModelCallLimitMiddleware(run_limit=7, exit_behavior="end"), JumpAfter()],
        [[tc("a1", "read_a", {})], [AIMessageChunk(content="done")]],
        tools,
        patch_edge=True,
    )

    # D: 自写件在首位（最外层）
    await run(
        "D. JumpAfter first (outermost)",
        [JumpAfter(), ModelCallLimitMiddleware(run_limit=7, exit_behavior="end")],
        [[tc("a1", "read_a", {})], [AIMessageChunk(content="done")]],
        tools,
        patch_edge=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
