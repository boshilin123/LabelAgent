"""只读子代理：内层白名单、取消、轮次封顶。"""

from types import SimpleNamespace

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool

from app.agent.assist.explore_readonly import (
    EXPLORE_READONLY_FORBIDDEN_INNER,
    EXPLORE_READONLY_TOOL_NAME,
    ExploreReadonlyRunner,
    filter_explore_inner_fn_map,
    filter_explore_inner_tools,
    resolve_explore_inner_names,
    should_include_annotation_reads,
)
from app.agent.assist_service import stream_assist
from app.schemas.agent import ClientContextInput


def _tool(name: str) -> StructuredTool:
    return StructuredTool.from_function(
        func=lambda **_kwargs: f"ok:{name}",
        name=name,
        description=name,
    )


class MockChunk:
    def __init__(self, content="", tool_calls=None):
        self.content = content
        self.tool_call_chunks = []
        self.tool_calls = tool_calls
        self.additional_kwargs = {}

    def __add__(self, other):
        merged = (self.tool_calls or []) + (other.tool_calls or [])
        return MockChunk(
            content=(self.content or "") + (other.content or ""),
            tool_calls=merged,
        )


class SequenceLLM:
    def __init__(self, tool_rounds: int, summary: str = "这是查阅摘要"):
        self.tool_rounds = tool_rounds
        self.summary = summary
        self.calls = 0

    def bind_tools(self, tools, tool_choice=None):
        return self

    async def astream(self, messages):
        self.calls += 1
        if self.calls <= self.tool_rounds:
            yield MockChunk(
                tool_calls=[
                    {
                        "id": f"inner-{self.calls}",
                        "name": "grep_workspace",
                        "args": {"pattern": "Foo"},
                    }
                ]
            )
            return
        yield MockChunk(content=self.summary)


async def _never_cancel() -> bool:
    return False


def test_inner_names_exclude_writes_and_self():
    names = resolve_explore_inner_names(include_annotation_reads=True)
    assert EXPLORE_READONLY_TOOL_NAME not in names
    for forbidden in EXPLORE_READONLY_FORBIDDEN_INNER:
        assert forbidden not in names
    assert "grep_workspace" in names
    assert "read_file_annotation" in names


def test_editor_context_excludes_annotation_reads():
    ctx = ClientContextInput(workspace_root="/ws", work_mode="editor")
    parent = [
        _tool("grep_workspace"),
        _tool("read_file_annotation"),
        _tool("describe_annotation_project"),
        _tool("explore_readonly"),
        _tool("write_workspace_file"),
    ]
    assert should_include_annotation_reads(ctx, parent) is False
    inner = filter_explore_inner_tools(parent, include_annotation_reads=False)
    names = {tool.name for tool in inner}
    assert "read_file_annotation" not in names
    assert "describe_annotation_project" not in names
    assert "write_workspace_file" not in names
    assert EXPLORE_READONLY_TOOL_NAME not in names
    assert "grep_workspace" in names


def test_annotation_context_keeps_read_tools():
    ctx = ClientContextInput(workspace_root="/ws", work_mode="annotation")
    parent = [
        _tool("grep_workspace"),
        _tool("read_file_annotation"),
        _tool("auto_annotate"),
        _tool("explore_readonly"),
    ]
    assert should_include_annotation_reads(ctx, parent) is True
    fn_map = filter_explore_inner_fn_map(
        {
            "grep_workspace": lambda: "ok",
            "read_file_annotation": lambda: "ann",
            "auto_annotate": lambda: "no",
            "explore_readonly": lambda: "no",
            "memory_write": lambda: "no",
        },
        include_annotation_reads=True,
    )
    assert "read_file_annotation" in fn_map
    assert "auto_annotate" not in fn_map
    assert "explore_readonly" not in fn_map
    assert "memory_write" not in fn_map


@pytest.mark.asyncio
async def test_cancel_stops_inner_loop():
    async def cancel() -> bool:
        return True

    runner = ExploreReadonlyRunner(
        llm=SequenceLLM(tool_rounds=4),
        settings=SimpleNamespace(agent_subagent_max_tool_rounds=8),
        is_cancelled=cancel,
        parent_tools=[_tool("grep_workspace")],
        parent_fn_map={"grep_workspace": lambda pattern="": "hit"},
        client_context=None,
    )
    events = [
        event
        async for event in runner.stream(
            query="找 Foo",
            focus_path=None,
            parent_tool_id="parent-1",
        )
    ]
    types = [event.type for event in events]
    assert types[0] == "subagent_start"
    assert types[-1] == "subagent_done"
    assert events[-1].status == "error"
    assert "停止" in (events[-1].summary or "")
    assert "subagent_tool_start" not in types


@pytest.mark.asyncio
async def test_max_rounds_still_returns_summary():
    calls = {"n": 0}

    def grep(pattern=""):
        calls["n"] += 1
        return f"hit:{pattern}"

    runner = ExploreReadonlyRunner(
        llm=SequenceLLM(tool_rounds=8, summary="轮次用尽后的摘要"),
        settings=SimpleNamespace(agent_subagent_max_tool_rounds=8),
        is_cancelled=_never_cancel,
        parent_tools=[_tool("grep_workspace")],
        parent_fn_map={"grep_workspace": grep},
        client_context=None,
    )
    events = [
        event
        async for event in runner.stream(
            query="大范围摸底",
            focus_path="src",
            parent_tool_id="parent-2",
        )
    ]
    assert calls["n"] == 8
    done = [event for event in events if event.type == "subagent_done"]
    assert len(done) == 1
    assert done[0].status == "done"
    assert "摘要" in (done[0].summary or "")
    starts = [event for event in events if event.type == "subagent_tool_start"]
    assert len(starts) == 8


@pytest.mark.asyncio
async def test_missing_tool_call_id_is_aligned():
    captured: dict = {}

    class NoIdLLM:
        def __init__(self):
            self.calls = 0

        def bind_tools(self, tools, tool_choice=None):
            return self

        async def astream(self, messages):
            self.calls += 1
            if self.calls == 1:
                yield MockChunk(
                    tool_calls=[
                        {"name": "grep_workspace", "args": {"pattern": "X"}}
                    ]
                )
                return
            ai = [m for m in messages if getattr(m, "tool_calls", None)]
            tools = [m for m in messages if isinstance(m, ToolMessage)]
            captured["ai_ids"] = [c.get("id") for c in ai[-1].tool_calls]
            captured["tool_ids"] = [m.tool_call_id for m in tools]
            yield MockChunk(content="对齐后的摘要")

    runner = ExploreReadonlyRunner(
        llm=NoIdLLM(),
        settings=SimpleNamespace(agent_subagent_max_tool_rounds=8),
        is_cancelled=_never_cancel,
        parent_tools=[_tool("grep_workspace")],
        parent_fn_map={"grep_workspace": lambda pattern="": "hit"},
        client_context=None,
    )
    events = [
        event
        async for event in runner.stream(
            query="缺 id",
            focus_path=None,
            parent_tool_id="parent-3",
        )
    ]
    assert captured["ai_ids"]
    assert captured["ai_ids"] == captured["tool_ids"]
    assert all(captured["ai_ids"])
    assert any(event.type == "subagent_done" and event.status == "done" for event in events)


@pytest.mark.asyncio
async def test_forbidden_inner_tools_are_not_invoked():
    counts = {"write": 0, "self": 0, "memory": 0, "grep": 0}

    class ForbiddenLLM:
        def __init__(self):
            self.calls = 0

        def bind_tools(self, tools, tool_choice=None):
            return self

        async def astream(self, messages):
            self.calls += 1
            if self.calls == 1:
                yield MockChunk(
                    tool_calls=[
                        {
                            "id": "w1",
                            "name": "write_workspace_file",
                            "args": {"relative_path": "a.py"},
                        },
                        {
                            "id": "e1",
                            "name": "explore_readonly",
                            "args": {"query": "x"},
                        },
                        {
                            "id": "m1",
                            "name": "memory_write",
                            "args": {"name": "x"},
                        },
                    ]
                )
                return
            yield MockChunk(content="已拦截写入")

    runner = ExploreReadonlyRunner(
        llm=ForbiddenLLM(),
        settings=SimpleNamespace(agent_subagent_max_tool_rounds=8),
        is_cancelled=_never_cancel,
        parent_tools=[
            _tool("grep_workspace"),
            _tool("write_workspace_file"),
            _tool("explore_readonly"),
        ],
        parent_fn_map={
            "grep_workspace": lambda **_: counts.__setitem__("grep", counts["grep"] + 1) or "ok",
            "write_workspace_file": lambda **_: counts.__setitem__("write", counts["write"] + 1) or "no",
            "explore_readonly": lambda **_: counts.__setitem__("self", counts["self"] + 1) or "no",
            "memory_write": lambda **_: counts.__setitem__("memory", counts["memory"] + 1) or "no",
        },
        client_context=None,
    )
    events = [
        event
        async for event in runner.stream(
            query="不要写",
            focus_path=None,
            parent_tool_id="parent-4",
        )
    ]
    assert counts["write"] == 0
    assert counts["self"] == 0
    assert counts["memory"] == 0
    blocked = [event for event in events if event.type == "subagent_tool_result"]
    assert len(blocked) == 3
    assert all("不可用于只读查阅" in (event.result or "") for event in blocked)


@pytest.mark.asyncio
async def test_streams_text_delta_before_and_after_tools():
    class NarratingLLM:
        def __init__(self):
            self.calls = 0

        def bind_tools(self, tools, tool_choice=None):
            return self

        async def astream(self, messages):
            self.calls += 1
            if self.calls == 1:
                yield MockChunk(content="先看")
                yield MockChunk(content="路由")
                yield MockChunk(
                    tool_calls=[
                        {
                            "id": "g1",
                            "name": "grep_workspace",
                            "args": {"pattern": "route"},
                        }
                    ]
                )
                return
            yield MockChunk(content="结")
            yield MockChunk(content="论")

    runner = ExploreReadonlyRunner(
        llm=NarratingLLM(),
        settings=SimpleNamespace(agent_subagent_max_tool_rounds=8),
        is_cancelled=_never_cancel,
        parent_tools=[_tool("grep_workspace")],
        parent_fn_map={"grep_workspace": lambda pattern="": "hit"},
        client_context=None,
    )
    events = [
        event
        async for event in runner.stream(
            query="查路由",
            focus_path=None,
            parent_tool_id="parent-5",
        )
    ]
    types = [event.type for event in events]
    assert types.index("subagent_text_delta") < types.index("subagent_tool_start")
    deltas = [event.content for event in events if event.type == "subagent_text_delta"]
    assert deltas == ["先看", "路由", "结", "论"]
    done = [event for event in events if event.type == "subagent_done"]
    assert len(done) == 1
    assert done[0].summary == "结论"


@pytest.mark.asyncio
async def test_stream_assist_routes_subagent_to_aux_llm():
    """配置了辅助模型时，explore_readonly 子代理走 aux_llm 而非主模型。"""

    class ParentLLM:
        def __init__(self):
            self.calls = 0

        def bind_tools(self, tools, tool_choice=None):
            return self

        async def astream(self, messages):
            self.calls += 1
            if self.calls == 1:
                yield MockChunk(
                    tool_calls=[
                        {
                            "id": "x1",
                            "name": EXPLORE_READONLY_TOOL_NAME,
                            "args": {"query": "找 Foo"},
                        }
                    ]
                )
                return
            yield MockChunk(content="完成")

    aux = SequenceLLM(tool_rounds=0, summary="查阅摘要")
    parent = ParentLLM()
    events = [
        event
        async for event in stream_assist(
            parent,
            [HumanMessage(content="查一下")],
            [_tool(EXPLORE_READONLY_TOOL_NAME), _tool("grep_workspace")],
            settings=SimpleNamespace(agent_subagent_max_tool_rounds=8),
            max_tool_rounds=5,
            is_cancelled=_never_cancel,
            client_context=ClientContextInput(workspace_root="/ws"),
            user_content="查一下",
            aux_llm=aux,  # type: ignore[arg-type]
        )
    ]
    assert aux.calls == 1
    assert parent.calls == 2
    assert any(
        event.type == "subagent_done" and event.status == "done" for event in events
    )


@pytest.mark.asyncio
async def test_stream_assist_subagent_falls_back_to_parent_llm():
    """未配置辅助模型时，子代理回退为父会话 LLM。"""

    class ParentLLM:
        def __init__(self):
            self.calls = 0

        def bind_tools(self, tools, tool_choice=None):
            return self

        async def astream(self, messages):
            self.calls += 1
            if self.calls == 1:
                yield MockChunk(
                    tool_calls=[
                        {
                            "id": "x1",
                            "name": EXPLORE_READONLY_TOOL_NAME,
                            "args": {"query": "找 Foo"},
                        }
                    ]
                )
                return
            yield MockChunk(content="完成")

    parent = ParentLLM()
    events = [
        event
        async for event in stream_assist(
            parent,
            [HumanMessage(content="查一下")],
            [_tool(EXPLORE_READONLY_TOOL_NAME), _tool("grep_workspace")],
            settings=SimpleNamespace(agent_subagent_max_tool_rounds=8),
            max_tool_rounds=5,
            is_cancelled=_never_cancel,
            client_context=ClientContextInput(workspace_root="/ws"),
            user_content="查一下",
        )
    ]
    # 父 LLM 既跑主循环也跑子代理内层循环
    assert parent.calls == 3
    assert any(
        event.type == "subagent_done" and event.status == "done" for event in events
    )
