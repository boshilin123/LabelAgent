"""阶段 2 对照探针：实测 OLD 路径在「合并 / 去重 / 门禁 / 混合同轮」下的**精确**输出。

用途：规格 §2 给出的是行号级描述；实现前需要拿到可逐字对照的事实
（事件序列 + to_sse_dict 载荷 + 真实执行次数 + 注入内容的 display 规则）。

运行：
    .venvs\\langchain-migration\\Scripts\\python.exe experiments\\compare_stage2_old_suppression.py

只读旧路径，不修改任何生产文件。
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain_core.messages import HumanMessage, ToolMessage  # noqa: E402

from app.agent.assist.task_phase import derive_task_phase
from app.agent.assist_service import stream_assist
from app.schemas.agent import ClientContextInput, ProposalStateInput


class Chunk:
    def __init__(self, content="", tool_calls=None, tool_call_chunks=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.tool_call_chunks = tool_call_chunks or []
        self.additional_kwargs = {}

    def __add__(self, other):
        return Chunk(
            content=(self.content or "") + (other.content or ""),
            tool_calls=list(self.tool_calls) + list(other.tool_calls),
            tool_call_chunks=list(self.tool_call_chunks) + list(other.tool_call_chunks),
        )


class ScriptedChat:
    def __init__(self, rounds):
        self._rounds = list(rounds)
        self.astream_calls = 0
        self.bind_tools_calls = 0
        self.bound_tool_names: list[str] = []
        self.seen_messages: list[list] = []

    def bind_tools(self, tools, tool_choice=None):
        self.bind_tools_calls += 1
        self.bound_tool_names = [getattr(t, "name", str(t)) for t in tools]
        return self

    async def astream(self, messages):
        self.astream_calls += 1
        self.seen_messages.append(list(messages))
        for chunk in (self._rounds.pop(0) if self._rounds else []):
            yield chunk

    async def ainvoke(self, messages):
        from langchain_core.messages import AIMessage

        return AIMessage(content="", tool_calls=[])


def make_tools(specs):
    from langchain_core.tools import StructuredTool

    executions: dict[str, list[dict]] = {name: [] for name in specs}
    tools = []
    for name, spec in specs.items():
        def _make(tool_name=name, tool_spec=spec):
            def _fn(**kwargs):
                executions[tool_name].append(kwargs)
                return json.dumps(
                    tool_spec.get("result", {"ok": True, "summary": f"{tool_name} ok"}),
                    ensure_ascii=False,
                )

            return _fn

        tools.append(
            StructuredTool(
                name=name,
                description=f"{name} stub",
                func=_make(),
                args_schema={"type": "object", "properties": spec.get("properties") or {}},
            )
        )
    return tools, executions


async def _never_cancel():
    return False


async def run(title, llm, tools, *, states=None, max_tool_rounds=5):
    ctx = derive_task_phase(states) if states else None
    cc_kwargs = {"workspace_root": "/w"}
    if states:
        cc_kwargs["proposal_states"] = states
    events = [
        e
        async for e in stream_assist(
            llm,
            [HumanMessage(content="执行任务")],
            tools,
            settings=None,
            max_tool_rounds=max_tool_rounds,
            is_cancelled=_never_cancel,
            client_context=ClientContextInput(**cc_kwargs),
            user_content="执行任务",
            task_phase_ctx=ctx,
        )
    ]
    print(f"\n########## {title} ##########")
    print(f"  event types   = {[e.type for e in events]}")
    for i, e in enumerate(events):
        print(f"  [{i}] {json.dumps(e.to_sse_dict(), ensure_ascii=False)}")
    print(f"  astream_calls = {llm.astream_calls}")
    for i, msgs in enumerate(llm.seen_messages):
        tms = [m for m in msgs if isinstance(m, ToolMessage)]
        print(f"  round{i} ToolMessages = "
              f"{[(m.tool_call_id, m.content) for m in tms]}")
    return events


def tc(call_id, name, args):
    return Chunk(tool_calls=[{"id": call_id, "name": name, "args": args}])


async def main():
    # ── A. 同轮两个 auto_annotate（合并 coalesced）──────────────
    tools, ex = make_tools(
        {
            "auto_annotate": {"properties": {"paths": {"type": "array"}, "all_files": {"type": "boolean"}, "write_mode": {"type": "string"}}},
        }
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "c1", "name": "auto_annotate", "args": {"paths": ["a.jpg"], "all_files": False, "write_mode": "append"}},
                        {"id": "c2", "name": "auto_annotate", "args": {"paths": ["b.jpg"], "all_files": True, "write_mode": "replace_matching"}},
                    ]
                )
            ]
        ]
    )
    await run("A. coalesced (2x auto_annotate)", llm, tools)
    print(f"  executions = {ex}")

    # ── B. 同范围重复（duplicate_call）───────────────────────────
    tools, ex = make_tools(
        {"auto_annotate": {"properties": {"paths": {"type": "array"}}}}
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "d1", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}},
                        {"id": "d2", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}},
                    ]
                )
            ]
        ]
    )
    await run("B. duplicate_call (same scope)", llm, tools)
    print(f"  executions = {ex}")

    # ── C. 门禁 phase_blocked（await_confirm）───────────────────
    states = [
        ProposalStateInput(path="data/1.jpg", kind="annotation", status="pending")
    ]
    tools, ex = make_tools(
        {
            "write_workspace_file": {
                "properties": {"relative_path": {"type": "string"}, "content": {"type": "string"}}
            },
            "read_workspace_file": {"properties": {"relative_path": {"type": "string"}}},
        }
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "w1", "name": "write_workspace_file", "args": {"relative_path": "r.md", "content": "x"}},
                        {"id": "r1", "name": "read_workspace_file", "args": {"relative_path": "a.md"}},
                    ]
                )
            ],
            [Chunk(content="提案待确认。")],
        ]
    )
    await run("C. phase_blocked (await_confirm: write banned, read allowed)", llm, tools, states=states)
    print(f"  executions = {ex}")

    # ── D. 同轮 标注写 + 工作区写（同轮互斥）────────────────────
    states = [
        ProposalStateInput(path="data/1.jpg", kind="annotation", status="applied", annotation_ids=["x"])
    ]
    tools, ex = make_tools(
        {
            "auto_annotate": {"properties": {"paths": {"type": "array"}}},
            "write_workspace_file": {
                "properties": {"relative_path": {"type": "string"}, "content": {"type": "string"}}
            },
        }
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "w1", "name": "write_workspace_file", "args": {"relative_path": "r.md", "content": "x"}},
                        {"id": "a1", "name": "auto_annotate", "args": {"paths": ["new.jpg"]}},
                    ]
                )
            ]
        ]
    )
    await run("D. annotation-write + workspace-write same round", llm, tools, states=states)
    print(f"  executions = {ex}")

    # ── E. 混合同轮 SYNC + ASYNC（无提案状态，零门禁）───────────
    tools, ex = make_tools(
        {
            "read_workspace_file": {"result": {"ok": True, "summary": "已读取 a.md"}, "properties": {"relative_path": {"type": "string"}}},
            "auto_annotate": {"properties": {"paths": {"type": "array"}, "all_files": {"type": "boolean"}}},
        }
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "r1", "name": "read_workspace_file", "args": {"relative_path": "a.md"}},
                        {"id": "a1", "name": "auto_annotate", "args": {"paths": ["data/1.jpg"], "all_files": False}},
                    ]
                )
            ]
        ]
    )
    await run("E. mixed SYNC + ASYNC", llm, tools)
    print(f"  executions = {ex}")

    # ── F. 反向顺序：ASYNC 在前、SYNC 在后 ──────────────────────
    tools, ex = make_tools(
        {
            "read_workspace_file": {"result": {"ok": True, "summary": "已读取 a.md"}, "properties": {"relative_path": {"type": "string"}}},
            "auto_annotate": {"properties": {"paths": {"type": "array"}}},
        }
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "a1", "name": "auto_annotate", "args": {"paths": ["data/1.jpg"]}},
                        {"id": "r1", "name": "read_workspace_file", "args": {"relative_path": "a.md"}},
                    ]
                )
            ]
        ]
    )
    await run("F. mixed ASYNC then SYNC", llm, tools)
    print(f"  executions = {ex}")

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
