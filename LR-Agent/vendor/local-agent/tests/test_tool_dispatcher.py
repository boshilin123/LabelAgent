import json

from app.agent.tool_dispatcher import resolve_round_tool_calls, split_resolved_calls
from app.agent.tool_invocation import normalize_api_tool_calls
from app.agent.tools.tool_registry_meta import ToolRunner, get_tool_runner


def test_get_tool_runner_write_is_proposal() -> None:
    assert get_tool_runner("write_workspace_file") is ToolRunner.PROPOSAL


def test_get_tool_runner_batch_is_async() -> None:
    assert get_tool_runner("auto_annotate") is ToolRunner.ASYNC


def test_get_tool_runner_terminal_is_async() -> None:
    """本地 MCP 的 start_terminal_command 必须走 ASYNC（批准后前端执行）"""
    assert get_tool_runner("start_terminal_command") is ToolRunner.ASYNC


def test_split_terminal_command_goes_async_pending() -> None:
    from app.agent.tool_invocation import ResolvedToolCall

    calls = [
        ResolvedToolCall(
            "t9",
            "start_terminal_command",
            {"command": "git", "args": ["status"]},
            "api",
        ),
    ]
    split = split_resolved_calls(calls)
    assert len(split.async_pending) == 1
    assert split.async_pending[0].name == "start_terminal_command"
    assert split.async_pending[0].arguments["command"] == "git"


def test_resolve_api_only_tool_calls() -> None:
    api = [{"id": "t1", "name": "auto_annotate", "args": {"user_request": "标注"}}]
    calls = resolve_round_tool_calls(api_tool_calls=api)
    assert len(calls) == 1
    assert calls[0].name == "auto_annotate"
    assert calls[0].source == "api"


def test_resolve_empty_api_returns_empty() -> None:
    calls = resolve_round_tool_calls(api_tool_calls=[])
    assert calls == []


def test_resolve_skips_completed() -> None:
    api = [{"id": "t1", "name": "auto_annotate", "args": {}}]
    calls = resolve_round_tool_calls(
        api_tool_calls=api,
        completed_tools=frozenset({"t1"}),
    )
    assert calls == []


def test_resolve_allows_same_name_new_id() -> None:
    api = [{"id": "t2", "name": "auto_annotate", "args": {"user_request": "再标"}}]
    calls = resolve_round_tool_calls(
        api_tool_calls=api,
        completed_tools=frozenset({"t1"}),
    )
    assert len(calls) == 1
    assert calls[0].tool_call_id == "t2"


def test_split_immediate_and_async() -> None:
    from app.agent.tool_invocation import ResolvedToolCall

    calls = [
        ResolvedToolCall("t1", "write_workspace_file", {"relative_path": "a.md", "content": "x"}, "api"),
        ResolvedToolCall("t2", "auto_annotate", {"user_request": "标注"}, "api"),
    ]
    split = split_resolved_calls(calls)
    assert len(split.immediate) == 1
    assert split.immediate[0].name == "write_workspace_file"
    assert len(split.async_pending) == 1
    assert split.async_pending[0].name == "auto_annotate"


def test_build_tool_result_shape() -> None:
    from app.agent.tools.tool_result import build_tool_result, parse_tool_result

    raw = build_tool_result(
        ok=True,
        tool="write_workspace_file",
        status="proposal_ready",
        summary="提案已生成",
        proposal_pending=True,
    )
    data = parse_tool_result(raw)
    assert data is not None
    assert data["ok"] is True
    assert data["proposal_pending"] is True
    assert json.loads(raw)["tool"] == "write_workspace_file"
