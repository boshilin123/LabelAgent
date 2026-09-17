"""chat/stream 的 preparing 事件顺序：MCP 发现前先发 preparing(stage=mcp)。"""

import pytest

from app.api.v1.agent import _stream_local_chat
from app.core.config import get_settings
from app.schemas.agent import (
    ClientContextInput,
    LocalChatStreamRequest,
    StreamEventPayload,
)

pytest.importorskip("langchain_openai")


class _FakeChatOpenAI:
    """替代 ChatOpenAI：assist 流被整体 patch，实例不被真正调用。"""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


async def _fake_load_mcp_tools(*args, **kwargs):
    return []


async def _fake_assist_stream(*args, **kwargs):
    yield StreamEventPayload(type="preparing", stage="streaming")
    yield StreamEventPayload(type="text_delta", content="hello")


def _body(mcp_server_url: str | None) -> LocalChatStreamRequest:
    client_context = ClientContextInput(
        workspace_root="/tmp/ws",
        mcp_server_url=mcp_server_url,
    )
    return LocalChatStreamRequest(
        api_key="k",
        base_url="https://api.example.com/v1",
        model="test-model",
        messages=[{"role": "user", "content": "hi"}],
        user_content="hi",
        client_job_id="job-preparing-1",
        client_context=client_context,
    )


async def _collect(
    body: LocalChatStreamRequest, monkeypatch
) -> list[dict]:
    """收集 SSE 字符串并解析回事件 dict（_stream_local_chat 产出 data: 行）。"""
    import json

    monkeypatch.setattr("app.api.v1.agent.ChatOpenAI", _FakeChatOpenAI)
    monkeypatch.setattr(
        "app.api.v1.agent.load_mcp_tools_from_servers", _fake_load_mcp_tools
    )
    monkeypatch.setattr(
        "app.agent.assist_service.stream_assist", _fake_assist_stream
    )
    events: list[dict] = []
    async for chunk in _stream_local_chat(body, get_settings()):
        for line in chunk.split("\n"):
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if payload:
                events.append(json.loads(payload))
    return events


async def test_preparing_mcp_emitted_before_assist_stream(monkeypatch):
    events = await _collect(_body("http://127.0.0.1:9000"), monkeypatch)
    assert events[0]["type"] == "preparing"
    assert events[0]["stage"] == "mcp"
    assert events[1]["type"] == "preparing"
    assert events[1]["stage"] == "streaming"
    assert events[2]["type"] == "text_delta"
    assert events[-1] == {"type": "done"}


async def test_no_mcp_preparing_without_mcp_config(monkeypatch):
    events = await _collect(_body(None), monkeypatch)
    assert events[0]["type"] == "preparing"
    assert events[0]["stage"] == "streaming"
    assert all(
        not (e["type"] == "preparing" and e.get("stage") == "mcp")
        for e in events
    )
