"""测试 MCP 工具注入时的 capability 去重。"""

from app.agent.tools.mcp_client import (
    _infer_mcp_capability,
    should_expose_mcp_tool,
)
from app.agent.tools.tool_registry_meta import TOOL_CAPABILITY_MAP


def test_current_mcp_unique_tools_have_no_capability():
    """现有 MCP 工具不与 canonical 能力冲突，应全部注入。"""
    for name in (
        "memory_read",
        "memory_write",
        "memory_create",
        "read_agent_skill",
        "list_agent_skill_files",
    ):
        assert _infer_mcp_capability(name) is None


def test_infer_unknown_tool():
    assert _infer_mcp_capability("some_unknown_tool") is None


def test_all_canonical_tools_have_capability():
    from app.agent.tools.tool_registry_meta import TOOL_RUNNERS

    for name in TOOL_RUNNERS:
        assert name in TOOL_CAPABILITY_MAP, f"工具 {name} 缺少能力映射"


def test_hides_memory_tools_when_workspace_memory_disabled():
    assert not should_expose_mcp_tool(
        "memory_read", workspace_memory_enabled=False
    )
    assert not should_expose_mcp_tool(
        "memory_write", workspace_memory_enabled=False
    )
    assert not should_expose_mcp_tool(
        "memory_create", workspace_memory_enabled=False
    )
    assert should_expose_mcp_tool(
        "read_agent_skill", workspace_memory_enabled=False
    )
    assert should_expose_mcp_tool(
        "list_agent_skill_files", workspace_memory_enabled=False
    )


def test_exposes_memory_tools_when_workspace_memory_enabled():
    for name in (
        "memory_read",
        "memory_write",
        "memory_create",
        "read_agent_skill",
        "list_agent_skill_files",
    ):
        assert should_expose_mcp_tool(
            name,
            workspace_memory_enabled=True,
            agent_mode="annotation",
        )


def test_ask_mode_exposes_only_memory_read():
    assert should_expose_mcp_tool(
        "memory_read",
        workspace_memory_enabled=True,
        agent_mode="chat",
    )
    assert not should_expose_mcp_tool(
        "memory_write",
        workspace_memory_enabled=True,
        agent_mode="chat",
    )
    assert not should_expose_mcp_tool(
        "memory_create",
        workspace_memory_enabled=True,
        agent_mode=None,
    )
    assert should_expose_mcp_tool(
        "read_agent_skill",
        workspace_memory_enabled=True,
        agent_mode="chat",
    )
    assert should_expose_mcp_tool(
        "list_agent_skill_files",
        workspace_memory_enabled=True,
        agent_mode="chat",
    )
