"""阶段 2 端到端探针：自写 middleware 真的能抑制执行 / 改写合并参数 / 收尾。

运行：
    .venvs\\langchain-migration\\Scripts\\python.exe experiments\\probe_stage2_middleware_e2e.py
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain.agents import create_agent  # noqa: E402
from langchain.agents.middleware import AgentMiddleware  # noqa: E402
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
from pydantic import Field  # noqa: E402

from app.agent.assist.task_phase import derive_task_phase  # noqa: E402
from app.agent.langchain_runtime import (  # noqa: E402
    AgentContext,
    build_business_middleware,
)
from app.schemas.agent import ProposalStateInput  # noqa: E402

EXEC: dict[str, list[dict]] = {}


class ScriptedChat(BaseChatModel):
    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)

    @property
    def _llm_type(self) -> str:
        return "probe-e2e"

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [getattr(t, "name", str(t)) for t in tools]
        self.counters["bind_tools_calls"] = int(self.counters.get("bind_tools_calls", 0)) + 1
        return self

    def _round(self):
        i = int(self.counters.get("calls", 0))
        self.counters["calls"] = i + 1
        return self.rounds[i] if i < len(self.rounds) else []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        chunks = self._round()
        merged = None
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
        self.counters["seen_messages"] = self.counters.get("seen_messages", [])
        self.counters["seen_messages"].append(list(messages))
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


def tc(call_id: str, name: str, args: dict) -> AIMessageChunk:
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


def make_tool(name: str, props: dict, result: dict | None = None):
    EXEC.setdefault(name, [])
    if len(props) == 1 and "relative_path" in props:
        def _fn(relative_path: str = "") -> str:
            EXEC[name].append({"relative_path": relative_path})
            return json.dumps(result or {"ok": True, "summary": "ok"}, ensure_ascii=False)
    elif "paths" in props and len(props) == 1:
        def _fn(paths: list | None = None) -> str:
            EXEC[name].append({"paths": paths})
            return json.dumps(result or {"ok": True, "summary": "ok"}, ensure_ascii=False)
    elif "pattern" in props:
        def _fn(pattern: str = "") -> str:
            EXEC[name].append({"pattern": pattern})
            return json.dumps(result or {"ok": True, "summary": "ok"}, ensure_ascii=False)
    else:
        def _fn(**kwargs) -> str:
            EXEC[name].append(kwargs)
            return json.dumps(result or {"ok": True, "summary": "ok"}, ensure_ascii=False)

    return StructuredTool.from_function(func=_fn, name=name, description=f"{name} stub")


async def drive(agent, ctx, text="执行任务"):
    events = [
        e
        async for e in agent.astream(
            {"messages": [HumanMessage(content=text)]},
            context=ctx,
            stream_mode=["messages", "updates"],
            version="v2",
        )
    ]
    updates = [e["data"] for e in events if isinstance(e, dict) and e.get("type") == "updates"]
    nodes = [sorted(d) for d in updates]
    tms: list[tuple[str, str]] = []
    for d in updates:
        for upd in d.values():
            if not isinstance(upd, dict):
                continue
            for m in upd.get("messages", []) or []:
                if isinstance(m, ToolMessage):
                    tms.append((m.tool_call_id, m.content))
    return events, nodes, tms


async def case(title, *, rounds, tools, ctx, max_rounds=5, states=None):
    global EXEC
    EXEC = {}
    for t in tools:
        EXEC.setdefault(t.name, [])
    mw = build_business_middleware(
        max_tool_rounds=max_rounds,
        phase_ctx=derive_task_phase(states),
    )
    brm = mw[0]
    _orig = brm.after_model

    def _traced(state, runtime, _o=_orig):
        out = _o(state, runtime)
        print(f"    [after_model] last={type(state['messages'][-1]).__name__} "
              f"-> jump_to={out.get('jump_to') if out else None!r} "
              f"end={out.get('end_after_round') if out else None!r} "
              f"ninj={len(out.get('messages', [])) if out else 0}")
        return out

    brm.after_model = _traced  # type: ignore[method-assign]

    import langchain.agents.factory as _F
    _edge_orig = _F._make_model_to_tools_edge

    def _patched(**kw):
        inner = _edge_orig(**kw)

        def wrapper(state):
            out = inner(state)
            tgt = "SEND" if isinstance(out, list) else out
            if tgt == "SEND" or tgt == "__end__":
                print(f"    [edge] jump_to={state.get('jump_to')!r} "
                      f"end_after={state.get('end_after_round')!r} -> {tgt}")
            return out
        return wrapper

    _F._make_model_to_tools_edge = _patched
    model = ScriptedChat(rounds=rounds)
    agent = create_agent(model, tools, context_schema=AgentContext, middleware=mw)
    error = None
    try:
        events, nodes, tms = await drive(agent, ctx)
    except BaseException as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        nodes, tms = [], []
    print(f"\n########## {title} ##########")
    print(f"  error          = {error}")
    print(f"  model calls    = {model.counters.get('calls')}")
    print(f"  bind_tools     = {model.counters.get('bind_tools_calls')}")
    print(f"  bound names    = {model.counters.get('bound_tool_names')}")
    print(f"  executions     = {EXEC}")
    print(f"  nodes          = {nodes}")
    print(f"  ToolMessages   = {tms}")
    for i, msgs in enumerate(model.counters.get("seen_messages", [])):
        print(f"  round{i} last3   = {[(type(m).__name__, getattr(m, 'content', '')[:60]) for m in msgs[-3:]]}")
    return {"exec": {k: list(v) for k, v in EXEC.items()}, "nodes": nodes, "tms": tms,
            "calls": model.counters.get("calls"), "error": error,
            "bound": model.counters.get("bound_tool_names")}


async def main():
    ctx = AgentContext(mode="assist", workspace_root="/w")

    # 1. 纯文本
    await case(
        "1. plain text",
        rounds=[[AIMessageChunk(content="你好")]],
        tools=[make_tool("read_workspace_file", {"relative_path": {"type": "string"}})],
        ctx=ctx,
    )

    # 2. 单个只读工具（恰好 1 次）
    await case(
        "2. single read tool",
        rounds=[
            [tc("r1", "read_workspace_file", {"relative_path": "a.md"})],
            [AIMessageChunk(content="读完了")],
        ],
        tools=[make_tool("read_workspace_file", {"relative_path": {"type": "string"}},
                         {"ok": True, "summary": "已读取 a.md"})],
        ctx=ctx,
    )

    # 3. 两并行只读（保序）
    await case(
        "3. two parallel reads",
        rounds=[
            [tc("g1", "grep_workspace", {"pattern": "TODO"}),
             tc("g2", "glob_workspace", {"pattern": "*.py"})],
            [AIMessageChunk(content="done")],
        ],
        tools=[
            make_tool("grep_workspace", {"pattern": {"type": "string"}}, {"ok": True, "summary": "grep 2"}),
            make_tool("glob_workspace", {"pattern": {"type": "string"}}, {"ok": True, "summary": "glob 3"}),
        ],
        ctx=ctx,
    )

    # 4. 混合同轮 SYNC + ASYNC
    await case(
        "4. mixed SYNC + ASYNC",
        rounds=[
            [tc("r1", "read_workspace_file", {"relative_path": "a.md"}),
             tc("a1", "auto_annotate", {"paths": ["data/1.jpg"], "all_files": False})],
            [AIMessageChunk(content="done")],
        ],
        tools=[
            make_tool("read_workspace_file", {"relative_path": {"type": "string"}}, {"ok": True, "summary": "已读取 a.md"}),
            make_tool("auto_annotate", {"paths": {"type": "array"}, "all_files": {"type": "boolean"}}),
        ],
        ctx=ctx,
    )

    # 5. 合并 coalesced
    await case(
        "5. coalesced 2x auto_annotate",
        rounds=[
            [tc("c1", "auto_annotate", {"paths": ["a.jpg"], "all_files": False, "write_mode": "append"}),
             tc("c2", "auto_annotate", {"paths": ["b.jpg"], "all_files": True, "write_mode": "replace_matching"})],
            [AIMessageChunk(content="done")],
        ],
        tools=[make_tool("auto_annotate", {"paths": {"type": "array"}, "all_files": {"type": "boolean"}, "write_mode": {"type": "string"}})],
        ctx=ctx,
    )

    # 6. 门禁 phase_blocked（await_confirm）
    states = [ProposalStateInput(path="data/1.jpg", kind="annotation", status="pending")]
    ctx_pb = AgentContext(mode="assist", workspace_root="/w",
                          task_phase_context=derive_task_phase(states))
    await case(
        "6. phase_blocked write + allowed read",
        rounds=[
            [tc("w1", "write_workspace_file", {"relative_path": "r.md", "content": "x"}),
             tc("r1", "read_workspace_file", {"relative_path": "a.md"})],
            [AIMessageChunk(content="提案待确认")],
        ],
        tools=[
            make_tool("write_workspace_file", {"relative_path": {"type": "string"}, "content": {"type": "string"}}),
            make_tool("read_workspace_file", {"relative_path": {"type": "string"}}, {"ok": True, "summary": "已读取 a.md"}),
        ],
        ctx=ctx_pb,
        states=states,
    )

    # 7. 同轮标注写 + 工作区写互斥
    states2 = [ProposalStateInput(path="data/1.jpg", kind="annotation", status="applied", annotation_ids=["x"])]
    ctx_aw = AgentContext(mode="assist", workspace_root="/w",
                          task_phase_context=derive_task_phase(states2))
    await case(
        "7. annotation-write + workspace-write same round",
        rounds=[
            [tc("w1", "write_workspace_file", {"relative_path": "r.md", "content": "x"}),
             tc("a1", "auto_annotate", {"paths": ["new.jpg"]})],
        ],
        tools=[
            make_tool("write_workspace_file", {"relative_path": {"type": "string"}, "content": {"type": "string"}}),
            make_tool("auto_annotate", {"paths": {"type": "array"}}),
        ],
        ctx=ctx_aw,
        states=states2,
    )

    # 8. 工具错误（恰好 1 次，不重试）
    EXEC = {}

    def boom(relative_path: str = "") -> str:
        EXEC.setdefault("read_workspace_file", []).append({"relative_path": relative_path})
        raise RuntimeError("磁盘炸了")

    tools8 = [StructuredTool.from_function(func=boom, name="read_workspace_file", description="x")]
    await case(
        "8. tool error (exactly once)",
        rounds=[
            [tc("e1", "read_workspace_file", {"relative_path": "a.md"})],
            [AIMessageChunk(content="读取失败")],
        ],
        tools=tools8,
        ctx=ctx,
    )

    # 9. 未知工具
    await case(
        "9. unknown tool",
        rounds=[
            [tc("u1", "memory_read", {"topic": "x"})],
            [AIMessageChunk(content="不可用")],
        ],
        tools=[make_tool("read_workspace_file", {"relative_path": {"type": "string"}})],
        ctx=ctx,
    )

    # 10. 预算耗尽 max_tool_rounds=1
    await case(
        "10. budget exhausted (max=1)",
        rounds=[
            [tc("call-1", "read_workspace_file", {"relative_path": "a.md"})],
            [tc("call-2", "read_workspace_file", {"relative_path": "a.md"})],
            [AIMessageChunk(content="预算已用完。")],
        ],
        tools=[make_tool("read_workspace_file", {"relative_path": {"type": "string"}}, {"ok": True, "summary": "已读取 a.md"})],
        ctx=ctx,
        max_rounds=1,
    )

    # 11. 兜底轮 tool_call 不执行
    await case(
        "11. wrapup tool_call ignored (max=1)",
        rounds=[
            [tc("call-1", "read_workspace_file", {"relative_path": "a.md"})],
            [tc("call-2", "read_workspace_file", {"relative_path": "a.md"})],
            [AIMessageChunk(content="预算已用完。", tool_call_chunks=[
                {"name": "read_workspace_file", "args": '{"relative_path": "b.md"}', "id": "wrapup-1", "index": 0, "type": "tool_call_chunk"}
            ])],
        ],
        tools=[make_tool("read_workspace_file", {"relative_path": {"type": "string"}}, {"ok": True, "summary": "已读取 a.md"})],
        ctx=ctx,
        max_rounds=1,
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
