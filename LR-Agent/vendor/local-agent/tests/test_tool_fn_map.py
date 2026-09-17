"""tool_fn_map 需纳入 MCP 风格（仅 coroutine）工具。"""

import inspect
import json

from langchain_core.tools import StructuredTool

from app.agent.tools.registry import tool_fn_map
from app.agent.tools.tool_result import stringify_tool_output


def test_tool_fn_map_keeps_sync_func() -> None:
    def ping(x: str = "") -> str:
        return f"pong:{x}"

    tool = StructuredTool.from_function(func=ping, name="ping", description="ping")
    mapping = tool_fn_map([tool])
    assert mapping["ping"] is ping
    assert mapping["ping"](x="a") == "pong:a"


def test_tool_fn_map_includes_coroutine_only_tool() -> None:
    async def memory_create(topic_file: str, content: str, index_line: str) -> str:
        return json.dumps({"ok": True, "topic_file": topic_file})

    tool = StructuredTool(
        name="memory_create",
        description="create topic",
        coroutine=memory_create,
        args_schema={
            "type": "object",
            "properties": {
                "topic_file": {"type": "string"},
                "content": {"type": "string"},
                "index_line": {"type": "string"},
            },
        },
    )
    mapping = tool_fn_map([tool])
    assert "memory_create" in mapping
    assert inspect.iscoroutinefunction(mapping["memory_create"])


async def test_coroutine_only_tool_ainvoke_via_fn_map() -> None:
    async def memory_create(topic_file: str, content: str, index_line: str) -> str:
        return json.dumps(
            {"ok": True, "created": True, "topic_file": topic_file},
            ensure_ascii=False,
        )

    tool = StructuredTool(
        name="memory_create",
        description="create topic",
        coroutine=memory_create,
        args_schema={
            "type": "object",
            "properties": {
                "topic_file": {"type": "string"},
                "content": {"type": "string"},
                "index_line": {"type": "string"},
            },
        },
    )
    fn = tool_fn_map([tool])["memory_create"]
    result = await fn(
        topic_file="annotated-files.md",
        content="# x",
        index_line="- [已标文件](topics/annotated-files.md)",
    )
    text = stringify_tool_output(result)
    assert "未知工具" not in text
    payload = json.loads(text)
    assert payload["ok"] is True
    assert payload["topic_file"] == "annotated-files.md"


def test_stringify_tool_output_unwraps_content_blocks() -> None:
    from langchain_core.messages import ToolMessage

    blocks = [{"type": "text", "text": '{"ok": true, "created": true}'}]
    assert stringify_tool_output((blocks, {"structured_content": {}})) == (
        '{"ok": true, "created": true}'
    )
    assert stringify_tool_output(blocks) == '{"ok": true, "created": true}'
    assert stringify_tool_output("plain") == "plain"
    assert stringify_tool_output(None) == ""
    assert (
        stringify_tool_output(ToolMessage(content='{"ok": true}', tool_call_id="c1"))
        == '{"ok": true}'
    )


async def test_coroutine_content_and_artifact_via_fn_map() -> None:
    """贴近 MCP 适配器：coroutine 返回 (content_blocks, artifact)。"""

    async def memory_create(topic_file: str, content: str, index_line: str):
        payload = json.dumps(
            {"ok": True, "created": True, "topic_file": topic_file},
            ensure_ascii=False,
        )
        return ([{"type": "text", "text": payload}], {"structured_content": None})

    tool = StructuredTool(
        name="memory_create",
        description="create topic",
        coroutine=memory_create,
        args_schema={
            "type": "object",
            "properties": {
                "topic_file": {"type": "string"},
                "content": {"type": "string"},
                "index_line": {"type": "string"},
            },
        },
        response_format="content_and_artifact",
    )
    fn = tool_fn_map([tool])["memory_create"]
    result = await fn(
        topic_file="annotated-files.md",
        content="# x",
        index_line="- [已标文件](topics/annotated-files.md)",
    )
    payload = json.loads(stringify_tool_output(result))
    assert payload["ok"] is True
    assert payload["topic_file"] == "annotated-files.md"
