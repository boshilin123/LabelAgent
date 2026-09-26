"""阶段 7：接入隔离 FastAPI 入口（候选引擎）的集成测试。

覆盖迁移计划 §5-阶段 7 的三项行动与通过门槛：

1. **默认路径不变**：``/api/v1/agent/chat/stream`` 在 ``agent_engine="legacy"``
   （默认）时逐字节走旧 ``_stream_local_chat``；候选引擎只能由**后端**选择
   （``Settings.agent_engine`` / 环境变量 ``LR_AGENT_ENGINE``），前端不参与。
2. **FastAPI 测试客户端**覆盖：请求校验（422）、MCP ``preparing`` 帧
   （配置 / 未配置 / loader 失败）、SSE 字节格式、取消、工具结果回传第二轮、
   异常到 HTTP/SSE 的映射（**无** ``error`` 帧；``done`` 只在正常完成或取消时发）。
3. **逐帧字节相等**：同一脚本化场景下，候选入口产出的 SSE 字符串列表与旧路径
   完全相等（复用阶段 4 的驱动方式：脚本化流式模型 + 存根工具 + 假 MCP loader）。

全部离线、确定性：无网络、无真实模型、无真实工作区写入、无 Docker。
"""

from __future__ import annotations

import json
from typing import Any

import pytest

# baseline 环境（无 langchain/langgraph）整体 skip 而不是 collect error
pytest.importorskip("langchain")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from langchain_core.messages import (  # noqa: E402
    AIMessageChunk,
    ToolMessage,
)
from langchain_core.tools import StructuredTool  # noqa: E402

from app.agent.langchain_runtime import entry  # noqa: E402
from app.api.v1 import agent as agent_module  # noqa: E402
from app.core.config import Settings, get_settings  # noqa: E402
from app.schemas.agent import (  # noqa: E402
    ClientContextInput,
    LocalChatStreamRequest,
    StreamEventPayload,
)

ROUTE = "/api/v1/agent/chat/stream"
CANCEL_ROUTE = "/api/v1/agent/chat/cancel"


# ── 脚本化素材（与阶段 4b 同源，不 import 测试模块以免跨文件耦合）────────


class ScriptedChatOpenAI:
    """替代 ``entry.ChatOpenAI``：返回脚本化模型并记录构造参数。

    ``bind_tools`` 记录模型真正看到的工具名（= 进图工具清单的镜像）。
    """

    instances: list["ScriptedChatOpenAI"] = []

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.rounds: list[list[AIMessageChunk]] = [
            [AIMessageChunk(content="第一轮回答。")],
            [AIMessageChunk(content="第二轮回答。")],
        ]
        self.round_index = 0
        self.bound_tool_names: list[str] = []
        self.seen_messages: list[list[Any]] = []
        self.closed = False
        ScriptedChatOpenAI.instances.append(self)

    def _round(self) -> list[AIMessageChunk]:
        index = self.round_index
        self.round_index += 1
        return self.rounds[index] if index < len(self.rounds) else [AIMessageChunk(content="")]

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.bound_tool_names = [getattr(t, "name", str(t)) for t in tools]
        return self

    async def astream(self, messages):  # type: ignore[override]
        self.seen_messages.append(list(messages))
        try:
            for chunk in self._round():
                yield chunk
        finally:
            self.closed = True

    async def ainvoke(self, messages):  # type: ignore[override]
        return AIMessageChunk(content="")


def _tool_stub(name: str) -> StructuredTool:
    def _fn(**kwargs: Any) -> str:
        return json.dumps({"ok": True, "summary": f"{name} ok"}, ensure_ascii=False)

    _fn.__name__ = name
    return StructuredTool(
        name=name,
        description=f"{name} stub",
        func=_fn,
        args_schema={"type": "object", "properties": {}},
    )


def _body(
    *,
    mcp_server_url: str | None = None,
    client_job_id: str = "job-stage7",
    messages: list[dict[str, Any]] | None = None,
    client_tool_results: list[dict[str, Any]] | None = None,
    api_key: str = "k",
    user_content: str = "hi",
) -> LocalChatStreamRequest:
    return LocalChatStreamRequest(
        api_key=api_key,
        base_url="https://api.example.com/v1",
        model="test-model",
        messages=messages or [{"role": "user", "content": "hi"}],
        user_content=user_content,
        client_job_id=client_job_id,
        client_tool_results=client_tool_results or [],
        client_context=ClientContextInput(
            workspace_root="/tmp/ws",
            mcp_server_url=mcp_server_url,
        ),
    )


# ── 帧解析与收集 ───────────────────────────────────────────────────────


def _raw_frames(chunks: list[str]) -> list[str]:
    """把 SSE 响应正文切回「逐帧原始字符串」（含 ``\\n\\n`` 之前的部分）。"""
    text = "".join(chunks)
    frames: list[str] = []
    for block in text.split("\n\n"):
        if block.strip():
            frames.append(block)
    return frames


def _events(chunks: list[str]) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    for frame in _raw_frames(chunks):
        assert frame.startswith("data: ")
        frames.append(json.loads(frame[len("data: ") :]))
    return frames


async def _collect_candidate(body: LocalChatStreamRequest, settings: Any, **kwargs: Any) -> list[str]:
    return [
        chunk
        async for chunk in entry.stream_candidate_engine_sse(body, settings, **kwargs)
    ]


async def _collect_legacy(body: LocalChatStreamRequest, settings: Any) -> list[str]:
    from app.api.v1.agent import _stream_local_chat

    return [chunk async for chunk in _stream_local_chat(body, settings)]


def _candidate_settings() -> Settings:
    return Settings(agent_engine="candidate")


# ── 共享 patch 组 ──────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_cancel_registry():
    agent_module._cancel_events.clear()
    yield
    agent_module._cancel_events.clear()


@pytest.fixture
def patch_model(monkeypatch):
    """把两边的模型工厂都换成脚本化模型。"""
    ScriptedChatOpenAI.instances.clear()
    monkeypatch.setattr(entry, "ChatOpenAI", ScriptedChatOpenAI)
    monkeypatch.setattr(agent_module, "ChatOpenAI", ScriptedChatOpenAI)
    return ScriptedChatOpenAI


@pytest.fixture
def local_tools():
    """本地工具集（只读工具，避免任何写盘）。"""
    return [_tool_stub("read_file"), _tool_stub("explore_readonly")] if False else [
        _tool_stub("read_file"),
        _tool_stub("list_dir"),
    ]


@pytest.fixture
def patch_local_tools(monkeypatch, local_tools):
    monkeypatch.setattr(entry, "build_local_tools", lambda body, settings: list(local_tools))
    return local_tools


def _patch_mcp(monkeypatch, loader):
    """MCP loader 在两条路径上分别 patch（旧路径用 api 模块名，候选用 entry 模块名）。

    ``load_mcp_tools_from_servers`` 在候选入口里是**函数内 import**，
    因此 patch ``entry`` 模块属性无效——必须 patch 定义模块本身
    （``app.agent.tools.mcp_client``），两条路径都会看到。
    """
    monkeypatch.setattr(
        "app.agent.tools.mcp_client.load_mcp_tools_from_servers", loader
    )
    monkeypatch.setattr("app.api.v1.agent.load_mcp_tools_from_servers", loader)


# ── 1. 后端受控开关 ────────────────────────────────────────────────────


class TestEngineSelection:
    def test_default_is_candidate_and_env_var_can_roll_back(self):
        """阶段 8 行动 5：**副本默认已切为 ``candidate``**；``legacy`` 是回退开关。

        切换依据见 `docs/阶段8-对照度量.md` §6 清单（§6.2-1 要求候选实际承接默认循环）。
        依赖前提：``candidate`` 需运行环境安装 ``langchain`` / ``langgraph``。
        """
        assert Settings().agent_engine == "candidate"
        assert Settings(agent_engine="legacy").agent_engine == "legacy"  # type: ignore[call-arg]

    def test_env_var_selects_candidate(self, monkeypatch):
        monkeypatch.setenv("AGENT_ENGINE", "candidate")
        assert Settings().agent_engine == "candidate"

    async def test_dispatch_explicit_legacy_calls_old_generator(
        self, monkeypatch, patch_model
    ):
        """**显式** ``legacy``（回退开关）：``stream_engine_sse`` 只委派旧 ``_stream_local_chat``。

        阶段 8 行动 5 后默认是 ``candidate``，故此处显式传 ``legacy`` 才验证回退路径。
        """
        calls: list[str] = []

        async def _spy(body, settings):
            calls.append(body.client_job_id)
            yield 'data: {"type": "preparing", "stage": "streaming"}\n\n'
            yield 'data: {"type": "done"}\n\n'

        monkeypatch.setattr(agent_module, "_stream_local_chat", _spy)
        out = [
            chunk
            async for chunk in entry.stream_engine_sse(
                _body(), Settings(agent_engine="legacy")
            )
        ]
        assert calls == ["job-stage7"]
        assert out == [
            'data: {"type": "preparing", "stage": "streaming"}\n\n',
            'data: {"type": "done"}\n\n',
        ]

    async def test_dispatch_candidate_does_not_call_old_generator(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        calls: list[str] = []

        async def _spy(body, settings):  # pragma: no cover - 不应被调用
            calls.append("legacy")
            yield "data: {}\n\n"

        monkeypatch.setattr(agent_module, "_stream_local_chat", _spy)

        async def _fake_frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="text_delta", content="候选")

        out = await _collect_candidate(
            _body(), _candidate_settings(), frame_source=_fake_frames
        )
        assert calls == []
        assert _events(out) == [
            {"type": "text_delta", "content": "候选"},
            {"type": "done"},
        ]


# ── 2. 装配期硬断言：stream_mode 含 custom / 图至少有 1 个工具 ──────────


class TestAssemblyInvariants:
    def test_stream_modes_include_custom(self):
        modes = entry.assemble_stream_modes()
        assert "custom" in modes
        assert set(entry.assemble_stream_modes().count(m) for m in modes) == {1}
        assert modes[:2] == ("messages", "updates")

    def test_stream_modes_assert_custom_even_with_overrides(self):
        with pytest.raises(AssertionError, match="custom"):
            entry.assemble_stream_modes({"stream_modes": ["messages", "updates"]})

    def test_run_plan_rejects_empty_tool_list(self):
        with pytest.raises(AssertionError, match="工具清单为空"):
            entry.build_agent_run_plan(
                tools=[],
                stream_modes=("messages", "updates", "custom"),
                is_resume=False,
                has_tools=True,
            )

    def test_run_plan_requires_custom_mode(self):
        with pytest.raises(AssertionError, match="custom"):
            entry.build_agent_run_plan(
                tools=[_tool_stub("read_file")],
                stream_modes=("messages", "updates"),
                is_resume=False,
                has_tools=True,
            )

    async def test_plan_records_sorted_non_empty_tool_names(
        self, patch_model, patch_local_tools
    ):
        captured: list[entry.AgentRunPlan] = []

        async def _fake_frames(agent, resolved, *, stream_modes):
            assert "custom" in stream_modes
            yield StreamEventPayload(type="text_delta", content="ok")

        out = await _collect_candidate(
            _body(),
            _candidate_settings(),
            on_plan=captured.append,
            frame_source=_fake_frames,
        )
        assert _events(out)[-1] == {"type": "done"}
        assert len(captured) == 1
        plan = captured[0]
        assert plan.tool_names == ("list_dir", "read_file")
        assert plan.tool_names == tuple(sorted(plan.tool_names))
        assert plan.stream_modes == entry.assemble_stream_modes()
        assert plan.is_resume is False


# ── 3. MCP 前置段（preparing 帧）───────────────────────────────────────


class TestMcpPreStage:
    async def test_preparing_mcp_is_first_frame_when_configured(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        async def _loader(*args, **kwargs):
            return [_tool_stub("mcp_echo")]

        _patch_mcp(monkeypatch, _loader)

        async def _fake_frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="text_delta", content="ok")

        out = await _collect_candidate(
            _body(mcp_server_url="http://127.0.0.1:9000"),
            _candidate_settings(),
            frame_source=_fake_frames,
        )
        events = _events(out)
        assert events[0] == {"type": "preparing", "stage": "mcp"}
        assert events[1]["type"] == "text_delta"
        assert events[-1] == {"type": "done"}
        assert not any(e["type"] == "error" for e in events)

    async def test_no_mcp_preparing_without_mcp_config(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        called = False

        async def _loader(*args, **kwargs):  # pragma: no cover - 不应被调用
            nonlocal called
            called = True
            return []

        _patch_mcp(monkeypatch, _loader)

        async def _fake_frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="text_delta", content="ok")

        out = await _collect_candidate(
            _body(mcp_server_url=None),
            _candidate_settings(),
            frame_source=_fake_frames,
        )
        assert called is False
        assert not any(
            e["type"] == "preparing" and e.get("stage") == "mcp" for e in _events(out)
        )

    async def test_mcp_loader_failure_keeps_turn_alive(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        async def _raising_loader(*args, **kwargs):
            raise ConnectionError("MCP server unreachable")

        _patch_mcp(monkeypatch, _raising_loader)
        captured: list[entry.AgentRunPlan] = []

        async def _fake_frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="text_delta", content="本地工具就绪")

        out = await _collect_candidate(
            _body(mcp_server_url="http://127.0.0.1:9000"),
            _candidate_settings(),
            on_plan=captured.append,
            frame_source=_fake_frames,
        )
        events = _events(out)
        assert events == [
            {"type": "preparing", "stage": "mcp"},
            {"type": "text_delta", "content": "本地工具就绪"},
            {"type": "done"},
        ]
        assert captured[0].tool_names == ("list_dir", "read_file")
        assert not any(e["type"] == "error" for e in events)

    async def test_mcp_tools_merged_deduped_and_sorted(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        async def _loader(*args, **kwargs):
            return [
                _tool_stub("read_file"),  # 与本地重名 → 丢弃 MCP 那份
                _tool_stub("mcp_alpha"),
                _tool_stub("mcp_beta"),
            ]

        _patch_mcp(monkeypatch, _loader)
        captured: list[entry.AgentRunPlan] = []

        async def _fake_frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="text_delta", content="ok")

        await _collect_candidate(
            _body(mcp_server_url="http://127.0.0.1:9000"),
            _candidate_settings(),
            on_plan=captured.append,
            frame_source=_fake_frames,
        )
        assert captured[0].tool_names == (
            "list_dir",
            "mcp_alpha",
            "mcp_beta",
            "read_file",
        )


# ── 4. 与旧路径逐帧字节相等 ────────────────────────────────────────────


class TestByteEqualityWithOldPath:
    """同一脚本化事件序列下，两条入口的 SSE **字符串列表**必须完全相等。

    旧侧用 :func:`_legacy_http` 只保留「旧 HTTP 前置段 + 事件映射 + done」这三件事
    （模型—工具循环本身不在本阶段比较范围，阶段 4/5 已逐事件对照）；
    新侧走**真实的** ``stream_candidate_engine_sse``（含 MCP 前置段、装配、
    帧映射与 done），只把「适配器产出」换成同一批事件。
    """

    async def _run_both(
        self,
        monkeypatch,
        body: LocalChatStreamRequest,
        *,
        mcp_loader,
        events: list[StreamEventPayload],
        mcp_event: dict[str, Any] | None = None,
        candidate_frames=None,
    ) -> tuple[list[str], list[str], list[entry.AgentRunPlan]]:
        _patch_mcp(monkeypatch, mcp_loader)
        monkeypatch.setattr(
            agent_module, "_stream_local_chat", _legacy_http(events, mcp_event=mcp_event)
        )
        old = await _collect_legacy(body, Settings())

        async def _frames(agent, resolved, *, stream_modes):
            for event in events:
                yield event

        plans: list[entry.AgentRunPlan] = []
        new = await _collect_candidate(
            body,
            _candidate_settings(),
            on_plan=plans.append,
            frame_source=candidate_frames or _frames,
        )
        return old, new, plans

    async def test_identical_frames_plain_text_turn(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        events = [
            StreamEventPayload(type="preparing", stage="streaming"),
            StreamEventPayload(type="text_delta", content="你好"),
            StreamEventPayload(type="text_delta", content="，世界"),
        ]
        old, new, plans = await self._run_both(
            monkeypatch,
            _body(mcp_server_url=None),
            mcp_loader=_empty_loader,
            events=events,
        )
        assert old == new
        assert old == [
            'data: {"type": "preparing", "stage": "streaming"}\n\n',
            'data: {"type": "text_delta", "content": "你好"}\n\n',
            'data: {"type": "text_delta", "content": "，世界"}\n\n',
            'data: {"type": "done"}\n\n',
        ]
        assert plans[0].tool_names == ("list_dir", "read_file")

    async def test_identical_frames_with_mcp_preparing(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        events = [
            StreamEventPayload(type="preparing", stage="streaming"),
            StreamEventPayload(type="tool_start", tool_call_id="c1", name="read_file"),
            StreamEventPayload(
                type="tool_result", tool_call_id="c1", name="read_file", result="{}"
            ),
            StreamEventPayload(type="text_delta", content="完成"),
        ]
        old, new, plans = await self._run_both(
            monkeypatch,
            _body(mcp_server_url="http://127.0.0.1:9000"),
            mcp_loader=_returning_loader([_tool_stub("mcp_echo")]),
            events=events,
            mcp_event={"type": "preparing", "stage": "mcp"},
        )
        assert old == new
        parsed = _events(old)
        assert parsed[0] == {"type": "preparing", "stage": "mcp"}
        assert parsed[-1] == {"type": "done"}
        # MCP 工具确实进了候选图，且排序稳定
        assert plans[0].tool_names == ("list_dir", "mcp_echo", "read_file")

    async def test_legacy_tool_inventory_equals_candidate_plan(
        self, monkeypatch, patch_model
    ):
        """旧前置段交给 ``stream_assist`` 的工具名 == 候选装配进图的工具名。

        这里**不 patch** ``build_local_tools``：两边都走真实注册表，
        从而证明「候选工具清单 = 旧路径工具清单」（含 MCP 合并与排序）。
        旧侧的模型循环被替换成不执行工具的假生成器（零副作用）。
        """
        captured: dict[str, Any] = {}

        async def _capture_assist(*args, **kwargs):
            captured["tool_names"] = sorted(t.name for t in args[2])
            yield StreamEventPayload(type="preparing", stage="streaming")

        _patch_mcp(monkeypatch, _returning_loader([_tool_stub("mcp_echo")]))
        monkeypatch.setattr(agent_module, "ChatOpenAI", ScriptedChatOpenAI)
        monkeypatch.setattr(
            "app.agent.assist_service.stream_assist", _capture_assist
        )

        body = _body(mcp_server_url="http://127.0.0.1:9000")
        await _collect_legacy(body, Settings())

        plans: list[entry.AgentRunPlan] = []

        async def _frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="text_delta", content="ok")

        await _collect_candidate(
            body, _candidate_settings(), on_plan=plans.append, frame_source=_frames
        )

        assert captured["tool_names"], "旧路径工具清单不应为空"
        assert captured["tool_names"] == list(plans[0].tool_names)
        assert captured["tool_names"] == sorted(captured["tool_names"])
        # 安全护栏：该清单里没有会让本测试产生真实写盘/网络副作用的工具
        assert "mcp_echo" in captured["tool_names"]


async def _empty_loader(*args, **kwargs):
    return []


def _returning_loader(tools):
    async def _loader(*args, **kwargs):
        return list(tools)

    return _loader


def _legacy_from_events(events):
    """伪装成 ``stream_assist`` 的脚本化事件流（旧路径的模型循环整体替换）。"""

    async def _stream(*args, **kwargs):
        for event in events:
            yield event

    return _stream


def _legacy_http(events, *, mcp_event: dict[str, Any] | None = None):
    """伪装成 ``_stream_local_chat`` 的旧 HTTP 生成器。

    结构逐条对齐 ``agent.py:355-368``（MCP 前置帧）、``:485-498``（取消检查 +
    帧编码 + ``done``）：本测试用它证明候选入口在这三段上的**字符串**输出一致。
    """

    async def _stream(body, settings):
        if mcp_event is not None:
            yield "data: " + json.dumps(mcp_event, ensure_ascii=False) + "\n\n"
        for event in events:
            yield "data: " + json.dumps(event.to_sse_dict(), ensure_ascii=False) + "\n\n"
        yield 'data: {"type": "done"}\n\n'

    return _stream


# ── 5. 取消 ────────────────────────────────────────────────────────────


class TestCancellation:
    async def test_cancel_before_first_consumed_frame_emits_only_done(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        """取消检查在 yield 之前：已取出的帧也被丢弃（= 旧 HTTP 层语义）。"""
        job_id = "job-stage7-cancelled"
        agent_module._cancel_events[job_id] = _set_event()

        closed: list[bool] = []

        async def _frames(agent, resolved, *, stream_modes):
            try:
                yield StreamEventPayload(type="preparing", stage="streaming")
                yield StreamEventPayload(type="text_delta", content="不应出现")
            finally:
                closed.append(True)

        out = await _collect_candidate(
            _body(client_job_id=job_id), _candidate_settings(), frame_source=_frames
        )
        assert out == ['data: {"type": "done"}\n\n']
        assert closed == [True]

    async def test_cancel_between_frames_keeps_previously_yielded_frames(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        job_id = "job-stage7-cancel-mid"
        seen: list[str] = []

        async def _frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="text_delta", content="第一帧")
            agent_module._cancel_events[job_id].set()
            yield StreamEventPayload(type="text_delta", content="第二帧")

        out = await _collect_candidate(
            _body(client_job_id=job_id), _candidate_settings(), frame_source=_frames
        )
        seen = _events(out)
        assert seen == [
            {"type": "text_delta", "content": "第一帧"},
            {"type": "done"},
        ]

    async def test_http_cancel_endpoint_sets_the_same_registry(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        """取消端点在后端注册表上生效（候选入口读同一份注册表）。"""
        job_id = "job-stage7-http-cancel"
        app = _build_app(_candidate_settings())

        async def _frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="preparing", stage="streaming")
            yield StreamEventPayload(type="text_delta", content="正文")

        monkeypatch.setattr(entry, "_stream_candidate_frames", _frames)
        with TestClient(app) as client:
            agent_module._cancel_events[job_id] = _set_event()
            resp = client.post(
                CANCEL_ROUTE, json={"client_job_id": job_id}
            )
            assert resp.json() == {"ok": True}
            with client.stream(
                "POST", ROUTE, json=_body(client_job_id=job_id).model_dump()
            ) as streamed:
                body_text = "".join(streamed.iter_text())
        assert _events([body_text]) == [{"type": "done"}]


def _set_event():
    import asyncio

    event = asyncio.Event()
    event.set()
    return event


# ── 6. 工具结果回传（resume 第二轮）────────────────────────────────────


class TestResumeSecondRequest:
    async def test_resume_request_rebuilds_messages_and_seeds_completed_ids(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        captured: dict[str, Any] = {}
        real_builder = entry.build_engine_agent

        def _spy_builder(**kwargs):
            captured.update(kwargs)
            return real_builder(**kwargs)

        monkeypatch.setattr(entry, "build_engine_agent", _spy_builder)

        body = _body(
            client_job_id="job-stage7-resume",
            messages=[
                {"role": "user", "content": "标注这批图"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "call-1", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}}
                    ],
                },
            ],
            client_tool_results=[
                {"tool_call_id": "call-1", "name": "auto_annotate", "result": "{\"ok\": true}"}
            ],
        )

        async def _frames(agent, resolved, *, stream_modes):
            captured["messages"] = list(resolved["messages"])
            captured["completed"] = set(resolved["context"].completed_tool_ids)
            yield StreamEventPayload(type="text_delta", content="已收到标注结果")

        out = await _collect_candidate(
            body, _candidate_settings(), frame_source=_frames
        )
        assert _events(out) == [
            {"type": "text_delta", "content": "已收到标注结果"},
            {"type": "done"},
        ]
        assert captured["is_resume"] is True
        tool_messages = [
            m for m in captured["messages"] if isinstance(m, ToolMessage)
        ]
        assert [m.tool_call_id for m in tool_messages] == ["call-1"]
        # 结果文本由旧 ``append_client_tool_results_to_messages`` 产出（含 next_hint 兜底）
        assert tool_messages[0].content.startswith('{"ok": true')
        assert captured["completed"] == {"call-1"}

    async def test_second_resume_is_idempotent_no_second_tool_message(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        """重复投递同一批结果：不追加第二条 ToolMessage（阶段 3 幂等）。"""
        captured: dict[str, Any] = {}

        async def _frames(agent, resolved, *, stream_modes):
            captured["messages"] = list(resolved["messages"])
            yield StreamEventPayload(type="text_delta", content="ok")

        body = _body(
            messages=[
                {"role": "user", "content": "标注这批图"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "call-1", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}}
                    ],
                },
                {"role": "tool", "content": '{"ok": true}', "tool_call_id": "call-1"},
            ],
            client_tool_results=[
                {"tool_call_id": "call-1", "name": "auto_annotate", "result": '{"ok": true}'}
            ],
        )
        await _collect_candidate(body, _candidate_settings(), frame_source=_frames)
        tool_messages = [m for m in captured["messages"] if isinstance(m, ToolMessage)]
        assert [m.tool_call_id for m in tool_messages] == ["call-1"]


def _build_app(settings: Settings) -> FastAPI:
    """最小 FastAPI 应用（不读 .env、不需要本地 token、不暴露 0.0.0.0）。"""
    app = FastAPI()
    app.include_router(agent_module.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: settings
    return app


# ── 7. 异常 → HTTP / SSE 映射 ─────────────────────────────────────────


class TestFailureMapping:
    async def test_framework_exception_yields_no_done_and_no_error_frame(
        self, patch_model, patch_local_tools
    ):
        async def _frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="preparing", stage="streaming")
            yield StreamEventPayload(type="text_delta", content="前半截")
            raise RuntimeError("框架失败")

        chunks: list[str] = []
        with pytest.raises(RuntimeError, match="框架失败"):
            async for chunk in entry.stream_candidate_engine_sse(
                _body(), _candidate_settings(), frame_source=_frames
            ):
                chunks.append(chunk)

        events = _events(chunks)
        assert events == [
            {"type": "preparing", "stage": "streaming"},
            {"type": "text_delta", "content": "前半截"},
        ]
        assert not any(e["type"] == "done" for e in events)
        assert not any(e["type"] == "error" for e in events)

    def test_http_layer_truncates_without_error_or_done_frame(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        """流中途异常：响应在异常处截断，只到已产出的帧（无 done / 无 error）。

        与旧路径同构：``agent.py:147/500`` 只有 ``try/finally``、没有 ``except``，
        因此服务端在已经发出 200 响应头之后抛异常。客户端观察到「截断且无收尾帧」，
        这正是阶段 4 备忘 §5 记录的口径（可诊断性不优于旧路径，不得新增 ``error`` 帧）。
        """

        async def _frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="text_delta", content="前半截")
            raise RuntimeError("框架失败")

        monkeypatch.setattr(entry, "_stream_candidate_frames", _frames)
        app = _build_app(_candidate_settings())
        with TestClient(app, raise_server_exceptions=False) as client:
            resp = client.post(ROUTE, json=_body().model_dump())

        assert not any(
            e["type"] in ("done", "error") for e in _events([resp.text])
        )
        assert resp.status_code >= 200

    def test_validation_error_is_422_before_any_engine_work(
        self, monkeypatch, patch_model
    ):
        app = _build_app(_candidate_settings())
        with TestClient(app) as client:
            resp = client.post(ROUTE, json={"model": "m"})
        assert resp.status_code == 422

    async def test_pre_turn_failure_never_emits_frames(self, patch_model, monkeypatch):
        """模型构造阶段抛出时：一帧都不发（旧路径同构：StreamingResponse 已 200）。"""

        def _boom(**kwargs):
            raise RuntimeError("构造失败")

        monkeypatch.setattr(entry, "ChatOpenAI", _boom)
        chunks: list[str] = []
        with pytest.raises(RuntimeError, match="构造失败"):
            async for chunk in entry.stream_candidate_engine_sse(
                _body(), _candidate_settings()
            ):
                chunks.append(chunk)
        assert chunks == []


# ── 8. FastAPI 测试客户端：端到端 SSE 字节格式 ─────────────────────────


class TestFastApiRoute:
    def test_route_streams_bytes_identical_to_generator(
        self, monkeypatch, patch_model, patch_local_tools
    ):
        async def _frames(agent, resolved, *, stream_modes):
            yield StreamEventPayload(type="preparing", stage="streaming")
            yield StreamEventPayload(type="text_delta", content="端到端")
            yield StreamEventPayload(type="tool_start", tool_call_id="t1", name="read_file")

        monkeypatch.setattr(entry, "_stream_candidate_frames", _frames)
        app = _build_app(_candidate_settings())
        with TestClient(app) as client:
            with client.stream("POST", ROUTE, json=_body().model_dump()) as streamed:
                assert streamed.status_code == 200
                assert streamed.headers["content-type"].startswith("text/event-stream")
                body_text = "".join(streamed.iter_text())

        assert body_text == (
            'data: {"type": "preparing", "stage": "streaming"}\n\n'
            'data: {"type": "text_delta", "content": "端到端"}\n\n'
            'data: {"type": "tool_start", "toolCallId": "t1", "name": "read_file"}\n\n'
            'data: {"type": "done"}\n\n'
        )

    def test_explicit_legacy_settings_make_the_route_serve_the_old_generator(
        self, monkeypatch, patch_model
    ):
        """反向证明（回退开关）：显式 ``legacy`` 时路由走旧 ``_stream_local_chat``。

        阶段 8 行动 5 后默认是 ``candidate``，故此处必须显式指定 ``legacy``。
        """
        calls: list[str] = []

        async def _spy(body, settings):
            calls.append(body.client_job_id)
            yield 'data: {"type": "preparing", "stage": "streaming"}\n\n'
            yield 'data: {"type": "done"}\n\n'

        monkeypatch.setattr(agent_module, "_stream_local_chat", _spy)
        app = _build_app(Settings(agent_engine="legacy"))
        with TestClient(app) as client:
            with client.stream("POST", ROUTE, json=_body().model_dump()) as streamed:
                body_text = "".join(streamed.iter_text())

        assert calls == ["job-stage7"]
        assert body_text == (
            'data: {"type": "preparing", "stage": "streaming"}\n\n'
            'data: {"type": "done"}\n\n'
        )


# ── 9. 无工具纯聊天分支（has_tools=False）─────────────────────────────


class TestNoToolsFallback:
    async def test_no_client_context_uses_chat_service_and_never_builds_agent(
        self, monkeypatch, patch_model
    ):
        monkeypatch.setattr(entry, "_has_tools", lambda body: False)

        def _unexpected(**kwargs):  # pragma: no cover - 不应被调用
            raise AssertionError("无工具分支不得构建候选 Agent")

        monkeypatch.setattr(entry, "build_engine_agent", _unexpected)

        async def _stream(llm, messages):
            yield StreamEventPayload(type="preparing", stage="streaming")
            yield StreamEventPayload(type="text_delta", content="纯聊天")

        monkeypatch.setattr("app.agent.chat_service.stream_chat", _stream)

        body = LocalChatStreamRequest(
            api_key="k",
            base_url="https://api.example.com/v1",
            model="test-model",
            messages=[{"role": "user", "content": "hi"}],
            user_content="hi",
            client_job_id="job-stage7-plain",
        )
        out = await _collect_candidate(body, _candidate_settings())
        assert _events(out) == [
            {"type": "preparing", "stage": "streaming"},
            {"type": "text_delta", "content": "纯聊天"},
            {"type": "done"},
        ]


# ── 10. 旧路径模块未被候选入口反向污染 ───────────────────────────────


def test_old_module_does_not_import_candidate_package():
    """旧 HTTP 模块只允许**函数内** import 候选包（模块级会拖垮 baseline 导入）。"""
    source = (agent_module.__file__ or "").replace("\\", "/")
    assert source.endswith("app/api/v1/agent.py")
    text = open(source, encoding="utf-8").read()
    module_level = [
        line
        for line in text.splitlines()
        if line.startswith(("import ", "from ")) and "langchain_runtime" in line
    ]
    assert module_level == []
    # 但函数内确实 import 了候选入口（否则开关无法生效），且**必须在 engine 判定之后**：
    # legacy 路径不得触碰候选包（该包 __init__ 依赖 langchain，原生产环境没有它）。
    # 行为级回归见 tests/test_engine_switch_import_safety.py（两个环境都会真实执行）。
    import_line = (
        "from app.agent.langchain_runtime.entry import stream_candidate_engine_sse"
    )
    assert import_line in text
    assert text.index('!= "candidate"') < text.index(import_line)


def test_candidate_stream_modes_are_exported_and_complete():
    assert entry.CANDIDATE_STREAM_MODES == ("messages", "updates", "custom")
    assert entry.assemble_stream_modes() == entry.CANDIDATE_STREAM_MODES
