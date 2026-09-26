"""阶段 8 前半：故障注入套件（**候选引擎**行为，逐条钉住期望结果）。

覆盖迁移计划 §5-阶段 8 行动 2 的八类故障，并另加旧/新同场景对照：

1. **模型故障**：流中途抛异常（``RuntimeError``，含多轮场景）与模型超时
   （``TimeoutError``）——两者都**不重试**、**不补 ``done``**、**不产 ``error`` 帧**；
2. **工具故障**：工具抛异常 / 工具超时。写类（``PROPOSAL``）工具**恰好执行一次、
   绝不重试**；只读工具在 ``ConnectionError`` / ``TimeoutError`` 下是候选路径的
   **已知差异**（``ToolRetryMiddleware`` 重试到 3 次，旧路径只有 1 次），单独钉住；
3. **MCP 断开**：loader 抛异常 / 返回 ``[]`` —— 本轮必须存活、无 ``error`` 帧；
4. **重复工具结果**：resume 请求重复投递同一 ``tool_call_id`` 必须幂等
   （只补一条 ``ToolMessage``、零重复执行、**不重复发 ``tool_pending``**）；
5. **取消竞态**：首个帧之前 / 轮之间 / ``tool_pending`` 边界——冻结语义是
   「已取出的在途帧被丢弃、``done`` 仍发出、已执行事实不可撤销、未执行的不执行」；
6. **非法工具参数**：类型不匹配 / 缺必填 / JSON 截断——本轮存活、无 ``error`` 帧、
   工具体恰好被调用一次（**与旧路径同构：两边都不做 schema 校验**）；
7. **阶段违规**：用户未确认（``AWAIT_CONFIRM``）与重复重标已 applied 路径
   （``VERIFY``）——零写盘执行 + **逐字**等于旧路径的拒绝理由文本。

每个用例同时断言四件事：**精确的帧类型序列**、**无 ``error`` 帧**、
**``done`` 的有无（按契约）**、**真实模型/工具调用次数**（与阶段 0 的
``tests/test_agent_baseline_contract.py`` 同一口径：统计注入的存根函数被调用几次）。

## 与旧路径的对照方式

`TestOldNewParity` 及若干 ``*_matches_old_path`` 用例用**同一批脚本化素材**同时驱动：

- 旧路径：真实 ``app.api.v1.agent._stream_local_chat``（含 ``preparing(mcp)`` 与 ``done``）；
- 候选路径：真实 ``app.agent.langchain_runtime.entry.stream_candidate_engine_sse``。

两侧只替换「模型工厂 + 工具集 + MCP loader」，因此差异可归因于引擎本身。

## 本文件曾发现的两处**候选侧偏离旧契约**（已裁决并修复，2026-09-23）

- **D1（已修复）**：写类（``PROPOSAL``）工具失败时，``tool_result.result`` 曾比旧路径
  多两个键（``file_written`` / ``proposal_pending``）。只读工具失败走摘要化通道，
  差异被掩盖，故阶段 0/4b 均未发现。**裁决：修** —— ``middleware._old_error_text``
  改为逐字复刻 ``tool_loop.py:101-104`` 的手写四键载荷。
- **D2（已修复）**：只读工具抛 ``ConnectionError`` / ``TimeoutError`` 时曾执行 **3 次**
  （``ToolRetryMiddleware(max_retries=2)`` + ``RETRYABLE_TOOL_NAMES``），旧路径执行 **1 次**；
  且该重试在**帧与日志里都不可见**（``tool_retry.py`` 全文件无日志），还会重跑
  ``explore_readonly`` 子代理。**裁决：修** —— ``RETRYABLE_TOOL_NAMES`` 改为空集
  （计划 §5-阶段 2 的重试措辞属可选；强制部分「标注写入不自动重试」由「完全不重试」同样满足）。

下方两个用例现断言**与旧路径严格相等**（各执行 1 次、载荷逐字节相同）。

全部离线、确定性：脚本化模型 + 存根工具 + 假 MCP loader；无网络、无真实 provider、
无 YOLO、无 Docker、无真实工作区写入。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pytest

# baseline 环境（无 langchain/langgraph）整体 skip 而不是 collect error。
# 本文件所有用例都驱动候选引擎，因此**没有**「两个环境都跑」的用例；
# baseline 全量通过数保持 329 不被本文件改变。
pytest.importorskip("langchain")

from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import (  # noqa: E402
    AIMessage,
    AIMessageChunk,
    ToolMessage,
)
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
)
from langchain_core.tools import StructuredTool  # noqa: E402
from pydantic import Field  # noqa: E402

from app.agent.langchain_runtime import entry  # noqa: E402
from app.api.v1 import agent as agent_module  # noqa: E402
from app.core.config import Settings, get_settings  # noqa: E402
from app.schemas.agent import (  # noqa: E402
    ClientContextInput,
    LocalChatStreamRequest,
)

pytestmark = pytest.mark.filterwarnings(
    "ignore:Pydantic serializer warnings:UserWarning"
)

ROUTE = "/api/v1/agent/chat/stream"
CANCEL_ROUTE = "/api/v1/agent/chat/cancel"

WORKSPACE_CTX = ClientContextInput(workspace_root="/tmp/ws")
MCP_URL = "http://127.0.0.1:9000"


# ── 脚本化素材：候选路径（``BaseChatModel``）────────────────────────────


class ScriptedChat(BaseChatModel):
    """按轮次返回预设项的假聊天模型。

    ``rounds[i]`` 是第 ``i`` 次模型调用的产出清单，元素为 ``AIMessageChunk``
    （正常分片）或 ``BaseException`` 实例（在该位置抛出，用于「流中途失败」）。
    """

    rounds: list[list[Any]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)
    seen_messages: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "lr-agent-scripted-stage8-faults"

    @property
    def invoke_calls(self) -> int:
        """真实模型调用次数（= ``_astream`` 进入次数）。"""
        return int(self.counters.get("invoke_calls", 0))

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [getattr(t, "name", str(t)) for t in tools]
        return self

    def _items(self) -> list[Any]:
        index = int(self.counters.get("invoke_calls", 0))
        self.counters["invoke_calls"] = index + 1
        if index < len(self.rounds):
            return list(self.rounds[index])
        return [AIMessageChunk(content="")]

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        merged: AIMessageChunk | None = None
        for item in self._items():
            if isinstance(item, BaseException):
                raise item
            merged = item if merged is None else merged + item
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="" if merged is None else merged.content,
                        tool_calls=[] if merged is None else list(merged.tool_calls or []),
                    )
                )
            ]
        )

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen_messages.append(list(messages))
        for item in self._items():
            if isinstance(item, BaseException):
                raise item
            yield ChatGenerationChunk(message=item)


# ── 脚本化素材：旧路径（``stream_assist`` 要的是 ``bind_tools`` + 裸 chunk）──


class Chunk:
    """旧路径的脚本化分片（字段与 ``AIMessageChunk`` 同形，另实现 ``__add__``）。"""

    def __init__(self, content: str = "", tool_calls=None, tool_call_chunks=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.tool_call_chunks = tool_call_chunks or []
        self.additional_kwargs: dict[str, Any] = {}

    def __add__(self, other: "Chunk") -> "Chunk":
        return Chunk(
            content=(self.content or "") + (other.content or ""),
            tool_calls=list(self.tool_calls) + list(other.tool_calls),
            tool_call_chunks=list(self.tool_call_chunks)
            + list(other.tool_call_chunks),
        )


class OldScriptedChat:
    """旧路径的脚本化模型：按轮次 yield 裸 ``Chunk``；遇异常对象则抛出。"""

    def __init__(self, rounds: list[list[Any]]) -> None:
        self._rounds = list(rounds)
        self.astream_calls = 0
        self.bound_tool_names: list[str] = []
        self.seen_messages: list[list[Any]] = []

    def bind_tools(self, tools, tool_choice=None):
        self.bound_tool_names = [getattr(t, "name", str(t)) for t in tools]
        return self

    async def astream(self, messages):
        self.astream_calls += 1
        self.seen_messages.append(list(messages))
        items = self._rounds.pop(0) if self._rounds else []
        for item in items:
            if isinstance(item, BaseException):
                raise item
            yield item

    async def ainvoke(self, messages):
        return Chunk(content="")


def text_chunk(text: str) -> AIMessageChunk:
    return AIMessageChunk(content=text)


def call_round(
    calls: list[tuple[str, str, dict[str, Any]]], *, split: bool = True
) -> list[AIMessageChunk]:
    """一轮工具调用（候选侧）：每个调用跨两块 ``tool_call_chunks``（真实 provider 同形）。"""
    out: list[AIMessageChunk] = []
    for index, (call_id, name, args) in enumerate(calls):
        raw = json.dumps(args, ensure_ascii=False)
        if split:
            head, tail = raw[: len(raw) // 2], raw[len(raw) // 2 :]
        else:
            head, tail = raw, ""
        out.append(
            AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": name,
                        "args": head,
                        "id": call_id,
                        "index": index,
                        "type": "tool_call_chunk",
                    }
                ],
            )
        )
        out.append(
            AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": None,
                        "args": tail,
                        "id": None,
                        "index": index,
                        "type": "tool_call_chunk",
                    }
                ],
            )
        )
    return out


def raw_call_round(call_id: str, name: str, raw_args: str) -> list[AIMessageChunk]:
    """一轮工具调用，``args`` 为**未经解析的原始字符串**（用于脏 JSON 用例）。"""
    return [
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "name": name,
                    "args": raw_args,
                    "id": call_id,
                    "index": 0,
                    "type": "tool_call_chunk",
                }
            ],
        )
    ]


def old_round(calls: list[tuple[str, str, dict[str, Any]]]) -> list[Chunk]:
    """旧路径的一轮工具调用（``tool_calls`` 与 ``tool_call_chunks`` 同时给出）。"""
    out: list[Chunk] = []
    for index, (call_id, name, args) in enumerate(calls):
        out.append(
            Chunk(
                tool_calls=[{"id": call_id, "name": name, "args": dict(args)}],
                tool_call_chunks=[
                    {
                        "name": name,
                        "args": json.dumps(args, ensure_ascii=False),
                        "id": call_id,
                        "index": index,
                    }
                ],
            )
        )
    return out


def make_tools(specs: dict[str, dict[str, Any]]):
    """``{name: {"result": dict|None, "raises": Exception|None, "properties": dict|None,
    "required": list|None}}`` → ``(tools, executions)``。

    ``executions[name]`` 是该工具**真实被调用**的参数列表；长度即执行次数
    （与阶段 0 ``test_agent_baseline_contract.make_tools`` 同一口径）。
    """
    executions: dict[str, list[dict]] = {name: [] for name in specs}
    tools: list[StructuredTool] = []

    for name, spec in specs.items():
        def _make(tool_name=name, tool_spec=spec):
            def _fn(**kwargs):
                executions[tool_name].append(kwargs)
                if tool_spec.get("raises") is not None:
                    raise tool_spec["raises"]
                payload = tool_spec.get("result") or {
                    "ok": True,
                    "summary": f"{tool_name} ok",
                }
                return json.dumps(payload, ensure_ascii=False)

            return _fn

        schema: dict[str, Any] = {
            "type": "object",
            "properties": spec.get("properties") or {},
        }
        if spec.get("required"):
            schema["required"] = spec["required"]
        tools.append(
            StructuredTool(
                name=name,
                description=f"{name} stub",
                func=_make(),
                args_schema=schema,
            )
        )
    return tools, executions


# ── 取消注入 ───────────────────────────────────────────────────────────


class CancelAfter:
    """第 n 次 ``is_cancelled()`` 调用起返回 True（与阶段 0 基线同款）。

    候选入口在每个**待发帧**之前查一次取消，因此 ``CancelAfter(n)`` 精确定位
    「第 n 帧被丢弃」——这就是冻结的「在途帧被丢弃」语义。
    """

    def __init__(self, n: int) -> None:
        self.n = n
        self.calls = 0

    async def __call__(self) -> bool:
        self.calls += 1
        return self.calls >= self.n


# ── 请求构造 ───────────────────────────────────────────────────────────


def make_body(
    *,
    messages: list[dict[str, Any]] | None = None,
    client_tool_results: list[dict[str, Any]] | None = None,
    client_context: ClientContextInput | None = None,
    user_content: str = "执行任务",
    client_job_id: str = "job-stage8",
    mcp_server_url: str | None = None,
) -> LocalChatStreamRequest:
    context = client_context if client_context is not None else ClientContextInput(
        workspace_root="/tmp/ws"
    )
    if mcp_server_url is not None:
        context.mcp_server_url = mcp_server_url
    return LocalChatStreamRequest(
        api_key="k",
        base_url="https://api.example.com/v1",
        model="test-model",
        messages=messages or [{"role": "user", "content": user_content}],
        user_content=user_content,
        client_job_id=client_job_id,
        client_tool_results=client_tool_results or [],
        client_context=context,
    )


# ── 结果容器与驱动 ─────────────────────────────────────────────────────


@dataclass
class Run:
    frames: list[dict[str, Any]] = field(default_factory=list)
    error: BaseException | None = None
    model_calls: int = 0
    executions: dict[str, list[dict]] = field(default_factory=dict)
    seen_messages: list[list[Any]] = field(default_factory=list)

    @property
    def types(self) -> list[str]:
        return [frame["type"] for frame in self.frames]

    @property
    def has_done(self) -> bool:
        return any(frame["type"] == "done" for frame in self.frames)

    @property
    def has_error(self) -> bool:
        return any(frame["type"] == "error" for frame in self.frames)

    def execution_count(self, name: str) -> int:
        return len(self.executions[name])

    def total_executions(self) -> int:
        return sum(len(items) for items in self.executions.values())

    def results(self, tool_call_id: str) -> list[str]:
        return [
            frame["result"]
            for frame in self.frames
            if frame["type"] == "tool_result" and frame["toolCallId"] == tool_call_id
        ]

    def tool_messages(self, index: int = -1) -> list[ToolMessage]:
        messages = self.seen_messages[index]
        return [message for message in messages if isinstance(message, ToolMessage)]


def parse_frames(chunks: list[str]) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    for block in "".join(chunks).split("\n\n"):
        block = block.strip()
        if block.startswith("data: "):
            frames.append(json.loads(block[len("data: ") :]))
    return frames


def patch_mcp(monkeypatch, loader) -> None:
    """候选与旧路径的 MCP loader 落点不同，两处都 patch。

    候选入口 ``entry.merge_mcp_tools`` 是**函数内 import**，patch ``entry``
    模块属性无效——必须 patch 定义模块 ``app.agent.tools.mcp_client``。
    """
    monkeypatch.setattr(
        "app.agent.tools.mcp_client.load_mcp_tools_from_servers", loader
    )
    monkeypatch.setattr("app.api.v1.agent.load_mcp_tools_from_servers", loader)


async def run_candidate(
    monkeypatch,
    *,
    rounds: list[list[Any]],
    specs: dict[str, dict[str, Any]],
    request: LocalChatStreamRequest,
    cancel_at: int | None = None,
    mcp_loader: Any = None,
    on_plan: Any = None,
) -> Run:
    tools, executions = make_tools(specs)
    model = ScriptedChat(rounds=rounds)
    monkeypatch.setattr(entry, "ChatOpenAI", lambda **kwargs: model)
    monkeypatch.setattr(entry, "build_local_tools", lambda body, settings: list(tools))
    if mcp_loader is not None:
        patch_mcp(monkeypatch, mcp_loader)

    cancel = CancelAfter(cancel_at) if cancel_at is not None else None
    chunks: list[str] = []
    error: BaseException | None = None
    try:
        async for chunk in entry.stream_candidate_engine_sse(
            request,
            Settings(agent_engine="candidate"),
            is_cancelled=cancel,
            on_plan=on_plan,
        ):
            chunks.append(chunk)
    except BaseException as exc:  # noqa: BLE001 - 故障用例要看到真实异常
        error = exc

    return Run(
        frames=parse_frames(chunks),
        error=error,
        model_calls=model.invoke_calls,
        executions=executions,
        seen_messages=model.seen_messages,
    )


async def run_old(
    monkeypatch,
    *,
    rounds: list[list[Any]],
    specs: dict[str, dict[str, Any]],
    request: LocalChatStreamRequest,
    cancel_preset: bool = False,
    mcp_loader: Any = None,
) -> Run:
    tools, executions = make_tools(specs)
    model = OldScriptedChat(rounds)
    monkeypatch.setattr(agent_module, "ChatOpenAI", lambda **kwargs: model)
    monkeypatch.setattr(
        agent_module, "build_tools_by_name_set", lambda *args, **kwargs: list(tools)
    )
    if mcp_loader is not None:
        patch_mcp(monkeypatch, mcp_loader)
    if cancel_preset:
        event = _set_event()
        monkeypatch.setattr(
            agent_module, "_get_or_create_cancel_event", lambda job_id: event
        )

    chunks: list[str] = []
    error: BaseException | None = None
    try:
        async for chunk in agent_module._stream_local_chat(request, Settings()):
            chunks.append(chunk)
    except BaseException as exc:  # noqa: BLE001
        error = exc

    return Run(
        frames=parse_frames(chunks),
        error=error,
        model_calls=model.astream_calls,
        executions=executions,
        seen_messages=model.seen_messages,
    )


def _set_event():
    import asyncio

    event = asyncio.Event()
    event.set()
    return event


# ── 共享 patch / 素材 ─────────────────────────────────────────────────

READ_OK = {"result": {"ok": True, "summary": "已读取 a.md"}}
ANNOTATE_PENDING = {"result": {"ok": True, "summary": "不应在后端执行"}}
WRITE_OK = {"result": {"ok": True, "summary": "已写入", "file_written": True}}

READ_WITH_SCHEMA = {
    **READ_OK,
    "properties": {"relative_path": {"type": "string"}},
    "required": ["relative_path"],
}

AWAIT_CONFIRM_CTX = ClientContextInput(
    workspace_root="/tmp/ws",
    proposal_states=[
        {"path": "data/1.jpg", "kind": "annotation", "status": "pending"}
    ],
)
VERIFY_CTX = ClientContextInput(
    workspace_root="/tmp/ws",
    proposal_states=[
        {
            "path": "data/1.jpg",
            "kind": "annotation",
            "status": "applied",
            "annotation_ids": ["ann-1"],
        }
    ],
)

PENDING_REASON = (
    "当前存在未确认的标注提案（data/1.jpg），用户尚未 Keep All，提案未写盘。"
    "禁止标注写入与文件写入操作。请用一两句说明提案内容，"
    "提示用户 Keep All 或关闭提案后再继续。"
)
VERIFY_PATH_REASON = (
    "以下文件本轮已完成标注并经用户确认落盘：data/1.jpg。请勿重复标注。"
    "如核对后认为确需重标，必须向用户说明检测到的不一致"
    "（检测到几个框、标签是什么、与预期差在哪），"
    "并给出确切的下一步指令（如「请说：重新标注 data/x.jpg」），由用户发起。"
)
VERIFY_ALL_FILES_REASON = (
    "以下文件本轮已完成标注并经用户确认落盘：data/1.jpg。"
    "禁止 all_files=true 的全量重标；如确需对其他文件标注，请用 paths 明确指定。"
)

TOOL_ERROR_TEXT = "工具执行失败: 磁盘炸了"


def _old_error_payload(tool: str, exc_text: str = TOOL_ERROR_TEXT) -> str:
    """旧路径 ``tool_loop.py:101-104`` 的**四键**错误载荷（逐字复刻，无摘要化）。"""
    return json.dumps(
        {"ok": False, "tool": tool, "status": "error", "summary": exc_text},
        ensure_ascii=False,
    )


def _phase_blocked_payload(tool: str, reason: str) -> str:
    return json.dumps(
        {
            "ok": False,
            "tool": tool,
            "status": "phase_blocked",
            "summary": reason,
            "file_written": False,
            "proposal_pending": False,
        },
        ensure_ascii=False,
    )


@pytest.fixture(autouse=True)
def _clean_cancel_registry():
    agent_module._cancel_events.clear()
    yield
    agent_module._cancel_events.clear()


# ── 1. 模型故障 ────────────────────────────────────────────────────────


class TestModelFaults:
    """模型流中途失败 / 超时：截断、无 ``done``、无 ``error`` 帧、不重试。"""

    async def test_model_raises_mid_stream_truncates_without_done_or_error_frame(
        self, monkeypatch
    ):
        run = await run_candidate(
            monkeypatch,
            rounds=[
                [text_chunk("前半截"), RuntimeError("模型炸了")],
                [text_chunk("不应到达")],
            ],
            specs={"read_workspace_file": READ_OK},
            request=make_body(),
        )

        assert run.types == ["preparing", "text_delta"]
        assert run.frames == [
            {"type": "preparing", "stage": "streaming"},
            {"type": "text_delta", "content": "前半截"},
        ]
        assert isinstance(run.error, RuntimeError)
        assert str(run.error) == "模型炸了"
        assert run.has_done is False
        assert run.has_error is False
        # 不重试：只发生一次模型调用
        assert run.model_calls == 1
        # 工具零执行
        assert run.executions["read_workspace_file"] == []

    async def test_model_timeout_at_first_chunk_propagates_without_done(self, monkeypatch):
        run = await run_candidate(
            monkeypatch,
            rounds=[[TimeoutError("model timeout")], [text_chunk("不应到达")]],
            specs={"read_workspace_file": READ_OK},
            request=make_body(),
        )

        assert run.types == ["preparing"]
        assert isinstance(run.error, TimeoutError)
        assert run.model_calls == 1
        assert run.has_done is False
        assert run.has_error is False
        assert run.total_executions() == 0

    async def test_model_failure_after_a_tool_round_keeps_the_single_execution(
        self, monkeypatch
    ):
        """工具轮成功、第二轮模型中途失败：工具**恰好一次**，收尾帧丢失。"""
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("正在总结"), RuntimeError("模型炸了")],
            ],
            specs={"read_workspace_file": READ_OK},
            request=make_body(),
        )

        assert run.types == ["preparing", "tool_start", "tool_result", "text_delta"]
        assert isinstance(run.error, RuntimeError)
        assert run.executions["read_workspace_file"] == [{"relative_path": "a.md"}]
        assert run.model_calls == 2
        assert run.has_done is False
        assert run.has_error is False

    async def test_old_path_also_truncates_without_done_or_error_frame(self, monkeypatch):
        """旧/新同构：两侧都不补 ``done``、都不产 ``error`` 帧（``try/finally`` 无 ``except``）。"""
        old = await run_old(
            monkeypatch,
            rounds=[
                [Chunk(content="前半截"), RuntimeError("模型炸了")],
                [Chunk(content="不应到达")],
            ],
            specs={"read_workspace_file": READ_OK},
            request=make_body(),
        )
        new = await run_candidate(
            monkeypatch,
            rounds=[
                [text_chunk("前半截"), RuntimeError("模型炸了")],
                [text_chunk("不应到达")],
            ],
            specs={"read_workspace_file": READ_OK},
            request=make_body(),
        )

        assert old.frames == new.frames
        assert old.types == ["preparing", "text_delta"]
        assert isinstance(old.error, RuntimeError)
        assert new.has_done is old.has_done is False
        assert new.has_error is old.has_error is False


# ── 2. 工具故障（恰好一次 / 写类不重试）────────────────────────────────


class TestToolFaults:
    """工具抛异常 / 超时：带内错误 ``tool_result``、无 ``error`` 帧、写类恰好一次。"""

    async def test_raising_write_tool_is_exactly_once_and_no_error_frame(self, monkeypatch):
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [("d1", "delete_workspace_file", {"relative_path": "a.md"})]
                ),
                [text_chunk("删除失败。")],
            ],
            specs={"delete_workspace_file": {"raises": RuntimeError("磁盘炸了")}},
            request=make_body(),
        )

        assert run.types == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        assert run.has_done is True
        assert run.has_error is False
        assert run.results("d1") == [_old_error_payload("delete_workspace_file")]
        # 写类工具恰好执行一次（不重试）
        assert run.executions["delete_workspace_file"] == [{"relative_path": "a.md"}]
        assert run.model_calls == 2

    async def test_timing_out_write_tool_is_exactly_once_despite_retryable_class(
        self, monkeypatch
    ):
        """写类工具**永不重试**（阶段 8 裁决 D2 后任何工具都不重试）→ 恰好一次。"""
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [("d1", "delete_workspace_file", {"relative_path": "a.md"})]
                ),
                [text_chunk("删除超时。")],
            ],
            specs={
                "delete_workspace_file": {"raises": TimeoutError("tool timeout")}
            },
            request=make_body(),
        )

        assert run.execution_count("delete_workspace_file") == 1
        assert run.types == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        assert run.results("d1") == [
            _old_error_payload("delete_workspace_file", "工具执行失败: tool timeout")
        ]
        assert run.has_error is False

    async def test_raising_read_tool_reports_summary_and_runs_once(self, monkeypatch):
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("读取失败。")],
            ],
            specs={"read_workspace_file": {"raises": RuntimeError("磁盘炸了")}},
            request=make_body(),
        )

        assert run.types == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        # 只读工具失败走显示层摘要化（旧/新一致），不是原始 JSON
        assert run.results("r1") == [TOOL_ERROR_TEXT]
        assert run.execution_count("read_workspace_file") == 1
        assert run.has_error is False

    async def test_read_only_timeout_executes_exactly_once_like_the_old_path(
        self, monkeypatch
    ):
        """**D2 修复回归**：只读工具抛 ``TimeoutError`` 时两侧都**只执行 1 次**。

        修复前候选执行 3 次（``ToolRetryMiddleware(max_retries=2)`` 对只读白名单生效），
        而帧序列两侧**逐字节相同**、``tool_retry.py`` 全文件无日志——重试在帧与日志里
        都不可见。裁决：``RETRYABLE_TOOL_NAMES`` 改为空集，恢复严格等价。
        """
        new = await run_candidate(
            monkeypatch,
            rounds=[
                call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("读取超时。")],
            ],
            specs={"read_workspace_file": {"raises": TimeoutError("read timeout")}},
            request=make_body(),
        )
        old = await run_old(
            monkeypatch,
            rounds=[
                old_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
                [Chunk(content="读取超时。")],
            ],
            specs={"read_workspace_file": {"raises": TimeoutError("read timeout")}},
            request=make_body(),
        )

        assert new.execution_count("read_workspace_file") == 1
        assert old.execution_count("read_workspace_file") == 1
        assert new.frames == old.frames
        assert new.types == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        assert new.results("r1") == ["工具执行失败: read timeout"]
        assert new.has_error is False

    async def test_failing_write_tool_dismisses_the_streamed_card_and_writes_nothing(
        self, monkeypatch
    ):
        """带 ``content`` 的写盘失败：流式卡片必须补 ``dismissed`` 收掉，避免 Keep All 写空内容。"""
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [
                        (
                            "w1",
                            "write_workspace_file",
                            {"relative_path": "a.md", "content": "x"},
                        )
                    ]
                ),
                [text_chunk("写入失败。")],
            ],
            specs={"write_workspace_file": {"raises": RuntimeError("磁盘炸了")}},
            request=make_body(),
        )

        assert run.types == [
            "preparing",
            "file_proposal_start",
            "file_proposal_delta",
            "tool_start",
            "tool_result",
            "file_proposal",
            "text_delta",
            "done",
        ]
        dismissed = [
            frame for frame in run.frames if frame["type"] == "file_proposal"
        ]
        assert [frame["status"] for frame in dismissed] == ["dismissed"]
        assert [frame["content"] for frame in dismissed] == [""]
        assert run.execution_count("write_workspace_file") == 1
        assert run.has_error is False

    async def test_write_failure_payload_is_byte_identical_to_the_old_path(
        self, monkeypatch
    ):
        """**D1 修复回归**：写类工具失败时 ``tool_result.result`` 与旧路径**逐字节相同**。

        修复前候选走 ``build_tool_result``（六键），比旧路径 ``tool_loop.py:101-104``
        的手写四键多 ``file_written`` / ``proposal_pending``。只读工具失败在显示层被
        摘要化，差异被掩盖——故阶段 0/4b 未覆盖。裁决：改为手写四键，严格等价。
        """
        spec = {"delete_workspace_file": {"raises": RuntimeError("磁盘炸了")}}
        new = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [("d1", "delete_workspace_file", {"relative_path": "a.md"})]
                ),
                [text_chunk("删除失败。")],
            ],
            specs=spec,
            request=make_body(),
        )
        old = await run_old(
            monkeypatch,
            rounds=[
                old_round(
                    [("d1", "delete_workspace_file", {"relative_path": "a.md"})]
                ),
                [Chunk(content="删除失败。")],
            ],
            specs=spec,
            request=make_body(),
        )

        assert old.results("d1") == [_old_error_payload("delete_workspace_file")]
        assert new.results("d1") == [_old_error_payload("delete_workspace_file")]
        assert new.results("d1") == old.results("d1")
        # 恰好四键，且不含修复前多出的两键
        assert set(json.loads(new.results("d1")[0])) == {
            "ok",
            "tool",
            "status",
            "summary",
        }
        # 帧类型序列与执行次数也完全一致
        assert old.types == new.types
        assert old.total_executions() == new.total_executions() == 1


# ── 3. MCP 断开 ────────────────────────────────────────────────────────


class TestMcpDisconnect:
    """MCP loader 抛异常或返回 ``[]``：本轮存活、无 ``error`` 帧。"""

    @staticmethod
    def _raising_loader():
        async def _loader(*args, **kwargs):
            raise ConnectionError("MCP server unreachable")

        return _loader

    @staticmethod
    def _returning(tools):
        async def _loader(*args, **kwargs):
            return list(tools)

        return _loader

    @staticmethod
    def _stub(name: str) -> StructuredTool:
        def _fn(**kwargs: Any) -> str:
            return json.dumps({"ok": True, "summary": f"{name} ok"}, ensure_ascii=False)

        return StructuredTool(
            name=name,
            description=f"{name} stub",
            func=_fn,
            args_schema={"type": "object", "properties": {}},
        )

    async def test_mcp_loader_raising_keeps_turn_alive_without_error_frame(
        self, monkeypatch
    ):
        plans: list[entry.AgentRunPlan] = []
        run = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("本地工具就绪。")]],
            specs={"read_workspace_file": READ_OK},
            request=make_body(mcp_server_url=MCP_URL),
            mcp_loader=self._raising_loader(),
            on_plan=plans.append,
        )

        assert run.types == ["preparing", "preparing", "text_delta", "done"]
        assert run.frames[0] == {"type": "preparing", "stage": "mcp"}
        assert run.frames[1] == {"type": "preparing", "stage": "streaming"}
        assert run.has_done is True
        assert run.has_error is False
        assert run.error is None
        # MCP 失败后仍装配了本地工具
        assert plans[0].tool_names == ("read_workspace_file",)
        assert run.model_calls == 1

    async def test_mcp_loader_returning_empty_keeps_turn_alive_without_error_frame(
        self, monkeypatch
    ):
        plans: list[entry.AgentRunPlan] = []
        run = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("本地工具就绪。")]],
            specs={"read_workspace_file": READ_OK},
            request=make_body(mcp_server_url=MCP_URL),
            mcp_loader=self._returning([]),
            on_plan=plans.append,
        )

        assert run.types == ["preparing", "preparing", "text_delta", "done"]
        assert run.has_done is True
        assert run.has_error is False
        assert plans[0].tool_names == ("read_workspace_file",)

    async def test_mcp_tools_are_merged_when_the_loader_succeeds(self, monkeypatch):
        plans: list[entry.AgentRunPlan] = []
        await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("MCP 就绪。")]],
            specs={"read_workspace_file": READ_OK},
            request=make_body(mcp_server_url=MCP_URL),
            mcp_loader=self._returning([self._stub("mcp_echo")]),
            on_plan=plans.append,
        )

        assert plans[0].tool_names == ("mcp_echo", "read_workspace_file")

    async def test_no_mcp_frame_when_mcp_is_not_configured(self, monkeypatch):
        run = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("就绪。")]],
            specs={"read_workspace_file": READ_OK},
            request=make_body(mcp_server_url=None),
            mcp_loader=self._raising_loader(),
        )

        assert run.types == ["preparing", "text_delta", "done"]

    async def test_old_and_new_agree_on_mcp_disconnect_frames(self, monkeypatch):
        loader = self._raising_loader()
        new = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("本地工具就绪。")]],
            specs={"read_workspace_file": READ_OK},
            request=make_body(mcp_server_url=MCP_URL),
            mcp_loader=loader,
        )
        old = await run_old(
            monkeypatch,
            rounds=[[Chunk(content="本地工具就绪。")]],
            specs={"read_workspace_file": READ_OK},
            request=make_body(mcp_server_url=MCP_URL),
            mcp_loader=loader,
        )

        assert old.frames == new.frames
        assert old.frames == [
            {"type": "preparing", "stage": "mcp"},
            {"type": "preparing", "stage": "streaming"},
            {"type": "text_delta", "content": "本地工具就绪。"},
            {"type": "done"},
        ]
        assert new.has_error is old.has_error is False


# ── 4. 重复工具结果（resume 幂等）──────────────────────────────────────


def _resume_request(
    *, with_tool_message: bool, duplicate_results: bool = True
) -> LocalChatStreamRequest:
    result = json.dumps(
        {"ok": True, "status": "completed", "file_written": True}, ensure_ascii=False
    )
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": "写一个文件"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "w1",
                    "name": "write_workspace_file",
                    "args": {"relative_path": "a.md", "content": "x"},
                }
            ],
        },
    ]
    if with_tool_message:
        messages.append({"role": "tool", "content": result, "tool_call_id": "w1"})
    results = [
        {"tool_call_id": "w1", "name": "write_workspace_file", "result": result}
    ]
    if duplicate_results:
        results = results * 2
    return make_body(messages=messages, client_tool_results=results)


class TestDuplicateToolResults:
    """重复投递同一工具结果：不重复执行、不重复写盘、不重发 ``tool_pending``。

    **两处已实测的边界**（``experiments/probe_stage8_dup_results.py``）：

    1. 「客户端重发一批**历史里已有**结果」→ 候选路径按 ``messages`` 里已有的
       ``tool_call_id`` 过滤，幂等（只留一条）；旧路径 ``append_client_tool_results_to_messages``
       **不**做这层过滤，同一请求会让模型看到第 2 份 ``(AIMessage, ToolMessage)``
       —— 这是候选侧**优于**旧路径的地方。
    2. 「同一个请求里把同一结果塞两遍、而历史里还没有它」→ 两侧都不按 id 去重，
       都会补出两条同 id 的 ``ToolMessage``（候选 === 旧路径）。副作用仍然为零
       （``completed_tool_ids`` 是 ``frozenset``，工具不会被执行第二次），
       但消息列表里出现重复 id —— 记为**建议改进项**，不是回归。
    """

    async def test_duplicate_results_with_existing_tool_message_are_a_noop(
        self, monkeypatch
    ):
        run = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("已收到写入结果。")]],
            specs={"write_workspace_file": WRITE_OK},
            request=_resume_request(with_tool_message=True),
        )

        assert run.types == ["preparing", "text_delta", "done"]
        assert run.has_error is False
        tool_messages = run.tool_messages(0)
        assert [message.tool_call_id for message in tool_messages] == ["w1"]
        assert run.executions["write_workspace_file"] == []
        assert not any(frame["type"] == "tool_pending" for frame in run.frames)

    async def test_candidate_dedupes_where_the_old_path_does_not(self, monkeypatch):
        """同一请求下（历史已有结果）：候选 1 条 ``ToolMessage``、旧路径 3 条。

        旧路径把两条重复投递**各自**当成一条新结果追加（``messages`` 里原有的那条
        之外再多两条），候选路径按已有的 ``tool_call_id`` 过滤后一条都不加。
        """
        spec = {"write_workspace_file": WRITE_OK}
        request = _resume_request(with_tool_message=True)
        new = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("已收到写入结果。")]],
            specs=spec,
            request=request,
        )
        old = await run_old(
            monkeypatch,
            rounds=[[Chunk(content="已收到写入结果。")]],
            specs=spec,
            request=request,
        )

        assert [m.tool_call_id for m in new.tool_messages(0)] == ["w1"]
        assert [m.tool_call_id for m in old.tool_messages(0)] == ["w1", "w1", "w1"]
        # 两侧副作用都为零（工具不会被重复执行）
        assert new.executions["write_workspace_file"] == []
        assert old.executions["write_workspace_file"] == []

    async def test_within_request_duplicate_delivery_still_has_zero_side_effects(
        self, monkeypatch
    ):
        """历史里还没有结果时的同请求重复投递：会补两条同 id 消息（两侧一致），
        但**零执行、零 pending**——「不重复执行 / 不重复写盘」仍然成立。"""
        spec = {"write_workspace_file": WRITE_OK}
        request = _resume_request(with_tool_message=False)
        new = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("已收到写入结果。")]],
            specs=spec,
            request=request,
        )
        old = await run_old(
            monkeypatch,
            rounds=[[Chunk(content="已收到写入结果。")]],
            specs=spec,
            request=request,
        )

        assert [m.tool_call_id for m in new.tool_messages(0)] == ["w1", "w1"]
        assert [m.tool_call_id for m in old.tool_messages(0)] == ["w1", "w1"]
        assert new.executions["write_workspace_file"] == []
        assert old.executions["write_workspace_file"] == []
        assert not any(frame["type"] == "tool_pending" for frame in new.frames)
        assert new.has_error is False
        assert new.types == ["preparing", "text_delta", "done"]

    async def test_repeating_the_same_resume_request_is_idempotent(self, monkeypatch):
        request = _resume_request(with_tool_message=True)
        first = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("已收到写入结果。")]],
            specs={"write_workspace_file": WRITE_OK},
            request=request,
        )
        second = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("已收到写入结果。")]],
            specs={"write_workspace_file": WRITE_OK},
            request=request,
        )

        assert first.frames == second.frames
        assert [
            message.tool_call_id for message in first.tool_messages(0)
        ] == [message.tool_call_id for message in second.tool_messages(0)] == ["w1"]
        assert first.executions["write_workspace_file"] == []
        assert second.executions["write_workspace_file"] == []

    async def test_replayed_completed_call_is_suppressed_with_zero_executions(
        self, monkeypatch
    ):
        """已回传的 ``tool_call_id`` 被播种进 ``completed_tool_ids``：复读即抑制、零执行。"""
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [
                        (
                            "w1",
                            "write_workspace_file",
                            {"relative_path": "a.md", "content": "x"},
                        )
                    ]
                )
            ],
            specs={"write_workspace_file": WRITE_OK},
            request=_resume_request(with_tool_message=True),
        )

        assert run.types == [
            "preparing",
            "file_proposal_start",
            "file_proposal_delta",
            "tool_start",
            "tool_result",
            "done",
        ]
        assert run.executions["write_workspace_file"] == []
        assert json.loads(run.results("w1")[0]) == {
            "ok": False,
            "tool": "write_workspace_file",
            "status": "already_completed",
            "summary": "该工具本轮已执行，请勿重复调用。请总结，勿重跑标注工具。",
            "file_written": False,
            "proposal_pending": False,
        }
        # 绝不重发 pending（客户端不会被要求再执行一次）
        assert not any(frame["type"] == "tool_pending" for frame in run.frames)
        assert run.has_error is False

    async def test_old_and_new_agree_on_duplicate_resume_frames(self, monkeypatch):
        spec = {"write_workspace_file": WRITE_OK}
        request = _resume_request(with_tool_message=True)
        new = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("已收到写入结果。")]],
            specs=spec,
            request=request,
        )
        old = await run_old(
            monkeypatch,
            rounds=[[Chunk(content="已收到写入结果。")]],
            specs=spec,
            request=request,
        )

        assert old.frames == new.frames
        assert old.total_executions() == new.total_executions() == 0


# ── 5. 取消竞态 ────────────────────────────────────────────────────────


TOOL_THEN_TEXT_SPEC = {"read_workspace_file": READ_OK}


def _tool_then_text_rounds() -> list[list[Any]]:
    return [
        call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
        [text_chunk("第二轮回答。")],
    ]


def _old_tool_then_text_rounds() -> list[list[Any]]:
    return [
        old_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
        [Chunk(content="第二轮回答。")],
    ]


class TestCancelRace:
    """取消竞态：在途帧被丢弃、``done`` 仍由 HTTP 层发出、未执行的不执行。"""

    async def test_cancel_before_first_frame_emits_only_done_and_runs_nothing(
        self, monkeypatch
    ):
        run = await run_candidate(
            monkeypatch,
            rounds=_tool_then_text_rounds(),
            specs=TOOL_THEN_TEXT_SPEC,
            request=make_body(),
            cancel_at=1,
        )

        assert run.frames == [{"type": "done"}]
        assert run.has_error is False
        # 取消检查在「取帧之后、yield 之前」：连 preparing 也被丢弃，
        # 且图从未被驱动 → 模型零调用、工具零执行。
        assert run.model_calls == 0
        assert run.total_executions() == 0

    async def test_cancel_during_first_round_drops_the_in_flight_text_frame(
        self, monkeypatch
    ):
        run = await run_candidate(
            monkeypatch,
            rounds=[[text_chunk("第一段"), text_chunk("第二段")]],
            specs=TOOL_THEN_TEXT_SPEC,
            request=make_body(),
            cancel_at=3,
        )

        # f1 preparing 已发；f2 第一段已发；f3 第二段被丢弃
        assert run.frames == [
            {"type": "preparing", "stage": "streaming"},
            {"type": "text_delta", "content": "第一段"},
            {"type": "done"},
        ]
        assert run.has_done is True
        assert run.has_error is False

    async def test_cancel_between_rounds_keeps_executed_tool_and_drops_next_frame(
        self, monkeypatch
    ):
        run = await run_candidate(
            monkeypatch,
            rounds=_tool_then_text_rounds(),
            specs=TOOL_THEN_TEXT_SPEC,
            request=make_body(),
            cancel_at=4,
        )

        # f1 preparing, f2 tool_start, f3 tool_result 已发；f4 第二轮文本被丢弃
        assert run.frames == [
            {"type": "preparing", "stage": "streaming"},
            {
                "type": "tool_start",
                "toolCallId": "r1",
                "name": "read_workspace_file",
                "arguments": '{\n  "relative_path": "a.md"\n}',
            },
            {"type": "tool_result", "toolCallId": "r1", "result": "已读取 a.md"},
            {"type": "done"},
        ]
        assert run.has_done is True
        assert run.has_error is False
        # 已执行事实不可撤销，但**恰好一次**（取消不会造成重复执行）
        assert run.executions["read_workspace_file"] == [{"relative_path": "a.md"}]

    async def test_cancel_at_the_tool_pending_boundary_drops_the_pending_frame(
        self, monkeypatch
    ):
        run = await run_candidate(
            monkeypatch,
            rounds=[call_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})])],
            specs={"auto_annotate": ANNOTATE_PENDING},
            request=make_body(),
            cancel_at=3,
        )

        assert run.frames == [
            {"type": "preparing", "stage": "streaming"},
            {
                "type": "tool_start",
                "toolCallId": "a1",
                "name": "auto_annotate",
                "arguments": '{\n  "paths": [\n    "data/1.jpg"\n  ]\n}',
            },
            {"type": "done"},
        ]
        # 挂起帧被丢弃，但 done 仍发出（前端靠它关闭 job）
        assert run.has_done is True
        assert run.has_error is False
        assert not any(frame["type"] == "tool_pending" for frame in run.frames)
        # 挂起工具由客户端执行 → 后端零执行
        assert run.executions["auto_annotate"] == []

    async def test_cancel_after_the_pending_frame_was_delivered_still_emits_done(
        self, monkeypatch
    ):
        run = await run_candidate(
            monkeypatch,
            rounds=[call_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})])],
            specs={"auto_annotate": ANNOTATE_PENDING},
            request=make_body(),
            cancel_at=4,
        )

        assert run.types == [
            "preparing",
            "tool_start",
            "tool_pending",
            "done",
        ]
        assert run.has_done is True
        assert run.has_error is False
        assert run.executions["auto_annotate"] == []

    def test_http_route_still_emits_done_when_the_registry_is_cancelled(
        self, monkeypatch
    ):
        """走真实 FastAPI 路由 + 取消注册表：``done`` 仍由 HTTP 层发出。"""
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        tools, executions = make_tools(TOOL_THEN_TEXT_SPEC)
        model = ScriptedChat(rounds=[[text_chunk("不应出现")]])
        monkeypatch.setattr(entry, "ChatOpenAI", lambda **kwargs: model)
        monkeypatch.setattr(
            entry, "build_local_tools", lambda body, settings: list(tools)
        )

        app = FastAPI()
        app.include_router(agent_module.router, prefix="/api/v1")
        app.dependency_overrides[get_settings] = lambda: Settings(
            agent_engine="candidate"
        )
        job_id = "job-stage8-http-cancel"
        body = make_body(client_job_id=job_id)

        with TestClient(app) as client:
            agent_module._cancel_events[job_id] = _set_event()
            assert client.post(
                CANCEL_ROUTE, json={"client_job_id": job_id}
            ).json() == {"ok": True}
            with client.stream("POST", ROUTE, json=body.model_dump()) as streamed:
                body_text = "".join(streamed.iter_text())

        assert parse_frames([body_text]) == [{"type": "done"}]
        assert model.invoke_calls == 0
        assert executions["read_workspace_file"] == []

    async def test_old_path_cancel_before_first_frame_emits_only_done(self, monkeypatch):
        """旧/新同构：取消（首个检查点）时都只剩 ``done``、工具零执行。"""
        old = await run_old(
            monkeypatch,
            rounds=_old_tool_then_text_rounds(),
            specs=TOOL_THEN_TEXT_SPEC,
            request=make_body(),
            cancel_preset=True,
        )
        new = await run_candidate(
            monkeypatch,
            rounds=_tool_then_text_rounds(),
            specs=TOOL_THEN_TEXT_SPEC,
            request=make_body(),
            cancel_at=1,
        )

        assert old.frames == new.frames == [{"type": "done"}]
        assert old.total_executions() == new.total_executions() == 0


# ── 6. 非法工具参数 ────────────────────────────────────────────────────


class TestInvalidToolArguments:
    """非法参数：本轮存活、无 ``error`` 帧、参数**原样**到达工具体（与旧路径同构）。"""

    async def test_type_invalid_argument_reaches_the_tool_body_once(self, monkeypatch):
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round([("i1", "read_workspace_file", {"relative_path": 123})]),
                [text_chunk("参数有误。")],
            ],
            specs={"read_workspace_file": READ_WITH_SCHEMA},
            request=make_body(),
        )

        assert run.types == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        assert run.has_error is False
        # 工具体恰好一次，且收到的是**未校验**的原始值
        assert run.executions["read_workspace_file"] == [{"relative_path": 123}]
        assert run.results("i1") == ["已读取 a.md"]

    async def test_missing_required_argument_reaches_the_tool_body_as_empty(
        self, monkeypatch
    ):
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round([("i2", "read_workspace_file", {})]),
                [text_chunk("缺少参数。")],
            ],
            specs={"read_workspace_file": READ_WITH_SCHEMA},
            request=make_body(),
        )

        assert run.types == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        assert run.executions["read_workspace_file"] == [{}]
        assert run.has_error is False

    async def test_truncated_json_arguments_become_empty_args_and_turn_survives(
        self, monkeypatch
    ):
        run = await run_candidate(
            monkeypatch,
            rounds=[
                raw_call_round("b1", "read_workspace_file", '{"relative_path": '),
                [text_chunk("参数解析失败。")],
            ],
            specs={"read_workspace_file": READ_WITH_SCHEMA},
            request=make_body(),
        )

        assert run.types == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        assert run.has_error is False
        assert run.executions["read_workspace_file"] == [{}]
        assert run.frames[1] == {
            "type": "tool_start",
            "toolCallId": "b1",
            "name": "read_workspace_file",
            "arguments": "{}",
        }

    async def test_unparseable_arguments_do_not_execute_anything(self, monkeypatch):
        """完全不是 JSON：调用名被丢弃，本轮零工具执行（旧路径同构）。"""
        run = await run_candidate(
            monkeypatch,
            rounds=[
                raw_call_round("b2", "read_workspace_file", "not json at all"),
                [text_chunk("没有可执行调用。")],
            ],
            specs={"read_workspace_file": READ_WITH_SCHEMA},
            request=make_body(),
        )

        assert run.types == ["preparing", "done"]
        assert run.has_error is False
        assert run.total_executions() == 0

    async def test_old_path_behaves_identically_on_invalid_arguments(self, monkeypatch):
        """两侧都不做 schema 校验：同一个非法值同样到达工具体、同样恰好一次。"""
        spec = {"read_workspace_file": READ_WITH_SCHEMA}
        new = await run_candidate(
            monkeypatch,
            rounds=[
                call_round([("i1", "read_workspace_file", {"relative_path": 123})]),
                [text_chunk("参数有误。")],
            ],
            specs=spec,
            request=make_body(),
        )
        old = await run_old(
            monkeypatch,
            rounds=[
                old_round([("i1", "read_workspace_file", {"relative_path": 123})]),
                [Chunk(content="参数有误。")],
            ],
            specs=spec,
            request=make_body(),
        )

        assert old.frames == new.frames
        assert old.executions["read_workspace_file"] == [{"relative_path": 123}]
        assert new.executions["read_workspace_file"] == [{"relative_path": 123}]


# ── 7. 阶段违规（AWAIT_CONFIRM / VERIFY）───────────────────────────────


class TestPhaseViolations:
    """阶段门禁：零写盘执行 + **逐字**等于旧路径的拒绝理由文本。"""

    async def test_await_confirm_blocks_workspace_write_with_zero_executions(
        self, monkeypatch
    ):
        spec = {"delete_workspace_file": WRITE_OK}
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [("d1", "delete_workspace_file", {"relative_path": "a.md"})]
                ),
                [text_chunk("提案未确认，先不写盘。")],
            ],
            specs=spec,
            request=make_body(client_context=AWAIT_CONFIRM_CTX),
        )

        assert run.types == [
            "preparing",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        # 零写盘执行（该工具是 SYNC/PROPOSAL，未被门禁挡住就会被真实执行）
        assert run.executions["delete_workspace_file"] == []
        assert run.results("d1") == [
            _phase_blocked_payload("delete_workspace_file", PENDING_REASON)
        ]
        assert run.has_error is False
        assert run.has_done is True

    async def test_await_confirm_reason_text_is_identical_to_the_old_path(
        self, monkeypatch
    ):
        spec = {"delete_workspace_file": WRITE_OK}
        request = make_body(client_context=AWAIT_CONFIRM_CTX)
        new = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [("d1", "delete_workspace_file", {"relative_path": "a.md"})]
                ),
                [text_chunk("提案未确认，先不写盘。")],
            ],
            specs=spec,
            request=request,
        )
        old = await run_old(
            monkeypatch,
            rounds=[
                old_round(
                    [("d1", "delete_workspace_file", {"relative_path": "a.md"})]
                ),
                [Chunk(content="提案未确认，先不写盘。")],
            ],
            specs=spec,
            request=request,
        )

        assert old.results("d1") == new.results("d1")
        assert json.loads(new.results("d1")[0])["summary"] == PENDING_REASON
        assert old.executions["delete_workspace_file"] == []
        assert new.executions["delete_workspace_file"] == []

    async def test_await_confirm_allows_no_write_even_with_a_streamed_card(
        self, monkeypatch
    ):
        """带 ``content`` 的写盘在未确认阶段同样零执行；流式卡片**不**补 dismissed。"""
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [
                        (
                            "w1",
                            "write_workspace_file",
                            {"relative_path": "a.md", "content": "x"},
                        )
                    ]
                ),
                [text_chunk("提案未确认，先不写盘。")],
            ],
            specs={"write_workspace_file": WRITE_OK},
            request=make_body(client_context=AWAIT_CONFIRM_CTX),
        )

        assert run.types == [
            "preparing",
            "file_proposal_start",
            "file_proposal_delta",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        assert run.executions["write_workspace_file"] == []
        assert run.results("w1") == [
            _phase_blocked_payload("write_workspace_file", PENDING_REASON)
        ]
        assert not any(
            frame["type"] == "file_proposal" for frame in run.frames
        ), "被门禁拦下的写盘不应产出任何 file_proposal 定稿帧"

    async def test_verify_blocks_reannotation_of_an_applied_path(self, monkeypatch):
        spec = {"auto_annotate": ANNOTATE_PENDING}
        request = make_body(client_context=VERIFY_CTX)
        new = await run_candidate(
            monkeypatch,
            rounds=[
                call_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})])
            ],
            specs=spec,
            request=request,
        )
        old = await run_old(
            monkeypatch,
            rounds=[old_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})])],
            specs=spec,
            request=request,
        )

        assert new.types == ["preparing", "tool_start", "tool_result", "done"]
        assert new.has_done is True
        assert new.has_error is False
        # 零写盘执行、零挂起（不会让客户端再标一次）
        assert new.executions["auto_annotate"] == []
        assert not any(frame["type"] == "tool_pending" for frame in new.frames)
        assert new.results("a1") == [
            _phase_blocked_payload("auto_annotate", VERIFY_PATH_REASON)
        ]
        # 逐字等于旧路径
        assert old.results("a1") == new.results("a1")
        assert old.executions["auto_annotate"] == []

    async def test_verify_blocks_all_files_reannotation(self, monkeypatch):
        spec = {"auto_annotate": ANNOTATE_PENDING}
        request = make_body(client_context=VERIFY_CTX)
        new = await run_candidate(
            monkeypatch,
            rounds=[call_round([("a1", "auto_annotate", {"all_files": True})])],
            specs=spec,
            request=request,
        )
        old = await run_old(
            monkeypatch,
            rounds=[old_round([("a1", "auto_annotate", {"all_files": True})])],
            specs=spec,
            request=request,
        )

        assert new.types == ["preparing", "tool_start", "tool_result", "done"]
        assert new.results("a1") == [
            _phase_blocked_payload("auto_annotate", VERIFY_ALL_FILES_REASON)
        ]
        assert old.results("a1") == new.results("a1")
        assert new.executions["auto_annotate"] == []
        assert new.has_error is False

    async def test_verify_allows_writes_that_are_not_annotation_reannotation(
        self, monkeypatch
    ):
        """反向对照：VERIFY 只拦「标注重复重标」，报告/清理写盘仍允许（同旧路径语义）。

        写类工具成功但没解析出 ``__doc_proposal__`` 时，``tool_result`` 保持**原始 JSON**
        （``tool_loop.py:275-280`` 的 elif 分支没有 else —— 阶段 0 §8-6 的刻意不对称）。
        """
        spec = {"delete_workspace_file": WRITE_OK}
        request = make_body(client_context=VERIFY_CTX)
        new = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [("d1", "delete_workspace_file", {"relative_path": "a.md"})]
                ),
                [text_chunk("已清理。")],
            ],
            specs=spec,
            request=request,
        )
        old = await run_old(
            monkeypatch,
            rounds=[
                old_round(
                    [("d1", "delete_workspace_file", {"relative_path": "a.md"})]
                ),
                [Chunk(content="已清理。")],
            ],
            specs=spec,
            request=request,
        )

        expected = json.dumps(WRITE_OK["result"], ensure_ascii=False)
        assert new.execution_count("delete_workspace_file") == 1
        assert new.results("d1") == [expected]
        assert old.results("d1") == [expected]
        assert new.has_error is False

    async def test_await_confirm_never_executes_any_write_tool_in_a_mixed_round(
        self, monkeypatch
    ):
        """混合轮：只读放行、写盘拦截，写类工具**零执行**。"""
        run = await run_candidate(
            monkeypatch,
            rounds=[
                call_round(
                    [
                        ("r1", "read_workspace_file", {"relative_path": "a.md"}),
                        ("d1", "delete_workspace_file", {"relative_path": "a.md"}),
                    ]
                ),
                [text_chunk("只读完成，写入被拦。")],
            ],
            specs={
                "read_workspace_file": READ_OK,
                "delete_workspace_file": WRITE_OK,
            },
            request=make_body(client_context=AWAIT_CONFIRM_CTX),
        )

        assert run.types == [
            "preparing",
            "tool_start",
            "tool_result",
            "tool_start",
            "tool_result",
            "text_delta",
            "done",
        ]
        assert [
            frame["toolCallId"]
            for frame in run.frames
            if frame["type"] == "tool_start"
        ] == ["d1", "r1"]
        assert run.executions["delete_workspace_file"] == []
        assert run.execution_count("read_workspace_file") == 1
        assert run.results("d1") == [
            _phase_blocked_payload("delete_workspace_file", PENDING_REASON)
        ]
        assert run.results("r1") == ["已读取 a.md"]
        assert run.has_error is False
        assert run.has_done is True
