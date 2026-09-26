"""阶段 7 回归：``legacy`` 引擎路径**不得** import 候选包。

为什么单独立这个文件（而不是放进候选测试）：

- 该缺陷**只在没有 ``langchain`` 包的环境里、且走路由函数时才可见**——候选测试
  在 baseline 环境被 ``pytest.importorskip("langchain")`` 整模块跳过，而
  ``tests/test_chat_stream_preparing.py`` 是直接调 ``_stream_local_chat``、
  不经过 ``local_chat_stream``，因此都覆盖不到。
- 本文件**不 import 任何 langchain**，所以两个环境都会真实执行。

回归的缺陷（阶段 7 复核实测）：``local_chat_stream`` 曾在 engine 判定**之前**
``from app.agent.langchain_runtime.entry import stream_engine_sse``。导入子模块会先执行
包的 ``__init__.py`` → ``middleware`` → ``from langchain.agents.middleware import ...``
→ 原生产环境（只有 ``langchain-core``，无 ``langchain``）**每个请求**都抛
``ModuleNotFoundError``。
"""

from __future__ import annotations

import sys
from typing import Any

import pytest

from app.api.v1 import agent as agent_module
from app.core.config import Settings, get_settings
from app.schemas.agent import ClientContextInput, LocalChatStreamRequest

CANDIDATE_ROOT = "app.agent.langchain_runtime"


class _FakeChatOpenAI:
    """占位：``_stream_local_chat`` 已被整体替换，实例不会被真正调用。"""

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


def _body() -> LocalChatStreamRequest:
    return LocalChatStreamRequest(
        api_key="k",
        base_url="https://api.example.com/v1",
        model="test-model",
        messages=[{"role": "user", "content": "hi"}],
        user_content="hi",
        client_job_id="job-import-safety",
        client_context=ClientContextInput(workspace_root="/tmp/ws"),
    )


def _settings(engine: str) -> Settings:
    return get_settings().model_copy(update={"agent_engine": engine})


def _poison_candidate_package(monkeypatch: pytest.MonkeyPatch) -> None:
    """让任何对候选包的 import 立刻失败（模拟无 langchain 的生产环境）。"""

    for name in list(sys.modules):
        if name == CANDIDATE_ROOT or name.startswith(f"{CANDIDATE_ROOT}."):
            monkeypatch.delitem(sys.modules, name, raising=False)
    # sys.modules 里置 None → 后续 import 该包抛 ImportError
    monkeypatch.setitem(sys.modules, CANDIDATE_ROOT, None)


async def _drain(response: Any) -> list[str]:
    return [chunk async for chunk in response.body_iterator]


async def test_legacy_engine_serves_without_importing_candidate_package(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """核心回归：缺 langchain 时，legacy 路径仍必须正常产出 SSE。"""

    _poison_candidate_package(monkeypatch)

    async def fake_legacy_stream(body, settings):
        yield 'data: {"type": "preparing", "stage": "streaming"}\n\n'
        yield 'data: {"type": "done"}\n\n'

    monkeypatch.setattr(agent_module, "_stream_local_chat", fake_legacy_stream)

    response = await agent_module.local_chat_stream(_body(), _settings("legacy"))

    assert await _drain(response) == [
        'data: {"type": "preparing", "stage": "streaming"}\n\n',
        'data: {"type": "done"}\n\n',
    ]


async def test_legacy_engine_does_not_reach_the_candidate_module_at_all(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """即使候选包存在，legacy 路径也不应把它装进 ``sys.modules``。"""

    for name in list(sys.modules):
        if name == CANDIDATE_ROOT or name.startswith(f"{CANDIDATE_ROOT}."):
            monkeypatch.delitem(sys.modules, name, raising=False)

    async def fake_legacy_stream(body, settings):
        yield 'data: {"type": "done"}\n\n'

    monkeypatch.setattr(agent_module, "_stream_local_chat", fake_legacy_stream)

    await agent_module.local_chat_stream(_body(), _settings("legacy"))

    assert CANDIDATE_ROOT not in sys.modules
    assert not any(
        name.startswith(f"{CANDIDATE_ROOT}.") for name in sys.modules
    ), "legacy 路径不应导入候选包的任何子模块"


async def test_candidate_engine_fails_loudly_when_the_package_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``AGENT_ENGINE=candidate`` 但环境缺 langchain 时，必须**明确报错**而不是静默回退。"""

    _poison_candidate_package(monkeypatch)

    with pytest.raises(ImportError):
        await agent_module.local_chat_stream(_body(), _settings("candidate"))


async def test_default_engine_is_candidate_after_the_stage8_switch() -> None:
    """阶段 8 行动 5 已把**副本**默认切为 ``candidate``；``legacy`` 保留为回退开关。

    依赖前提：``candidate`` 需要运行环境安装 ``langchain`` / ``langgraph``。
    """
    assert Settings().agent_engine == "candidate"

    # 回退路径仍然可用且仍然不依赖候选包（上方两个用例已行为级验证）
    settings = Settings(agent_engine="legacy")
    assert settings.agent_engine == "legacy"


def test_candidate_engine_is_opt_in_only() -> None:
    """开关只接受两个字面量，防止拼写错误悄悄切换引擎。"""

    with pytest.raises(Exception):
        Settings(agent_engine="candidat")
