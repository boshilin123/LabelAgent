"""多 MCP Server（本机 + 远程）加载：连接参数、失败隔离、去重与 probe。"""

import asyncio

import pytest
from langchain_core.tools import StructuredTool

pytest.importorskip("langchain_mcp_adapters")

from app.agent.tools import mcp_client  # noqa: E402
from app.agent.tools.tool_registry_meta import ToolCapability  # noqa: E402


class _FakeClient:
    """替代 MultiServerMCPClient：记录连接参数，按 server 名返回预设工具。"""

    instances: list["_FakeClient"] = []
    fail_on: set[str] = set()
    tools_by_server: dict[str, list[StructuredTool]] = {}

    def __init__(self, connections):
        self.connections = connections
        type(self).instances.append(self)

    async def get_tools(self):
        name = next(iter(self.connections))
        if name in type(self).fail_on:
            raise RuntimeError("connect failed")
        return list(type(self).tools_by_server.get(name, []))


def _tool(name: str) -> StructuredTool:
    return StructuredTool.from_function(func=lambda: "ok", name=name, description="t")


class _Server:
    """模拟 schemas.agent.McpServerInput 的属性访问。"""

    def __init__(self, id, url, transport="streamable_http", headers=None, disabled_tools=None):
        self.id = id
        self.url = url
        self.transport = transport
        self.headers = headers or {}
        self.disabled_tools = disabled_tools or []


@pytest.fixture(autouse=True)
def _patch_client(monkeypatch):
    _FakeClient.instances = []
    _FakeClient.fail_on = set()
    _FakeClient.tools_by_server = {}
    mcp_client.clear_mcp_tools_cache()
    monkeypatch.setattr(
        "langchain_mcp_adapters.client.MultiServerMCPClient",
        _FakeClient,
    )
    yield
    mcp_client.clear_mcp_tools_cache()


async def test_local_url_appends_mcp_endpoint():
    await mcp_client.load_mcp_tools_from_servers("http://127.0.0.1:9000", [])
    conn = _FakeClient.instances[0].connections["lr-agent-local"]
    assert conn["url"] == "http://127.0.0.1:9000/mcp"
    assert conn["transport"] == "streamable_http"


async def test_remote_url_used_verbatim_with_sse_and_headers():
    servers = [
        _Server(
            "tavily",
            "https://mcp.tavily.com/mcp",
            "sse",
            {"Authorization": "Bearer k"},
        )
    ]
    await mcp_client.load_mcp_tools_from_servers(None, servers)
    conn = _FakeClient.instances[0].connections["mcp-remote-tavily"]
    # 远程 URL 原样使用，不拼 /mcp
    assert conn["url"] == "https://mcp.tavily.com/mcp"
    assert conn["transport"] == "sse"
    assert conn["headers"] == {"Authorization": "Bearer k"}


async def test_remote_invalid_transport_falls_back():
    servers = [_Server("a", "https://a.example.com/mcp", "stdio")]
    await mcp_client.load_mcp_tools_from_servers(None, servers)
    conn = _FakeClient.instances[0].connections["mcp-remote-a"]
    assert conn["transport"] == "streamable_http"


async def test_failing_server_does_not_block_others():
    _FakeClient.fail_on.add("lr-agent-local")
    _FakeClient.tools_by_server["mcp-remote-tavily"] = [_tool("tavily_search")]
    servers = [_Server("tavily", "https://mcp.tavily.com/mcp")]
    tools = await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", servers
    )
    assert [t.name for t in tools] == ["tavily_search"]


async def test_duplicate_tool_names_across_servers_skipped():
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("shared")]
    _FakeClient.tools_by_server["mcp-remote-a"] = [_tool("shared"), _tool("other")]
    servers = [_Server("a", "https://a.example.com/mcp")]
    tools = await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", servers
    )
    assert [t.name for t in tools] == ["shared", "other"]


async def test_capability_conflict_skipped(monkeypatch):
    """远程工具若推断出与 canonical 相同能力，应被去重跳过。"""
    monkeypatch.setattr(
        mcp_client,
        "_infer_mcp_capability",
        lambda name: (
            ToolCapability.READ_TEXT_FILE if name == "shadow_read" else None
        ),
    )
    _FakeClient.tools_by_server["mcp-remote-a"] = [
        _tool("shadow_read"),
        _tool("fine"),
    ]
    servers = [_Server("a", "https://a.example.com/mcp")]
    tools = await mcp_client.load_mcp_tools_from_servers(None, servers)
    assert [t.name for t in tools] == ["fine"]


async def test_no_servers_returns_empty():
    assert await mcp_client.load_mcp_tools_from_servers(None, []) == []
    assert _FakeClient.instances == []


async def test_backward_compat_single_local_loader():
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_read")]
    tools = await mcp_client.load_mcp_tools_from_server("http://127.0.0.1:9000/")
    assert [t.name for t in tools] == ["memory_read"]
    assert _FakeClient.instances[0].connections["lr-agent-local"]["url"].endswith(
        "/mcp"
    )


async def test_probe_passes_transport_and_headers():
    _FakeClient.tools_by_server["mcp-probe"] = [_tool("x")]
    tools = await mcp_client.probe_mcp_tools(
        "https://x.example.com/mcp",
        transport="sse",
        headers={"Authorization": "Bearer k"},
    )
    conn = _FakeClient.instances[0].connections["mcp-probe"]
    assert conn["url"] == "https://x.example.com/mcp"
    assert conn["transport"] == "sse"
    assert conn["headers"]["Authorization"] == "Bearer k"
    assert [t.name for t in tools] == ["x"]


async def test_disabled_tools_are_filtered_before_dedup():
    _FakeClient.tools_by_server["mcp-remote-tavily"] = [
        _tool("tavily_search"),
        _tool("tavily_crawl"),
    ]
    servers = [
        _Server(
            "tavily",
            "https://mcp.tavily.com/mcp",
            disabled_tools=["tavily_crawl"],
        )
    ]
    tools = await mcp_client.load_mcp_tools_from_servers(None, servers)
    assert [t.name for t in tools] == ["tavily_search"]


# ── 工具发现 TTL 缓存 ────────────────────────────────────────────────


async def test_cache_hit_skips_second_discovery():
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_read")]
    first = await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", []
    )
    assert len(_FakeClient.instances) == 1
    second = await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", []
    )
    # 命中缓存：不重新建连
    assert len(_FakeClient.instances) == 1
    assert [t.name for t in first] == ["memory_read"]
    assert [t.name for t in second] == ["memory_read"]


async def test_ttl_zero_bypasses_cache():
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_read")]
    await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", [], ttl_seconds=0
    )
    await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", [], ttl_seconds=0
    )
    assert len(_FakeClient.instances) == 2


async def test_different_headers_discover_separately():
    _FakeClient.tools_by_server["mcp-remote-a"] = [_tool("tool_a")]
    await mcp_client.load_mcp_tools_from_servers(
        None, [_Server("a", "https://a.example.com/mcp", headers={"K": "1"})]
    )
    await mcp_client.load_mcp_tools_from_servers(
        None, [_Server("a", "https://a.example.com/mcp", headers={"K": "2"})]
    )
    assert len(_FakeClient.instances) == 2


async def test_disabled_tools_filter_applies_to_cached_result():
    """缓存存原始发现结果：运行时改 disabled_tools 立即生效，无需重新建连。"""
    _FakeClient.tools_by_server["mcp-remote-a"] = [
        _tool("tool_a"),
        _tool("tool_b"),
    ]
    tools_all = await mcp_client.load_mcp_tools_from_servers(
        None, [_Server("a", "https://a.example.com/mcp")]
    )
    assert [t.name for t in tools_all] == ["tool_a", "tool_b"]
    tools_filtered = await mcp_client.load_mcp_tools_from_servers(
        None,
        [_Server("a", "https://a.example.com/mcp", disabled_tools=["tool_b"])],
    )
    assert len(_FakeClient.instances) == 1
    assert [t.name for t in tools_filtered] == ["tool_a"]


async def test_failed_discovery_not_cached():
    _FakeClient.fail_on.add("lr-agent-local")
    first = await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", []
    )
    assert first == []
    _FakeClient.fail_on.clear()
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_read")]
    second = await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", []
    )
    # 失败不写缓存：第二次重新发现成功
    assert len(_FakeClient.instances) == 2
    assert [t.name for t in second] == ["memory_read"]


# ── 过期缓存：stale-while-revalidate ─────────────────────────────────


async def _flush_refreshes():
    """等待已排期的后台刷新跑完。

    每轮让出一次事件循环：task 的 done-callback（从 _refresh_tasks 摘除）靠 loop 回调执行，
    只 await 已完成的 task 不会让出循环。
    """
    for _ in range(10):
        if not mcp_client._refresh_tasks:
            return
        await asyncio.gather(*list(mcp_client._refresh_tasks), return_exceptions=True)
        await asyncio.sleep(0)


async def test_stale_cache_returns_old_tools_without_waiting():
    """过期后本轮直接用旧列表（不重新建连），后台刷新下一轮生效。"""
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_read")]
    await mcp_client.load_mcp_tools_from_servers("http://127.0.0.1:9000", [])
    assert len(_FakeClient.instances) == 1

    # 让缓存过期，并换成新工具列表
    key = mcp_client._cache_key(mcp_client._local_connection("http://127.0.0.1:9000"))
    tools_old, _ = mcp_client._tools_cache[key]
    mcp_client._tools_cache[key] = (tools_old, 0.0)
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_write")]

    stale = await mcp_client.load_mcp_tools_from_servers("http://127.0.0.1:9000", [])
    # 本轮仍是旧列表，且没有为它同步建连
    assert [t.name for t in stale] == ["memory_read"]
    assert len(_FakeClient.instances) == 1

    await _flush_refreshes()
    refreshed = await mcp_client.load_mcp_tools_from_servers("http://127.0.0.1:9000", [])
    assert [t.name for t in refreshed] == ["memory_write"]


async def test_stale_refresh_failure_keeps_old_tools():
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_read")]
    await mcp_client.load_mcp_tools_from_servers("http://127.0.0.1:9000", [])
    key = mcp_client._cache_key(mcp_client._local_connection("http://127.0.0.1:9000"))
    tools_old, _ = mcp_client._tools_cache[key]
    mcp_client._tools_cache[key] = (tools_old, 0.0)

    _FakeClient.fail_on.add("lr-agent-local")
    assert [t.name for t in await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", []
    )] == ["memory_read"]
    await _flush_refreshes()

    # 刷新失败：旧条目仍在，下一轮仍可用
    _FakeClient.fail_on.clear()
    still = await mcp_client.load_mcp_tools_from_servers("http://127.0.0.1:9000", [])
    assert [t.name for t in still] == ["memory_read"]


async def test_no_cache_still_discovers_synchronously():
    """首轮无缓存必须同步发现（不能返回空列表）。"""
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_read")]
    tools = await mcp_client.load_mcp_tools_from_servers("http://127.0.0.1:9000", [])
    assert [t.name for t in tools] == ["memory_read"]
    assert len(_FakeClient.instances) == 1


async def test_ttl_zero_does_not_serve_stale():
    """ttl=0 关闭缓存：每次都重新发现，不走 stale 分支。"""
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_read")]
    await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", [], ttl_seconds=0
    )
    _FakeClient.tools_by_server["lr-agent-local"] = [_tool("memory_write")]
    tools = await mcp_client.load_mcp_tools_from_servers(
        "http://127.0.0.1:9000", [], ttl_seconds=0
    )
    assert [t.name for t in tools] == ["memory_write"]
    assert len(_FakeClient.instances) == 2
