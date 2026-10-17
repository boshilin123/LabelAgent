"""对比：jump_to=model 在「有我方 before_model」与「无」时的路由目标。

结论待测：``loop_entry_node`` 在 ``middleware_w_before_model`` 为空时等于 ``"model"``，
而 ``_resolve_jump`` 对 ``"model"`` 返回 ``loop_entry_node``——
若目标是 loop_exit_node（after_model）会立刻再 jump，形成死循环。
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import langchain.agents.factory as F
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field

EXEC: list = []


def mk(name):
    def _fn(**kw):
        EXEC.append((name, kw))
        return json.dumps({"ok": True})
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
        if int(self.counters["ex"]) > 4:
            raise RuntimeError("LOOP")
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


class BeforeOnly(AgentMiddleware):
    def before_model(self, state, runtime):
        return None


class SuppressAfter(AgentMiddleware):
    """抑制 a1 + jump_to=model，且用 message id 防重入。"""

    def __init__(self):
        super().__init__()
        self.log: list[str] = []

    def after_model(self, state, runtime):
        last = state["messages"][-1]
        mid = str(getattr(last, "id", "") or "")
        if state.get("seen_id") == mid:
            self.log.append(f"skip (already processed {mid[:20]})")
            return None
        calls = list(getattr(last, "tool_calls", None) or [])
        block = [c for c in calls if c["id"] == "a1"]
        if not block:
            self.log.append("no block")
            return {"seen_id": mid}
        self.log.append(f"block+jump mid={mid[:20]}")
        return {
            "seen_id": mid,
            "messages": [ToolMessage(content="BLOCKED", tool_call_id=c["id"]) for c in block],
            "jump_to": "model",
        }


async def run(title, mws, rounds, tools, patch=True):
    global EXEC
    EXEC = []
    targets: list[str] = []
    if patch:
        orig = F._make_model_to_tools_edge

        def patched(**kw):
            inner = orig(**kw)

            def wrapper(state):
                out = inner(state)
                tgt = "SEND(list)" if isinstance(out, list) else out
                targets.append(tgt)
                print(f"    [edge] jump_to={state.get('jump_to')!r} -> {tgt}")
                return out
            return wrapper
        F._make_model_to_tools_edge = patched
    m = M(rounds=rounds)
    ag = create_agent(m, tools, middleware=mws)
    err = None
    try:
        await asyncio.gather(*[e async for e in ag.astream(
            {"messages": [HumanMessage(content="go")]},
            stream_mode=["messages", "updates"], version="v2")]) if False else None
        evs = [e async for e in ag.astream({"messages": [HumanMessage(content="go")]},
                                           stream_mode=["messages", "updates"], version="v2")]
    except BaseException as exc:  # noqa: BLE001
        err = f"{type(exc).__name__}: {exc}"
    print(f"\n===== {title} =====")
    print(f"  err={err}")
    print(f"  model calls = {m.counters.get('calls')}")
    print(f"  EXEC = {EXEC}")
    print(f"  edge targets = {targets}")
    for mw in mws:
        for line in getattr(mw, "log", []):
            print(f"    [{mw.name}] {line}")


async def main():
    tools = [mk("read_a")]
    rounds = [[tc("a1", "read_a", {})], [AIMessageChunk(content="done")]]

    await run("G. SuppressAfter alone (no before_model)",
              [SuppressAfter()], rounds, tools)
    await run("H. BeforeOnly + SuppressAfter (real shape)",
              [BeforeOnly(), SuppressAfter()], rounds, tools)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
