"""同轮多工具的执行**顺序**（规格清单第 1 项）：真实记录每次调用的参数与顺序。"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field

from app.agent.langchain_runtime import AgentContext, build_business_middleware

ORDER: list[tuple[str, dict]] = []


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
        return self.rounds[i] if i < len(self.rounds) else [AIMessageChunk(content="done")]

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


def grep_tool():
    def _fn(pattern: str = "") -> str:
        ORDER.append(("grep_workspace", {"pattern": pattern}))
        return json.dumps({"ok": True, "summary": "grep 2"})
    return StructuredTool.from_function(func=_fn, name="grep_workspace", description="d")


def glob_tool():
    def _fn(pattern: str = "") -> str:
        ORDER.append(("glob_workspace", {"pattern": pattern}))
        return json.dumps({"ok": True, "summary": "glob 3"})
    return StructuredTool.from_function(func=_fn, name="glob_workspace", description="d")


def read_tool():
    def _fn(relative_path: str = "") -> str:
        ORDER.append(("read_workspace_file", {"relative_path": relative_path}))
        return json.dumps({"ok": True, "summary": "已读取"})
    return StructuredTool.from_function(func=_fn, name="read_workspace_file", description="d")


def annotate_tool():
    def _fn(paths: list | None = None, all_files: bool = False) -> str:
        ORDER.append(("auto_annotate", {"paths": paths, "all_files": all_files}))
        return json.dumps({"ok": True, "summary": "should-not-run"})
    return StructuredTool.from_function(func=_fn, name="auto_annotate", description="d")


async def run(title, tools, rounds, ctx=None):
    global ORDER
    ORDER = []
    mws = build_business_middleware(max_tool_rounds=5)
    m = M(rounds=rounds)
    ag = create_agent(m, tools, context_schema=AgentContext, middleware=mws)
    evs = [e async for e in ag.astream({"messages": [HumanMessage(content="go")]},
                                       context=ctx or AgentContext(mode="assist"),
                                       stream_mode=["messages", "updates"], version="v2")]
    tms = []
    for e in evs:
        if isinstance(e, dict) and e.get("type") == "updates":
            for v in e["data"].values():
                if isinstance(v, dict):
                    for msg in v.get("messages", []) or []:
                        if isinstance(msg, ToolMessage):
                            tms.append(msg.tool_call_id)
    print(f"\n===== {title} =====")
    print(f"  execution order = {ORDER}")
    print(f"  ToolMessage ids (stream order) = {tms}")
    print(f"  model calls     = {m.counters.get('calls')}")
    return ORDER, tms


async def main():
    # 两个并行只读：保序
    await run(
        "two parallel reads (grep then glob)",
        [grep_tool(), glob_tool()],
        [[tc("g1", "grep_workspace", {"pattern": "TODO"}),
          tc("g2", "glob_workspace", {"pattern": "*.py"})]],
    )
    # 反向：glob 在前
    await run(
        "two parallel reads (glob then grep)",
        [grep_tool(), glob_tool()],
        [[tc("g2", "glob_workspace", {"pattern": "*.py"}),
          tc("g1", "grep_workspace", {"pattern": "TODO"})]],
    )
    # 混合同轮：SYNC 在前 + ASYNC
    await run(
        "mixed: SYNC(read) then ASYNC(auto_annotate)",
        [read_tool(), annotate_tool()],
        [[tc("r1", "read_workspace_file", {"relative_path": "a.md"}),
          tc("a1", "auto_annotate", {"paths": ["data/1.jpg"], "all_files": False})]],
    )
    # 混合同轮：ASYNC 在前 + SYNC 在后
    await run(
        "mixed: ASYNC(auto_annotate) then SYNC(read)",
        [read_tool(), annotate_tool()],
        [[tc("a1", "auto_annotate", {"paths": ["data/1.jpg"], "all_files": False}),
          tc("r1", "read_workspace_file", {"relative_path": "a.md"})]],
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
