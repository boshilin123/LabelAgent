"""阶段 7 §7-2 遗留项收尾（F3）：**无工具纯聊天分支的逐字节对照**。

阶段 7 记录 §7-2 的原文：「无工具纯聊天分支（``has_tools=False`` 走
``chat_service.stream_chat``）仅用脚本化模型测过，**未做逐帧对照**」。
本文件把该分支补成与阶段 4b 同口径的 **OLD vs NEW 逐字节对照**：

- **OLD**：``app.api.v1.agent._stream_local_chat`` 的 ``has_tools=False`` 分支
  （生产实现，``agent.py:467-498``）；
- **NEW**：``app.agent.langchain_runtime.entry.stream_candidate_engine_sse`` 的
  ``has_tools=False`` 分支（生产实现，``entry.py:656-672``）。

两侧**都自己构造模型**（没有注入点），因此对照用同一个「模型工厂替身」
（``_ScriptedLlmFactory``）替换各自的构造点，其余全部是生产代码；
两边的模型构造参数、``astream`` 调用次数、收到的消息**形态**都被记录并断言相等——
避免「帧相同但输入不同」的假通过。

``has_tools=False`` 的判据是**客户端快照**（``agent.py:220-233`` /
``entry._has_tools``）：无 ``workspace_root``、无 ``active_annotation_project_id``、
无 ``annotation_project_snapshot``。

需要的环境：``langchain``（``entry`` → 包 ``__init__`` → ``middleware``）。
baseline 环境整模块 skip（既有约定）。
"""

from __future__ import annotations

import json
from typing import Any

import pytest

pytest.importorskip("langchain")

from langchain_core.messages import AIMessageChunk  # noqa: E402

from app.agent.langchain_runtime import entry  # noqa: E402
from app.api.v1 import agent as agent_module  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.schemas.agent import ClientContextInput, LocalChatStreamRequest  # noqa: E402

NO_TOOLS_CTX = ClientContextInput()
"""无工作区 / 无标注项目 / 无快照 ⇒ 两条路径都必须走纯聊天分支。"""


class ScriptedStreamLlm:
    """脚本化 ``astream`` 模型（duck-typed，与 ``chat_service.stream_chat`` 的用法一致）。

    刻意**不是** ``BaseChatModel``：``chat_service`` 只调 ``llm.astream(list)``，
    这里如实实现该最小面，以免引入与本对照无关的框架行为。
    """

    def __init__(self, rounds: list[list[AIMessageChunk]]) -> None:
        self._rounds = [list(round_) for round_ in rounds]
        self.astream_calls = 0
        self.seen_messages: list[list[Any]] = []

    async def astream(self, messages):
        self.astream_calls += 1
        self.seen_messages.append(list(messages))
        for chunk in (self._rounds.pop(0) if self._rounds else []):
            yield chunk


class ScriptedLlmFactory:
    """替换 ``ChatOpenAI`` 的**工厂**：记录构造参数，每次返回同一个脚本化模型。"""

    def __init__(self, rounds: list[list[AIMessageChunk]]) -> None:
        self.ctor_kwargs: list[dict[str, Any]] = []
        self.models: list[ScriptedStreamLlm] = []
        self.rounds = [list(round_) for round_ in rounds]

    def __call__(self, **kwargs: Any) -> ScriptedStreamLlm:
        self.ctor_kwargs.append(dict(kwargs))
        model = ScriptedStreamLlm([list(round_) for round_ in self.rounds])
        self.models.append(model)
        return model


def _rounds() -> list[list[AIMessageChunk]]:
    """一轮多分片：文本 + reasoning（``emit_tool_chunks=False`` 下也要正确映射）。"""
    return [
        [
            AIMessageChunk(content="你好，"),
            AIMessageChunk(content="我是本地助手。"),
            AIMessageChunk(
                content="", additional_kwargs={"reasoning_content": "「思考」字段"}
            ),
            AIMessageChunk(content=""),  # 空内容分片：不得产出任何帧
        ],
        [AIMessageChunk(content="第二轮不应发生。")],
    ]


def _body(*, job_prefix: str) -> LocalChatStreamRequest:
    return LocalChatStreamRequest(
        api_key="k",
        base_url="https://api.example.com/v1",
        model="scripted",
        messages=[{"role": "user", "content": "你好"}],
        user_content="你好",
        client_job_id=f"{job_prefix}-no-tools",
        client_context=NO_TOOLS_CTX,
    )


async def _legacy_raw_sse() -> tuple[list[str], dict[str, Any]]:
    """OLD：逐**原始字符串**收集 ``_stream_local_chat`` 的产出。"""
    recorder = ScriptedLlmFactory(_rounds())
    original = agent_module.ChatOpenAI
    agent_module.ChatOpenAI = recorder  # type: ignore[assignment]
    try:
        raw = [
            chunk
            async for chunk in agent_module._stream_local_chat(
                _body(job_prefix="job-f3-legacy"), get_settings()
            )
        ]
    finally:
        agent_module.ChatOpenAI = original  # type: ignore[assignment]
    return raw, _observations(recorder)


async def _candidate_raw_sse() -> tuple[list[str], dict[str, Any]]:
    """NEW：逐**原始字符串**收集候选入口的产出。"""
    recorder = ScriptedLlmFactory(_rounds())
    original = entry.ChatOpenAI
    entry.ChatOpenAI = recorder  # type: ignore[assignment]
    try:
        raw = [
            chunk
            async for chunk in entry.stream_candidate_engine_sse(
                _body(job_prefix="job-f3-candidate"), get_settings()
            )
        ]
    finally:
        entry.ChatOpenAI = original  # type: ignore[assignment]
    return raw, _observations(recorder)


def _observations(recorder: ScriptedLlmFactory) -> dict[str, Any]:
    return {
        "ctor_kwargs": recorder.ctor_kwargs,
        "astream_calls": [model.astream_calls for model in recorder.models],
        "seen_message_kinds": [
            [getattr(message, "type", type(message).__name__) for message in seen]
            for model in recorder.models
            for seen in model.seen_messages
        ],
    }


class TestNoToolsPureChatIsByteIdentical:
    """``has_tools=False``：候选入口与旧路径的 SSE 字符串列表**逐字节相同**。"""

    async def test_raw_sse_strings_are_identical(self):
        old_raw, old_obs = await _legacy_raw_sse()
        new_raw, new_obs = await _candidate_raw_sse()

        assert old_raw == new_raw, "无工具纯聊天分支的 SSE 字符串必须逐字节相同"
        # 顺带钉住形状（不是从生成器倒推的期望值）：
        assert [json.loads(chunk[len("data: ") :])["type"] for chunk in old_raw] == [
            "preparing",
            "text_delta",
            "text_delta",
            "reasoning_delta",
            "done",
        ]
        assert old_raw[0] == 'data: {"type": "preparing", "stage": "streaming"}\n\n'
        assert old_raw[-1] == 'data: {"type": "done"}\n\n'

        # 两侧必须拿到同一份模型输入，否则「帧相同」可能是巧合。
        assert old_obs == new_obs
        assert old_obs["ctor_kwargs"] == [
            {
                "model": "scripted",
                "api_key": "k",
                "base_url": "https://api.example.com/v1",
                "streaming": True,
                "temperature": 0.7,
                "timeout": 120,
                "extra_body": None,
            }
        ]
        assert old_obs["astream_calls"] == [1], "纯聊天分支只应有一次模型流调用"
        assert old_obs["seen_message_kinds"] == [["system", "human"]]

    async def test_aux_fields_are_ignored_on_both_sides(self):
        """``aux_*`` 为空（默认）时两侧都只构造**一个**模型实例。"""
        _old_raw, old_obs = await _legacy_raw_sse()
        _new_raw, new_obs = await _candidate_raw_sse()

        assert len(old_obs["ctor_kwargs"]) == 1
        assert len(new_obs["ctor_kwargs"]) == 1

    async def test_has_tools_false_branch_is_selected_by_the_client_snapshot(self):
        """反证：**无工具**快照若被误送进候选内核装配，会硬断言失败。

        ``entry.build_agent_run_plan`` 在工具清单为空时硬断言（阶段 5 §5-2）；
        候选入口对 ``has_tools=False`` 的请求必须先分流到 ``chat_service``。
        本用例同时钉住「分流确实发生」（上一用例）与「误分流会响」（本用例）。
        """
        with pytest.raises(AssertionError, match="工具清单为空"):
            entry.build_agent_run_plan(
                tools=[],
                stream_modes=entry.CANDIDATE_STREAM_MODES,
                is_resume=False,
                has_tools=False,
            )
