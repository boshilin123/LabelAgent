"""阶段 4b 只读探针：实测 OLD 路径在「抑制 + 执行 + 挂起」共存时的**精确帧顺序**。

用途：`docs/阶段4-SSE适配设计备忘.md` §8 的集成决定要求「suppressed → execute_now →
deferred」，但 §8/§2 的散文描述与 `tool_loop.py` 的实际控制流需要逐字核对。
本探针只驱动旧路径（`stream_assist`），零写入、零网络、无真实模型。

运行：
    .venvs\\langchain-baseline\\Scripts\\python.exe experiments\\probe_stage4b_old_order.py
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain_core.messages import HumanMessage  # noqa: E402

from app.agent.assist.task_phase import derive_task_phase  # noqa: E402
from app.agent.assist_service import stream_assist  # noqa: E402
from app.schemas.agent import ClientContextInput, ProposalStateInput  # noqa: E402


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

    def bind_tools(self, tools, tool_choice=None):
        return self

    async def astream(self, messages):
        self.astream_calls += 1
        for chunk in (self._rounds.pop(0) if self._rounds else []):
            yield chunk

    async def ainvoke(self, messages):
        from langchain_core.messages import AIMessage

        return AIMessage(content="", tool_calls=[])


def make_tools(specs):
    from langchain_core.tools import StructuredTool

    executions = {name: [] for name in specs}
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
    for i, e in enumerate(events):
        payload = e.to_sse_dict()
        tag = payload.get("type")
        ident = payload.get("toolCallId") or ""
        status = ""
        if tag == "tool_result":
            try:
                status = json.loads(payload["result"]).get("status", "")
            except Exception:  # noqa: BLE001
                status = "?"
        print(f"  [{i}] {tag:14s} {ident:6s} {status}")
    print(f"  astream_calls = {llm.astream_calls}")
    return events


def tc(call_id, name, args):
    return Chunk(tool_calls=[{"id": call_id, "name": name, "args": args}])


# ── 框架侧：原始分片（轮边界 / 双源 ToolMessage / step 编号）─────────────


def _framework_probe():
    """用**已安装的** langchain/langgraph 实测候选侧原始分片形状。

    只读：不写任何生产文件；工具为内存存根。
    """
    from langchain.agents import create_agent
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, AIMessageChunk
    from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
    from langchain_core.tools import StructuredTool
    from pydantic import Field

    from app.agent.langchain_runtime.middleware import build_business_middleware

    class StreamChat(BaseChatModel):
        rounds: list = Field(default_factory=list)
        counters: dict = Field(default_factory=dict)

        @property
        def _llm_type(self) -> str:
            return "probe-stage4b"

        def bind_tools(self, tools, **kwargs):
            return self

        def _round(self):
            index = int(self.counters.get("n", 0))
            self.counters["n"] = index + 1
            if index < len(self.rounds):
                return self.rounds[index]
            return [AIMessageChunk(content="")]

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            merged = None
            for chunk in self._round():
                merged = chunk if merged is None else merged + chunk
            msg = AIMessage(
                content="" if merged is None else merged.content,
                tool_calls=[] if merged is None else list(merged.tool_calls or []),
            )
            return ChatResult(generations=[ChatGeneration(message=msg)])

        async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
            for chunk in self._round():
                yield ChatGenerationChunk(message=chunk)

    def _make(name, result, properties):
        def _fn(**kwargs):
            return json.dumps(result, ensure_ascii=False)

        return StructuredTool(
            name=name,
            description=f"{name} stub",
            func=_fn,
            args_schema={"type": "object", "properties": properties},
        )

    tools = [
        _make(
            "write_workspace_file",
            {"ok": True, "tool": "write_workspace_file", "status": "proposal_pending"},
            {"relative_path": {"type": "string"}, "content": {"type": "string"}},
        ),
        _make(
            "read_workspace_file",
            {"ok": True, "summary": "已读取 a.md"},
            {"relative_path": {"type": "string"}},
        ),
        _make(
            "auto_annotate",
            {"ok": True, "summary": "不应在后端执行"},
            {"paths": {"type": "array"}, "all_files": {"type": "boolean"}},
        ),
    ]
    rounds = [
        [
            AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": "write_workspace_file",
                        "args": '{"relative_path": "r.md", "content": "x"}',
                        "id": "w1",
                        "index": 0,
                        "type": "tool_call_chunk",
                    }
                ],
            ),
            AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": "read_workspace_file",
                        "args": '{"relative_path": "a.md"}',
                        "id": "r1",
                        "index": 1,
                        "type": "tool_call_chunk",
                    }
                ],
            ),
            AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": "auto_annotate",
                        "args": '{"paths": ["data/1.jpg"], "all_files": false}',
                        "id": "a1",
                        "index": 2,
                        "type": "tool_call_chunk",
                    }
                ],
            ),
        ],
        [AIMessageChunk(content="完成。")],
    ]
    model = StreamChat(rounds=rounds)
    middleware = build_business_middleware(max_tool_rounds=5)
    agent = create_agent(model, tools, middleware=middleware, name="probe-stage4b")

    from app.agent.assist.task_phase import derive_task_phase
    from app.schemas.agent import ProposalStateInput

    states = [ProposalStateInput(path="data/1.jpg", kind="annotation", status="pending")]
    ctx = derive_task_phase(states)

    async def _collect():
        from app.agent.langchain_runtime.runtime import AgentContext

        parts = []
        async for part in agent.astream(
            {"messages": [HumanMessage(content="执行任务")]},
            context=AgentContext(mode="assist", task_phase_context=ctx),
            stream_mode=["messages", "updates"],
            version="v2",
        ):
            parts.append(part)
        return parts

    def _msg_repr(message):
        name = type(message).__name__
        extra = ""
        if hasattr(message, "tool_call_id"):
            extra = f" tool_call_id={message.tool_call_id!r}"
            extra += f" status={getattr(message, 'status', None)!r}"
            extra += f" content={message.content!r}"
        elif hasattr(message, "tool_calls"):
            ids = [c.get("id") for c in (message.tool_calls or [])]
            extra = f" tool_calls={ids} content={message.content!r}"
        return f"{name}{extra}"

    parts = asyncio.run(_collect())
    print("\n########## FRAMEWORK raw parts ##########")
    for index, part in enumerate(parts):
        kind = part.get("type")
        data = part.get("data")
        if kind == "messages":
            message, metadata = data
            print(
                f"  [{index}] messages node={metadata.get('langgraph_node')!r} "
                f"step={metadata.get('langgraph_step')!r} ns={part.get('ns')!r} "
                f"{_msg_repr(message)}"
            )
        elif kind == "updates":
            summary = {}
            for node, update in data.items():
                messages = (update or {}).get("messages") or []
                summary[node] = [_msg_repr(m) for m in messages]
            print(f"  [{index}] updates ns={part.get('ns')!r} {summary}")
        else:
            print(f"  [{index}] {kind} {data!r}")
    return 0


async def main():
    # G. coalesced + execute_now 共存（auto_annotate x2 + read）
    tools, ex = make_tools(
        {
            "auto_annotate": {
                "properties": {
                    "paths": {"type": "array"},
                    "all_files": {"type": "boolean"},
                    "write_mode": {"type": "string"},
                }
            },
            "read_workspace_file": {
                "result": {"ok": True, "summary": "已读取 a.md"},
                "properties": {"relative_path": {"type": "string"}},
            },
        }
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "c1", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}},
                        {"id": "r1", "name": "read_workspace_file", "args": {"relative_path": "a.md"}},
                        {"id": "c2", "name": "auto_annotate", "args": {"paths": ["b.jpg"]}},
                    ]
                )
            ]
        ]
    )
    await run("G. coalesced(2nd) + read(2nd)", llm, tools)
    print(f"  executions = {ex}")

    # H. duplicate_call + execute_now 共存
    tools, ex = make_tools(
        {
            "auto_annotate": {"properties": {"paths": {"type": "array"}}},
            "read_workspace_file": {
                "result": {"ok": True, "summary": "已读取 a.md"},
                "properties": {"relative_path": {"type": "string"}},
            },
        }
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "d1", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}},
                        {"id": "r1", "name": "read_workspace_file", "args": {"relative_path": "a.md"}},
                        {"id": "d2", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}},
                    ]
                )
            ]
        ]
    )
    await run("H. duplicate(3rd) + read(2nd)", llm, tools)
    print(f"  executions = {ex}")

    # I. phase_blocked + execute_now 共存（写被门禁，读放行；顺序：读在前、写在后）
    states = [ProposalStateInput(path="data/1.jpg", kind="annotation", status="pending")]
    tools, ex = make_tools(
        {
            "write_workspace_file": {
                "properties": {"relative_path": {"type": "string"}, "content": {"type": "string"}}
            },
            "read_workspace_file": {
                "result": {"ok": True, "summary": "已读取 a.md"},
                "properties": {"relative_path": {"type": "string"}},
            },
        }
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "r1", "name": "read_workspace_file", "args": {"relative_path": "a.md"}},
                        {"id": "w1", "name": "write_workspace_file", "args": {"relative_path": "r.md", "content": "x"}},
                    ]
                )
            ]
        ]
    )
    await run("I. read(1st) + blocked-write(2nd)", llm, tools, states=states)
    print(f"  executions = {ex}")

    # I2. blocked-write 在模型序**之前**（判别 suppressed/execute_now 是否交错）
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "w1", "name": "write_workspace_file", "args": {"relative_path": "r.md", "content": "x"}},
                        {"id": "r1", "name": "read_workspace_file", "args": {"relative_path": "a.md"}},
                    ]
                )
            ]
        ]
    )
    await run("I2. blocked-write(1st) + read(2nd)", llm, tools, states=states)
    print(f"  executions = {ex}")

    # J. deferred + execute_now 共存，ASYNC 在模型序**之前**
    tools, ex = make_tools(
        {
            "auto_annotate": {"properties": {"paths": {"type": "array"}}},
            "read_workspace_file": {
                "result": {"ok": True, "summary": "已读取 a.md"},
                "properties": {"relative_path": {"type": "string"}},
            },
        }
    )
    llm = ScriptedChat(
        [
            [
                Chunk(
                    tool_calls=[
                        {"id": "a1", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}},
                        {"id": "r1", "name": "read_workspace_file", "args": {"relative_path": "a.md"}},
                    ]
                )
            ]
        ]
    )
    await run("J. async(1st) + sync(2nd)", llm, tools)
    print(f"  executions = {ex}")

    return 0


if __name__ == "__main__":
    if "--framework" in sys.argv:
        sys.exit(_framework_probe())
    sys.exit(asyncio.run(main()))
