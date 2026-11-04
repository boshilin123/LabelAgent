"""请求断连的生命周期回归：使用真实路由、真实 Agent 图和可控的离线模型/工具。"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.tools import StructuredTool
from starlette.requests import ClientDisconnect

from app.agent.langchain_runtime import entry
from app.agent.assist.tool_loop import _merge_async_iterators
from app.api.v1 import agent as agent_module
from app.core.config import Settings, get_settings
from app.core.streaming import ClosingStreamingResponse, close_stream


@dataclass
class Probe:
    started: asyncio.Event = field(default_factory=asyncio.Event)
    closed: asyncio.Event = field(default_factory=asyncio.Event)
    release: asyncio.Event = field(default_factory=asyncio.Event)
    calls: int = 0


class WaitingModel(BaseChatModel):
    mode: str = "wait"
    probe: Any

    @property
    def _llm_type(self) -> str:
        return "disconnect-test"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, *args, **kwargs):
        raise AssertionError("The cancellation tests must use async streaming")

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.probe.calls += 1
        if self.mode != "wait":
            name = "explore_readonly" if self.mode == "subagent" else "read_workspace_file"
            args = {"query": "read README"} if self.mode == "subagent" else {"relative_path": "README.md"}
            yield ChatGenerationChunk(message=AIMessageChunk(content="", tool_call_chunks=[{
                "id": "call-readme", "index": 0, "name": name,
                "args": json.dumps(args), "type": "tool_call_chunk",
            }]))
            return
        try:
            yield ChatGenerationChunk(message=AIMessageChunk(content="first part"))
            self.probe.started.set()
            await self.probe.release.wait()
        finally:
            # 清理包含 await，能发现断连后重复取消导致清理被截断的问题。
            await asyncio.sleep(0)
            self.probe.closed.set()


def make_app(monkeypatch, engine: str, scenario: str):
    waiting = Probe()
    parent = WaitingModel(mode=scenario if scenario in ("tool", "subagent") else "wait", probe=Probe())
    child = WaitingModel(probe=waiting)
    if scenario in ("plain", "model"):
        parent.probe = waiting

    async def read_workspace_file(relative_path: str = "") -> str:
        if scenario == "tool":
            waiting.calls += 1
            waiting.started.set()
            try:
                await waiting.release.wait()
            finally:
                await asyncio.sleep(0)
                waiting.closed.set()
        return "README contents"

    async def explore_readonly(query: str, focus_path: str | None = None) -> str:
        raise AssertionError("The real subagent wrapper should replace this stub")

    tools = [StructuredTool.from_function(
        coroutine=read_workspace_file, name="read_workspace_file", description="Read workspace text",
    )]
    if scenario == "subagent":
        tools.append(StructuredTool.from_function(
            coroutine=explore_readonly, name="explore_readonly", description="Explore workspace",
        ))

    def model_factory(**kwargs):
        return child if kwargs.get("model") == "child" else parent

    monkeypatch.setattr(entry, "ChatOpenAI", model_factory, raising=False)
    monkeypatch.setattr(agent_module, "ChatOpenAI", model_factory)
    monkeypatch.setattr(entry, "build_local_tools", lambda *args: list(tools))
    monkeypatch.setattr(agent_module, "build_tools_by_name_set", lambda *args, **kwargs: list(tools))
    app = FastAPI()
    app.include_router(agent_module.router, prefix="/api/v1")
    settings = Settings(agent_engine=engine)
    app.dependency_overrides[get_settings] = lambda: settings

    @app.get("/health")
    async def health():
        return {"ok": True}

    body = {
        "api_key": "offline-test", "base_url": "https://example.invalid/v1", "model": "parent",
        "messages": [{"role": "user", "content": "read README"}], "user_content": "read README",
        "client_job_id": "disconnect-test", "aux_model": "child",
        "aux_api_key": "offline-test", "aux_base_url": "https://example.invalid/v1",
    }
    if scenario != "plain":
        body["client_context"] = {"workspace_root": "/workspace", "agent_mode": "chat", "work_mode": "editor"}
    return app, body, waiting, parent


def http_scope():
    return {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": "POST", "scheme": "http", "root_path": "",
        "path": "/api/v1/agent/chat/stream", "raw_path": b"/api/v1/agent/chat/stream",
        "query_string": b"", "headers": [(b"content-type", b"application/json")],
        "server": ("127.0.0.1", 8000), "client": ("127.0.0.1", 12345),
    }


@pytest.mark.parametrize("engine", ["candidate", "legacy"])
@pytest.mark.parametrize("scenario", ["plain", "model", "tool", "subagent"])
async def test_disconnect_stops_waiting_work_and_finishes_cleanup(monkeypatch, engine, scenario):
    app, body, probe, parent = make_app(monkeypatch, engine, scenario)
    incoming = asyncio.Queue()
    incoming.put_nowait({"type": "http.request", "body": json.dumps(body).encode(), "more_body": False})
    sent = []

    async def send(message):
        sent.append(message)

    request = asyncio.create_task(app(http_scope(), incoming.get, send))
    started = asyncio.create_task(probe.started.wait())
    try:
        finished, _ = await asyncio.wait([request, started], timeout=3, return_when=asyncio.FIRST_COMPLETED)
        if request in finished:
            await request
            pytest.fail(f"request finished before the expected work started: {sent!r}")
        assert started in finished, "model/tool did not reach the blocking operation"
        incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(request, 3)
        assert probe.closed.is_set(), "request returned before the inner async cleanup completed"
        assert parent.probe.calls == 1, "cancelled work must not start another model round"
        payloads = [json.loads(line[6:]) for message in sent for line in message.get("body", b"").decode().splitlines() if line.startswith("data: ")]
        assert not any(payload["type"] == "done" for payload in payloads)
        pumps = [task for task in asyncio.all_tasks() if not task.done() and "_pump" in task.get_coro().__qualname__]
        assert not pumps, "a cancelled request left an event-reading task running"
    finally:
        if not request.done():
            request.cancel()
        started.cancel()
        await asyncio.gather(request, started, return_exceptions=True)


async def test_disconnect_while_sending_closes_a_suspended_generator():
    closed = asyncio.Event()

    async def stream():
        try:
            yield "data: first\n\n"
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            closed.set()

    response = ClosingStreamingResponse(stream(), media_type="text/event-stream")

    async def receive():
        await asyncio.Event().wait()

    async def send(message):
        if message["type"] == "http.response.body":
            raise OSError("client disconnected during send")

    scope = http_scope()
    scope["asgi"]["spec_version"] = "2.4"
    with pytest.raises(ClientDisconnect):
        await response(scope, receive, send)
    assert closed.is_set()


async def test_stream_cleanup_does_not_hide_real_errors():
    async def stream():
        try:
            yield "first"
        finally:
            raise RuntimeError("cleanup failed")

    source = stream()
    await anext(source)
    with pytest.raises(RuntimeError, match="cleanup failed"):
        await close_stream(source)


async def test_slow_consumer_does_not_allow_unbounded_prefetch():
    produced = []
    closed = asyncio.Event()

    async def stream():
        try:
            for index in range(100):
                produced.append(index)
                yield str(index)
        finally:
            closed.set()

    response = ClosingStreamingResponse(stream())
    try:
        assert await anext(response.body_iterator) == "0"
        await asyncio.sleep(0)
        assert len(produced) < 100, "a paused consumer must apply backpressure"
    finally:
        await close_stream(response.body_iterator)
    assert closed.is_set()


async def test_disconnect_does_not_hide_a_source_cleanup_failure():
    waiting = asyncio.Event()

    async def stream():
        try:
            yield "first"
            waiting.set()
            await asyncio.Event().wait()
        finally:
            raise RuntimeError("source cleanup failed")

    response = ClosingStreamingResponse(stream())
    await anext(response.body_iterator)
    await asyncio.wait_for(waiting.wait(), 1)
    with pytest.raises(RuntimeError, match="source cleanup failed"):
        await close_stream(response.body_iterator)


@pytest.mark.parametrize("count", [1, 2])
async def test_cancelling_parallel_readers_closes_all_substreams(count):
    probes = [Probe() for _ in range(count)]

    async def stream(probe):
        try:
            yield "started"
            probe.started.set()
            await probe.release.wait()
        finally:
            await asyncio.sleep(0)
            probe.closed.set()

    async def consume():
        async for _ in _merge_async_iterators([stream(probe) for probe in probes]):
            pass

    reader = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(asyncio.gather(*(probe.started.wait() for probe in probes)), 3)
        reader.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reader
        assert all(probe.closed.is_set() for probe in probes)
    finally:
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)


@pytest.mark.parametrize("engine", ["candidate", "legacy"])
async def test_disconnect_stops_waiting_for_sync_tool_without_starting_another_round(monkeypatch, engine):
    app, body, probe, parent = make_app(monkeypatch, engine, "tool")
    loop = asyncio.get_running_loop()
    release_thread = threading.Event()

    def read_workspace_file(relative_path: str = "") -> str:
        loop.call_soon_threadsafe(probe.started.set)
        try:
            release_thread.wait(3)
            return "finished sync read"
        finally:
            loop.call_soon_threadsafe(probe.closed.set)

    tools = [StructuredTool.from_function(
        func=read_workspace_file, name="read_workspace_file", description="Blocking synchronous read",
    )]
    monkeypatch.setattr(entry, "build_local_tools", lambda *args: tools)
    monkeypatch.setattr(agent_module, "build_tools_by_name_set", lambda *args, **kwargs: tools)
    incoming = asyncio.Queue()
    incoming.put_nowait({"type": "http.request", "body": json.dumps(body).encode(), "more_body": False})

    async def send(message):
        pass

    request = asyncio.create_task(app(http_scope(), incoming.get, send))
    try:
        await asyncio.wait_for(probe.started.wait(), 3)
        incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(request, 1)
        # Python 不能强杀已进入线程的同步函数；请求退出后不再等待它或发起下一轮。
        assert not probe.closed.is_set()
        assert parent.probe.calls == 1
    finally:
        release_thread.set()
        if not request.done():
            request.cancel()
        await asyncio.gather(request, return_exceptions=True)
        await asyncio.wait_for(probe.closed.wait(), 3)


class QuietServer(uvicorn.Server):
    @contextmanager
    def capture_signals(self):
        yield


@pytest.mark.parametrize("engine", ["candidate", "legacy"])
async def test_real_http_client_abort_stops_model_and_keeps_server_healthy(monkeypatch, engine):
    app, body, probe, _parent = make_app(monkeypatch, engine, "model")
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    base_url = "http://127.0.0.1:" + str(sock.getsockname()[1])
    server = QuietServer(uvicorn.Config(app, log_level="error", lifespan="off", ws="none", timeout_graceful_shutdown=1))
    serving = asyncio.create_task(server.serve(sockets=[sock]))

    async def started():
        while not server.started:
            await asyncio.sleep(0.01)

    try:
        await asyncio.wait_for(started(), 3)
        async with httpx.AsyncClient(base_url=base_url, trust_env=False, timeout=3) as client:
            async with client.stream("POST", "/api/v1/agent/chat/stream", json=body) as response:
                assert response.status_code == 200
                await asyncio.wait_for(probe.started.wait(), 3)
                # 离开上下文会关闭仍未完成的真实 HTTP 响应，相当于客户端 abort。
            await asyncio.wait_for(probe.closed.wait(), 3)
            assert (await client.get("/health")).json() == {"ok": True}
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, 3)
        sock.close()
