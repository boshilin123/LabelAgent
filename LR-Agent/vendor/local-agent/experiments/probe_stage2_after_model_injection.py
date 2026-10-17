"""阶段 2 机制探针（一次性、throwaway）：``after_model`` 注入 ToolMessage 能否阻止工具执行。

回答五个问题（规格 §2 的核心机制）：

Q1  ``after_model`` 返回 ``{"messages": [ToolMessage(tool_call_id=..., content=...)]}``
    是否真的把匹配的 ``tool_call_id`` 从 ``pending_tool_calls`` 剔除，使该工具**永不执行**？
Q2  注入的 ToolMessage 是否真的进入 state["messages"]（能被后续模型调用看到）？
Q3  被剔除的调用会不会让图**停住**（走到 END）？还是回到模型节点再调一次？
Q4  ``after_model`` 写入的自定义 state 字段，``wrap_tool_call`` 能否通过
    ``request.state`` 读到（跨节点通道传递）？
Q5  同时注入一个 ToolMessage + 保留另一个真正执行的调用时，二者是否并存？
Q6  部分拦截时，注入的 ToolMessage 与真实执行的 ToolMessage 是否同时进入 state？

运行：
    .venvs\\langchain-migration\\Scripts\\python.exe experiments\\probe_stage2_after_model_injection.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import AgentState
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field


EXECUTIONS: list[tuple[str, dict]] = []


def make_tool(name: str):
    if name == "read_a":
        def _fn(x: int = 0) -> str:
            EXECUTIONS.append((name, {"x": x}))
            return json.dumps({"ok": True, "tool": name, "x": x}, ensure_ascii=False)
    else:
        def _fn(y: int = 0) -> str:
            EXECUTIONS.append((name, {"y": y}))
            return json.dumps({"ok": True, "tool": name, "y": y}, ensure_ascii=False)

    return StructuredTool.from_function(func=_fn, name=name, description=f"tool {name}")


class ScriptedChat(BaseChatModel):
    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)

    @property
    def _llm_type(self) -> str:
        return "probe-scripted-chat"

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        return self

    def _round(self) -> list[AIMessageChunk]:
        i = int(self.counters.get("calls", 0))
        self.counters["calls"] = i + 1
        self.counters["last_round_idx"] = i
        return self.rounds[i] if i < len(self.rounds) else []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
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


class ProbeState(AgentState):
    probe_plan: list[str] = Field(default_factory=list)


class InjectMiddleware(AgentMiddleware):
    """在 after_model 注入 ToolMessage 拦截一个或多个 tool_call_id。"""

    state_schema = ProbeState

    def __init__(self, *, block: set[str]) -> None:
        super().__init__()
        self._block = block
        self.tool_ids_seen: list[Any] = []
        self.plan_seen: list[Any] = []

    def after_model(self, state, runtime):  # type: ignore[override]
        last = state["messages"][-1]
        calls = list(getattr(last, "tool_calls", None) or [])
        blocked = [c for c in calls if c.get("id") in self._block]
        if not blocked:
            return None
        return {
            "messages": [
                ToolMessage(content=f"BLOCKED:{c['name']}", tool_call_id=c["id"])
                for c in blocked
            ],
            "probe_plan": [c["name"] for c in blocked],
        }

    async def awrap_tool_call(self, request, handler):  # type: ignore[override]
        self.tool_ids_seen.append(request.tool_call.get("id"))
        st = request.state
        if isinstance(st, dict):
            self.plan_seen.append(st.get("probe_plan"))
        else:
            self.plan_seen.append(getattr(st, "probe_plan", "<not-dict>"))
        return await handler(request)


async def run_case(title: str, rounds, tools, block) -> dict:
    global EXECUTIONS
    EXECUTIONS = []
    mw = InjectMiddleware(block=block)
    model = ScriptedChat(rounds=rounds)
    agent = create_agent(model, list(tools), middleware=[mw])
    error: str | None = None
    events: list = []
    try:
        events = [
            ev
            async for ev in agent.astream(
                {"messages": [AIMessage(content="go")]},
                stream_mode=["messages", "updates"],
                version="v2",
            )
        ]
    except BaseException as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"

    updates = [e["data"] for e in events if isinstance(e, dict) and e.get("type") == "updates"]
    nodes = [sorted(d) for d in updates]
    all_tool_msgs = []
    for d in updates:
        for upd in d.values():
            if not isinstance(upd, dict):
                continue
            for m in upd.get("messages", []) or []:
                if isinstance(m, ToolMessage):
                    all_tool_msgs.append((m.tool_call_id, m.content))
    print(f"\n===== {title} =====")
    print(f"  error                = {error}")
    print(f"  model rounds         = {model.counters.get('calls')}")
    print(f"  stream_calls         = {model.counters.get('stream_calls')}")
    print(f"  executions           = {EXECUTIONS}")
    print(f"  update node sequence = {nodes}")
    print(f"  ToolMessages         = {all_tool_msgs}")
    print(f"  wrap_tool_call saw   = {mw.tool_ids_seen}")
    print(f"  plan via request.state = {mw.plan_seen}")
    return {
        "error": error,
        "executions": list(EXECUTIONS),
        "nodes": nodes,
        "tool_msgs": all_tool_msgs,
        "wrap_saw": list(mw.tool_ids_seen),
        "plan_seen": list(mw.plan_seen),
        "calls": model.counters.get("calls"),
    }


async def main() -> int:
    tools = [make_tool("read_a"), make_tool("read_b")]

    r1 = await run_case(
        "Q1/Q2/Q3  single call blocked by after_model injection (round2 = plain text)",
        rounds=[[tc("read_a", {"x": 1}, "c1")], [AIMessageChunk(content="done")]],
        tools=tools,
        block={"c1"},
    )
    r2 = await run_case(
        "Q4/Q5/Q6  two calls: block c1, execute c2",
        rounds=[
            [tc("read_a", {"x": 1}, "c1"), tc("read_b", {"y": 2}, "c2")],
            [AIMessageChunk(content="done")],
        ],
        tools=tools,
        block={"c1"},
    )
    r3 = await run_case(
        "CONTROL  no injection",
        rounds=[[tc("read_a", {"x": 1}, "c1")], [AIMessageChunk(content="done")]],
        tools=tools,
        block=set(),
    )
    r4 = await run_case(
        "Q3b  blocked call, model keeps re-issuing it (infinite-loop risk?)",
        rounds=[
            [tc("read_a", {"x": 1}, "c1")],
            [tc("read_a", {"x": 1}, "c1b")],
            [tc("read_a", {"x": 1}, "c1c")],
            [AIMessageChunk(content="done")],
        ],
        tools=tools,
        block={"c1", "c1b", "c1c"},
    )

    print("\n===== VERDICT =====")
    print(f"  Q1 injection suppresses execution        : "
          f"{r1['executions'] == [] and r3['executions'] == [('read_a', {'x': 1})]}")
    print(f"  Q2 injected ToolMessage enters state     : "
          f"{('c1', 'BLOCKED:read_a') in r1['tool_msgs']}")
    print(f"  Q3 blocked -> loop back to model         : "
          f"{r1['calls'] == 2 and all('tools' not in n for n in r1['nodes'])}")
    print(f"  Q3c repeated blocking terminates (r4)    : {r4['error'] is None and r4['calls'] == 4}")
    print(f"  Q4 plan channel via request.state        : "
          f"{r2['plan_seen'] and r2['plan_seen'][0] == ['read_a']}")
    print(f"  Q5 partial block: only c2 executes       : "
          f"{r2['executions'] == [('read_b', {'y': 2})]}")
    print(f"  Q6 both injected+real ToolMessages       : {r2['tool_msgs']}")
    print(f"  r1 nodes = {r1['nodes']}")
    print(f"  r2 nodes = {r2['nodes']}")
    print(f"  r4 nodes = {r4['nodes']}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
