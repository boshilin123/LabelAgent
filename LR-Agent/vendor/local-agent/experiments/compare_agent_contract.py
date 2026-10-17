"""阶段 4b：旧路径 vs 候选适配器的**逐帧**对照 harness（替代阶段 4a 前的窄覆盖版本）。

## 为什么必须重写（备忘 §6，阶段 0 §8-11 实测复核）

被替换的旧脚本有三条实证缺陷，使它**不构成证据**：

1. 其脚本化模型 ``MultiCallModel``（``experiments/langchain_multitool_spike.py:27-42``）
   **只实现 ``_generate``、没有流式** → 从未触达 ``messages`` 流，只比较
   ``updates`` 派生的工具帧；
2. 断言对象是 ``ToolLoopRunner.execute_round`` 而不是 ``stream_assist``；
3. 完全不经 HTTP/SSE 层。

## 本 harness 做了什么

- **import 生产适配器**：``app.agent.langchain_runtime.sse_adapter.stream_agent_events``
  （不再有 ``_adapt_first_turn``）；
- **流式脚本化模型**：文本 + ``additional_kwargs["reasoning_content"]`` +
  ``tool_call_chunks`` 跨 chunk 拆分（``ScriptedStreamChat``，``BaseChatModel``）；
- **两侧都过 ``stream_assist`` 级入口**，并各自再过一次 HTTP/SSE 层
  （``app.api.v1.agent._stream_local_chat``）：旧侧 patch
  ``app.agent.assist_service.stream_assist``，新侧 patch
  ``app.agent.langchain_runtime.sse_adapter.stream_agent_events``——
  两侧都是**生产实现**被包装，不是替身；
- **参数化在阶段 0 的样例类上**（复用 ``tests/test_agent_baseline_contract.py``
  的 ``Chunk`` / ``make_tools`` 形态与场景参数）；
- 每个场景打印 OLD/NEW 两侧**完整帧列表**，并在第一个不同帧处显式失败。

## 运行

    .venvs\\langchain-migration\\Scripts\\python.exe -m experiments.compare_agent_contract

离线确定性：无网络、无真实模型、无磁盘写入（工具一律结构化存根，
``load_mcp_tools_from_servers`` 被 patch 掉以免探测网络）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import pathlib
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import (  # noqa: E402
    AIMessage,
    AIMessageChunk,
    HumanMessage,
)
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
)
from langchain_core.tools import StructuredTool  # noqa: E402
from pydantic import Field  # noqa: E402

from app.agent.assist.task_phase import derive_task_phase  # noqa: E402
from app.agent import assist_service  # noqa: E402
from app.agent.langchain_runtime.middleware import (  # noqa: E402
    build_business_middleware,
)
from app.agent.langchain_runtime.resume import prepare_resume_messages  # noqa: E402
from app.agent.langchain_runtime.runtime import (  # noqa: E402
    AgentContext,
    build_langchain_agent,
)
from app.agent.langchain_runtime.sse_adapter import (  # noqa: E402
    SseStreamConfig,
    stream_agent_events,
)
from app.schemas.agent import (  # noqa: E402
    ClientContextInput,
    ClientToolResult,
    LocalChatStreamRequest,
    ProposalStateInput,
    StreamEventPayload,
)

# 复用阶段 0 的**同一个** chunk 形状（``tests/test_agent_baseline_contract.py:52-78``）。
from tests.test_agent_baseline_contract import Chunk, make_tools  # noqa: E402

# 生产实现的**原始引用**：包装器必须在 patch 之前抓住它，否则会自我递归。
_ORIGINAL_STREAM_ASSIST = assist_service.stream_assist  # noqa: E402
_ORIGINAL_STREAM_AGENT_EVENTS = stream_agent_events  # noqa: E402


async def _never_cancel() -> bool:
    return False


# ── 流式脚本化模型（候选侧；旧侧用 duck-typed ``ScriptedChat``）─────────


class ScriptedStreamChat(BaseChatModel):
    """按轮次返回预设 ``AIMessageChunk`` 的假聊天模型（``BaseChatModel``）。

    ``_astream`` 是本 harness 的**唯一**驱动方式：它保证 ``messages`` 流被真正
    触达（文本、reasoning、``tool_call_chunks``）。``_generate`` 只是为满足
    ``BaseChatModel`` 抽象面（``BudgetWrapUpMiddleware`` 的兜底轮在旧路径里走
    ``llm.astream``，候选路径走同一模型的 ``_astream``）。
    """

    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)
    seen_messages: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "lr-agent-scripted-stream-stage4b"

    @property
    def invoke_calls(self) -> int:
        return int(self.counters.get("invoke_calls", 0))

    @property
    def bound_tool_names(self) -> list[str]:
        return list(self.counters.get("bound_tool_names", []))

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [getattr(t, "name", str(t)) for t in tools]
        return self

    def _round(self) -> list[AIMessageChunk]:
        index = int(self.counters.get("invoke_calls", 0))
        self.counters["invoke_calls"] = index + 1
        if index < len(self.rounds):
            return self.rounds[index]
        return [AIMessageChunk(content="")]

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        merged: AIMessageChunk | None = None
        for chunk in self._round():
            merged = chunk if merged is None else merged + chunk
        message = AIMessage(
            content="" if merged is None else merged.content,
            tool_calls=[] if merged is None else list(merged.tool_calls or []),
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen_messages.append(list(messages))
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


class ScriptedChat:
    """旧路径的 duck-typed 假聊天模型（与阶段 0 基线同款）。"""

    def __init__(self, rounds: list[list[Chunk]]) -> None:
        self._rounds = list(rounds)
        self.astream_calls = 0
        self.bind_tools_calls = 0
        self.bound_tool_names: list[str] = []
        self.seen_messages: list[list[Any]] = []

    def bind_tools(self, tools, tool_choice=None):
        self.bind_tools_calls += 1
        self.bound_tool_names = [getattr(t, "name", str(t)) for t in tools]
        return self

    async def astream(self, messages):
        self.astream_calls += 1
        self.seen_messages.append(list(messages))
        for chunk in (self._rounds.pop(0) if self._rounds else []):
            yield chunk

    async def ainvoke(self, messages):
        return AIMessage(content="", tool_calls=[])


def to_ai_chunks(chunk: Chunk) -> list[AIMessageChunk]:
    """阶段 0 的 ``Chunk`` → **真实** ``AIMessageChunk``（框架要 pydantic 实例）。

    ``tool_calls`` 被转成 ``tool_call_chunks``：真实 provider 的流式正是这样来的
    （``langchain_core/messages/ai.py`` 的 ``tool_call_chunks`` 会反推
    ``tool_calls``），因此候选侧的轮末素材必须从 chunk 派生的调用表取得。
    """
    if chunk.tool_call_chunks:
        converted: list[AIMessageChunk] = []
        for tc in chunk.tool_call_chunks:
            converted.append(
                AIMessageChunk(
                    content=chunk.content or "",
                    additional_kwargs=dict(chunk.additional_kwargs or {}),
                    tool_call_chunks=[dict(tc)],
                )
            )
            chunk = Chunk(content="")
        return converted
    if not chunk.tool_calls:
        return [
            AIMessageChunk(
                content=chunk.content or "",
                additional_kwargs=dict(chunk.additional_kwargs or {}),
            )
        ]
    return [
        AIMessageChunk(
            content=chunk.content or "",
            additional_kwargs=dict(chunk.additional_kwargs or {}),
            tool_call_chunks=[
                {
                    "name": call["name"],
                    "args": json.dumps(call["args"], ensure_ascii=False),
                    "id": call["id"],
                    "index": index,
                    "type": "tool_call_chunk",
                }
                for index, call in enumerate(chunk.tool_calls)
            ],
        )
    ]


def split_args_call(
    call_id: str,
    name: str,
    args: dict[str, Any],
    *,
    index: int = 0,
) -> list[Chunk]:
    """把一个调用拆成**两块** ``tool_call_chunks``（首块带 name+id，续块 id=None）。

    这是备忘 §6 要求的「跨 chunk 拆分的 tool args」；写类工具的提案流式
    （``ProposalStreamInterceptor``）正依赖这种分片。首块**同时**带完整
    ``tool_calls``，因为旧路径（``ScriptedChat``）只认 ``tool_calls``
    ——两侧因此看到同一个调用，只是候选侧要自己把分片拼回参数。
    """
    raw = json.dumps(args, ensure_ascii=False)
    head, tail = raw[: len(raw) // 2], raw[len(raw) // 2 :]
    return [
        Chunk(
            tool_calls=[{"id": call_id, "name": name, "args": args}],
            tool_call_chunks=[
                {
                    "index": index,
                    "id": call_id,
                    "name": name,
                    "args": head,
                    "type": "tool_call_chunk",
                }
            ],
        ),
        Chunk(
            tool_call_chunks=[
                {
                    "index": index,
                    "id": None,
                    "name": None,
                    "args": tail,
                    "type": "tool_call_chunk",
                }
            ]
        ),
    ]


def call_round(calls: list[tuple[str, str, dict[str, Any]]]) -> list[Chunk]:
    """一轮里多个调用，每个都跨两块分片（首块带 ``tool_calls`` 供旧路径）。"""
    out: list[Chunk] = []
    for index, (call_id, name, args) in enumerate(calls):
        out.extend(split_args_call(call_id, name, args, index=index))
    return out



# ── 场景定义 ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Scenario:
    """一个对照场景（阶段 0 十类样例的候选侧参数化）。"""

    name: str
    baseline_class: str
    tools_spec: dict[str, dict[str, Any]]
    rounds: list[list[Chunk]]
    client_context: ClientContextInput
    task_phase_states: list[ProposalStateInput] = field(default_factory=list)
    max_tool_rounds: int = 5
    client_tool_results: list[ClientToolResult] = field(default_factory=list)
    resumed_messages: bool = False
    """True：把「上一轮已挂起调用的合成对话」作为输入消息（跨请求 resume 第二轮）。"""
    has_tools: bool = True
    """False：**无工具纯聊天分支**（阶段 7 §7-2 遗留项，F3 收尾）。

    ``has_tools=False`` 时两条路径都不做候选内核装配：
    旧 ``_stream_local_chat`` 与候选 ``entry.stream_candidate_engine_sse`` 都必须
    直接走 ``chat_service.stream_chat``（无图、无工具、无阶段）。此时
    ``tools_spec`` / ``max_tool_rounds`` / ``resumed_messages`` 均不参与，
    「适配器直连」也不再适用（没有适配器参与）。"""


READ_SPEC = {
    "result": {"ok": True, "summary": "已读取 a.md"},
    "properties": {"relative_path": {"type": "string"}},
}
WRITE_SPEC = {
    "result": {
        "ok": True,
        "tool": "write_workspace_file",
        "status": "proposal_pending",
        "summary": "已生成报告提案",
    },
    "properties": {"relative_path": {"type": "string"}, "content": {"type": "string"}},
}
ANNOTATE_SPEC = {
    "result": {"ok": True, "summary": "不应在后端执行"},
    "properties": {"paths": {"type": "array"}, "all_files": {"type": "boolean"}},
}

WORKSPACE_CTX = ClientContextInput(workspace_root="/w")

NO_TOOLS_CTX = ClientContextInput()
"""``has_tools=False`` 的客户端快照（无工作区、无项目、无快照）。

与旧 ``agent.py:220-233`` / 候选 ``entry._has_tools`` 的判据一致 ⇒ 两条路径
都必须走无工具纯聊天分支。"""


def scenario_list() -> list[Scenario]:
    """阶段 0 十类样例的对照场景（每类至少 1 条；关键类 2 条）。"""
    return [
        Scenario(
            name="empty_tool_call",
            baseline_class="TestEmptyToolCall",
            tools_spec={"read_workspace_file": READ_SPEC},
            rounds=[
                [
                    Chunk(content="你好，"),
                    Chunk(content="我可以帮你整理工作区。"),
                ]
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="single_tool",
            baseline_class="TestSingleTool",
            tools_spec={"read_workspace_file": READ_SPEC},
            rounds=[
                # 参数跨两块 tool_call_chunks（备忘 §6 要求）
                split_args_call("t1", "read_workspace_file", {"relative_path": "a.md"}),
                [Chunk(content="已读取 a.md。")],
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="multiple_tools_parallel",
            baseline_class="TestMultipleTools",
            tools_spec={
                "grep_workspace": {
                    "result": {"ok": True, "summary": "grep 命中 2 处"},
                    "properties": {"pattern": {"type": "string"}},
                },
                "glob_workspace": {
                    "result": {"ok": True, "summary": "glob 命中 3 个文件"},
                    "properties": {"pattern": {"type": "string"}},
                },
            },
            rounds=[
                call_round(
                    [
                        ("g1", "grep_workspace", {"pattern": "TODO"}),
                        ("g2", "glob_workspace", {"pattern": "*.py"}),
                    ]
                ),
                [Chunk(content="共 2 处命中、3 个文件。")],
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="mixed_sync_async",
            baseline_class="TestMultipleTools",
            tools_spec={
                "read_workspace_file": READ_SPEC,
                "auto_annotate": ANNOTATE_SPEC,
            },
            rounds=[
                call_round(
                    [
                        ("r1", "read_workspace_file", {"relative_path": "a.md"}),
                        (
                            "a1",
                            "auto_annotate",
                            {"paths": ["data/1.jpg"], "all_files": False},
                        ),
                    ]
                )
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="coalesced_annotation",
            baseline_class="TestMultipleTools",
            tools_spec={"auto_annotate": ANNOTATE_SPEC},
            rounds=[
                call_round(
                    [
                        ("c1", "auto_annotate", {"paths": ["1.jpg"], "all_files": False}),
                        ("c2", "auto_annotate", {"paths": ["2.jpg"], "all_files": True}),
                    ]
                )
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="duplicate_call",
            baseline_class="TestMultipleTools",
            tools_spec={"auto_annotate": ANNOTATE_SPEC},
            rounds=[
                call_round(
                    [
                        ("d1", "auto_annotate", {"paths": ["1.jpg"]}),
                        ("d2", "auto_annotate", {"paths": ["1.jpg"]}),
                    ]
                )
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="annotation_before_report",
            baseline_class="TestMultipleTools",
            tools_spec={"auto_annotate": ANNOTATE_SPEC, "write_workspace_file": WRITE_SPEC},
            rounds=[
                call_round(
                    [
                        (
                            "b2",
                            "write_workspace_file",
                            {"relative_path": "report.md", "content": "report"},
                        ),
                        ("b1", "auto_annotate", {"paths": ["1.jpg"]}),
                    ]
                )
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="phase_blocked_write_then_read",
            baseline_class="TestMultipleTools",
            tools_spec={"write_workspace_file": WRITE_SPEC, "read_workspace_file": READ_SPEC},
            task_phase_states=[ProposalStateInput(path="data/1.jpg", kind="annotation", status="pending")],
            rounds=[
                call_round(
                    [
                        (
                            "w1",
                            "write_workspace_file",
                            {"relative_path": "r.md", "content": "x"},
                        ),
                        ("r1", "read_workspace_file", {"relative_path": "a.md"}),
                    ]
                ),
                [Chunk(content="提案待确认。")],
            ],
            client_context=ClientContextInput(
                workspace_root="/w",
                proposal_states=[ProposalStateInput(path="data/1.jpg", kind="annotation", status="pending")],
            ),
        ),
        Scenario(
            name="dismiss_allows_replanning",
            baseline_class="TestDismissAndReject",
            tools_spec={"auto_annotate": ANNOTATE_SPEC},
            task_phase_states=[ProposalStateInput(path="data/2.jpg", kind="annotation", status="dismissed")],
            rounds=[
                call_round([("d1", "auto_annotate", {"paths": ["data/2.jpg"]})])
            ],
            client_context=ClientContextInput(
                workspace_root="/w",
                proposal_states=[ProposalStateInput(path="data/2.jpg", kind="annotation", status="dismissed")],
            ),
        ),
        Scenario(
            name="failed_edit_emits_dismissed",
            baseline_class="TestDismissAndReject",
            tools_spec={
                "str_replace_workspace_file": {
                    "result": {
                        "ok": False,
                        "tool": "str_replace_workspace_file",
                        "status": "error",
                        "summary": "未找到 old_string",
                    },
                    "properties": {
                        "relative_path": {"type": "string"},
                        "old_string": {"type": "string"},
                        "new_string": {"type": "string"},
                    },
                }
            },
            rounds=[
                [
                    Chunk(
                        tool_call_chunks=[
                            {
                                "index": 0,
                                "id": "s1",
                                "name": "str_replace_workspace_file",
                                "args": '{"relative_path": "a.py", "old_string": "x", "new_string": "y"}',
                                "type": "tool_call_chunk",
                            }
                        ],
                        tool_calls=[
                            {
                                "id": "s1",
                                "name": "str_replace_workspace_file",
                                "args": {
                                    "relative_path": "a.py",
                                    "old_string": "x",
                                    "new_string": "y",
                                },
                            }
                        ],
                    )
                ],
                [Chunk(content="替换失败，未改动文件。")],
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="tool_error",
            baseline_class="TestToolError",
            tools_spec={"read_workspace_file": {"raises": RuntimeError("磁盘炸了"), "properties": {"relative_path": {"type": "string"}}}},
            rounds=[
                call_round([("e1", "read_workspace_file", {"relative_path": "a.md"})]),
                [Chunk(content="读取失败，已停止。")],
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="unknown_tool",
            baseline_class="TestToolError",
            tools_spec={},
            rounds=[
                # 未注册工具：模型能看到它（此处刻意只给 ScriptedChat 用 `tool_calls`），
                # 候选路径由阶段 7 的「客户端工具 schema 存根」保证同样可见。
                call_round([("u1", "memory_read", {"topic": "x"})]),
                [Chunk(content="该工具当前不可用。")],
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="budget_exhausted",
            baseline_class="TestBudgetExhausted",
            tools_spec={"read_workspace_file": READ_SPEC},
            max_tool_rounds=1,
            rounds=[
                call_round([("call-1", "read_workspace_file", {"relative_path": "a.md"})]),
                call_round([("call-2", "read_workspace_file", {"relative_path": "a.md"})]),
                [Chunk(content="预算已用完。当前进展：已读取 a.md。")],
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="read_only_rounds",
            baseline_class="TestReadOnlyTools",
            tools_spec={
                "grep_workspace": {
                    "result": {"ok": True, "summary": "grep 命中 1 处"},
                    "properties": {"pattern": {"type": "string"}},
                },
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 annotations.json"},
                    "properties": {"relative_path": {"type": "string"}},
                },
                "write_workspace_file": {
                    "result": {"ok": True, "summary": "不应被调用"},
                    "properties": {"relative_path": {"type": "string"}, "content": {"type": "string"}},
                },
            },
            rounds=[
                call_round([("ro1", "grep_workspace", {"pattern": "annotations"})]),
                call_round(
                    [("ro2", "read_workspace_file", {"relative_path": "annotations.json"})]
                ),
                [Chunk(content="只读核对完成，未做任何写入。")],
            ],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            name="resume_second_request",
            baseline_class="TestProposalConfirm",
            tools_spec={"auto_annotate": ANNOTATE_SPEC},
            client_tool_results=[
                ClientToolResult(
                    tool_call_id="c1",
                    name="auto_annotate",
                    result=json.dumps(
                        {"status": "completed", "proposal_pending": True, "file_written": False},
                        ensure_ascii=False,
                    ),
                )
            ],
            resumed_messages=True,
            rounds=[[Chunk(content="已收到标注结果，等待用户确认提案。")]],
            client_context=WORKSPACE_CTX,
        ),
        Scenario(
            # 阶段 7 §7-2 遗留项（F3 收尾）：``has_tools=False`` 的纯聊天分支。
            # 两侧都必须直接走 ``chat_service.stream_chat`` —— 没有候选图、没有适配器。
            name="no_tools_pure_chat",
            baseline_class="(无基线类：has_tools=False 分支，非工具循环)",
            tools_spec={},
            rounds=[
                [
                    Chunk(content="你好，"),
                    Chunk(content="我是本地助手。"),
                    Chunk(content="", additional_kwargs={"reasoning_content": "「思考」字段"}),
                ],
                [Chunk(content="第二轮不应发生。")],
            ],
            client_context=NO_TOOLS_CTX,
            has_tools=False,
        ),
    ]


# ── 两侧驱动 ───────────────────────────────────────────────────────────


def _tool_instances(spec: dict[str, dict[str, Any]]):
    """候选侧工具实例（``StructuredTool``，包含 raises / result 两种存根）。"""
    return make_tools(spec)[0]


def _input_messages(scenario: Scenario) -> list[Any]:
    """两侧**同一份**图输入消息（resume 场景走 ``prepare_resume_messages``）。"""
    messages: list[Any] = [HumanMessage(content="执行任务")]
    if scenario.resumed_messages:
        messages = prepare_resume_messages(
            messages, scenario.client_tool_results, user_content="执行任务"
        )
    return messages


def _synthetic_pending_round() -> list[Chunk]:
    """resume 第一轮：模型发起客户端调用（用于构造跨轮输入消息的合成对话）。"""
    return [
        Chunk(
            tool_calls=[
                {"id": "c1", "name": "auto_annotate", "args": {"paths": ["data/1.jpg"]}}
            ]
        )
    ]


async def old_frames(scenario: Scenario) -> list[dict[str, Any]]:
    """旧路径：``stream_assist``（生产实现）→ ``_stream_local_chat``（HTTP/SSE 层）。"""
    from app.core.config import get_settings

    import app.agent.assist_service as assist_service
    import app.api.v1.agent as app_api

    if not scenario.has_tools:
        # ── has_tools=False（阶段 7 §7-2 / F3）：两侧都不做候选装配 ──────────
        # 旧路径的真实分支是 ``chat_service.stream_chat(llm, lc_messages)``
        # （``agent.py:467-483``）。把模型工厂换成同一个脚本化 ``astream`` 实现，
        # 其余（模型构造参数、系统提示、消息拼装、SSE 编码、``done`` 位置）全部是生产代码。
        recorder = _ScriptedLlmFactory(
            [list(round_) for round_ in scenario.rounds]
        )
        original_chat_openai = app_api.ChatOpenAI
        app_api.ChatOpenAI = recorder
        try:
            body = _no_tools_body(scenario, job_prefix="job-4b")
            frames = await _collect_sse(body, get_settings())
        finally:
            app_api.ChatOpenAI = original_chat_openai
        _NO_TOOLS_OBSERVATIONS["old"] = {
            "ctor_kwargs": list(recorder.ctor_kwargs),
            "astream_calls": [llm.astream_calls for llm in recorder.models],
            "seen_message_kinds": [
                [_message_kind(m) for m in seen] for llm in recorder.models for seen in llm.seen_messages
            ],
        }
        return frames

    tools, _executions = make_tools(scenario.tools_spec)
    model = ScriptedChat([list(round_) for round_ in scenario.rounds])
    messages = _input_messages(scenario)

    async def _production_stream(*_args, **_kwargs):
        async for event in _ORIGINAL_STREAM_ASSIST(
            model,
            list(messages),
            tools,
            settings=None,
            max_tool_rounds=scenario.max_tool_rounds,
            is_cancelled=_never_cancel,
            client_context=scenario.client_context,
            user_content="执行任务",
            client_tool_results=scenario.client_tool_results or None,
            task_phase_ctx=derive_task_phase(scenario.task_phase_states),
        ):
            yield event

    original_assist = assist_service.stream_assist
    original_loader = app_api.load_mcp_tools_from_servers
    original_chat_openai = app_api.ChatOpenAI

    async def _empty_loader(*_args, **_kwargs):
        return []

    assist_service.stream_assist = _production_stream
    app_api.load_mcp_tools_from_servers = _empty_loader
    app_api.ChatOpenAI = _FakeChatOpenAI  # 不构造真实 provider
    try:
        body = LocalChatStreamRequest(
            api_key="k",
            base_url="https://api.example.com/v1",
            model="scripted",
            messages=[{"role": "user", "content": "执行任务"}],
            user_content="执行任务",
            client_job_id=f"job-4b-{scenario.name}",
            client_context=scenario.client_context,
            client_tool_results=scenario.client_tool_results,
        )
        return await _collect_sse(body, get_settings())
    finally:
        assist_service.stream_assist = original_assist
        app_api.load_mcp_tools_from_servers = original_loader
        app_api.ChatOpenAI = original_chat_openai


class _FakeChatOpenAI:
    """占位：``_stream_local_chat`` 会构造它，但流已被整体替换。"""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


# ── 无工具纯聊天分支（``has_tools=False``）的公共件 ────────────────────


_NO_TOOLS_OBSERVATIONS: dict[str, dict[str, Any]] = {}
"""两侧的模型工厂观测（构造参数 / ``astream`` 次数 / 收到的消息形态）。

放在这里是为了把「两侧拿到同一个模型输入」变成**可打印的证据**，
而不是只比较最终帧列表（帧相同但输入不同也可能是巧合）。两个分支各写一份，
``main`` 在场景内比较并打印。
"""


class _ScriptedLlmFactory:
    """``ChatOpenAI`` 的替身**工厂**：记录构造参数，返回一个脚本化 ``astream`` 模型。

    为什么必须是工厂（而不是直接换 ``llm``）：``has_tools=False`` 的两条路径都
    **自己构造**模型（旧 ``agent.py:165-173`` / 新 ``entry.build_llm_pair``），
    没有任何注入点；在候选侧它还必须满足 ``build_llm_pair`` 的
    ``global ChatOpenAI`` 惰性解析（``entry.ChatOpenAI`` 默认 ``None``）。
    """

    def __init__(self, rounds: list[list[Chunk]]) -> None:
        self.rounds = [list(round_) for round_ in rounds]
        self.ctor_kwargs: list[dict[str, Any]] = []
        self.models: list[ScriptedChat] = []

    def __call__(self, **kwargs: Any) -> ScriptedChat:
        self.ctor_kwargs.append(dict(kwargs))
        model = ScriptedChat([list(round_) for round_ in self.rounds])
        self.models.append(model)
        return model


def _message_kind(message: Any) -> str:
    """消息的类型标记（``system`` / ``human`` / …）——只用于两侧**形态**对照。

    刻意不比较正文：候选侧的 ``_build_lc_messages`` 与旧侧
    ``_build_lc_messages_from_local`` 是两份独立实现，本场景要让它们
    **由对照结果**证明等价（帧逐字节相同），而不是靠这里预判。
    """
    return str(getattr(message, "type", type(message).__name__))


def _no_tools_body(
    scenario: Scenario, *, job_prefix: str
) -> LocalChatStreamRequest:
    """``has_tools=False`` 的请求体（两侧**逐字段相同**，只有 ``client_job_id`` 前缀不同）。

    ``client_job_id`` 必须不同：两侧各自注册自己的取消事件
    （旧 ``agent.py:140`` / 候选 ``entry.py:645``），同一个 id 会互相干扰。
    """
    return LocalChatStreamRequest(
        api_key="k",
        base_url="https://api.example.com/v1",
        model="scripted",
        messages=[{"role": "user", "content": "你好"}],
        user_content="你好",
        system_prompt=None,
        client_job_id=f"{job_prefix}-{scenario.name}",
        client_context=scenario.client_context,
    )


async def _collect_sse(body: LocalChatStreamRequest, settings) -> list[dict[str, Any]]:
    from app.api.v1.agent import _stream_local_chat

    events: list[dict[str, Any]] = []
    async for chunk in _stream_local_chat(body, settings):
        for line in chunk.split("\n"):
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:") :].strip()
            if payload:
                events.append(json.loads(payload))
    return events


async def _collect_candidate_sse(
    body: LocalChatStreamRequest, settings
) -> list[dict[str, Any]]:
    """候选入口（``has_tools=False`` 分支）的 SSE 帧列表。

    **与 ``_collect_sse`` 用同一段解码**（``data:`` 前缀 → ``json.loads``），
    因此两侧的差异只可能来自生成器本身，不可能来自解析方式。
    """
    from app.agent.langchain_runtime.entry import stream_candidate_engine_sse

    return _decode_sse(
        [chunk async for chunk in stream_candidate_engine_sse(body, settings)]
    )


def _decode_sse(chunks: Sequence[str]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for chunk in chunks:
        for line in chunk.split("\n"):
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:") :].strip()
            if payload:
                events.append(json.loads(payload))
    return events


async def new_frames(scenario: Scenario) -> list[dict[str, Any]]:
    """候选路径：生产适配器 ``stream_agent_events`` → 同一个 ``_stream_local_chat``。

    HTTP 层目前还没有候选分支（阶段 7 才接线），所以这里把
    ``sse_adapter.stream_agent_events`` 换成「构造候选 Agent 后调用**生产适配器**」的
    薄包装——被对照的映射逻辑仍然是生产实现，包装只负责注入脚本化模型与工具。
    """
    from app.core.config import get_settings

    import app.agent.langchain_runtime.sse_adapter as adapter
    import app.api.v1.agent as app_api

    if not scenario.has_tools:
        # ── has_tools=False（阶段 7 §7-2 / F3）：候选入口自己的纯聊天分支 ────
        # 生产件：``entry.stream_candidate_engine_sse``（含 ``_has_tools`` 判定、
        # ``build_llm_pair``、``chat_service.stream_chat``、``sse_frame``、``done``）。
        # 唯一替换是模型**工厂**（``entry.ChatOpenAI`` 模块级惰性解析点），
        # 与旧侧用的是同一个 ``_ScriptedLlmFactory``。
        import app.agent.langchain_runtime.entry as entry

        recorder = _ScriptedLlmFactory([list(round_) for round_ in scenario.rounds])
        original_entry_chat_openai = entry.ChatOpenAI
        entry.ChatOpenAI = recorder
        try:
            body = _no_tools_body(scenario, job_prefix="job-4b-new")
            frames = await _collect_candidate_sse(body, get_settings())
        finally:
            entry.ChatOpenAI = original_entry_chat_openai
        _NO_TOOLS_OBSERVATIONS["new"] = {
            "ctor_kwargs": list(recorder.ctor_kwargs),
            "astream_calls": [llm.astream_calls for llm in recorder.models],
            "seen_message_kinds": [
                [_message_kind(m) for m in seen]
                for llm in recorder.models
                for seen in llm.seen_messages
            ],
        }
        return frames

    tools = _tool_instances(scenario.tools_spec)
    phase_ctx = derive_task_phase(scenario.task_phase_states)
    messages = _input_messages(scenario)
    context = AgentContext(
        mode="assist",
        client_context=scenario.client_context,
        task_phase_context=phase_ctx,
        completed_tool_ids=frozenset(
            result.tool_call_id for result in scenario.client_tool_results
        ),
    )

    def _build_agent() -> Any:
        model = ScriptedStreamChat(
            rounds=[_to_ai_round(round_) for round_ in scenario.rounds]
        )
        return build_langchain_agent(
            model,
            tools,
            middleware=build_business_middleware(
                max_tool_rounds=scenario.max_tool_rounds
            ),
            name="lr_agent_candidate_4b",
        )

    async def _production_stream(*_args, **_kwargs):
        agent = _build_agent()
        async for frame in _ORIGINAL_STREAM_AGENT_EVENTS(
            agent,
            messages=list(messages),
            config=SseStreamConfig(
                context=context,
                client_context=scenario.client_context,
                task_phase_context=phase_ctx,
            ),
            client_context=scenario.client_context,
            task_phase_ctx=phase_ctx,
        ):
            yield frame

    original_adapter = adapter.stream_agent_events
    original_assist = assist_service.stream_assist
    original_loader = app_api.load_mcp_tools_from_servers
    original_chat_openai = app_api.ChatOpenAI

    async def _empty_loader(*_args, **_kwargs):
        return []

    adapter.stream_agent_events = _production_stream
    assist_service.stream_assist = _production_stream
    app_api.load_mcp_tools_from_servers = _empty_loader
    app_api.ChatOpenAI = _FakeChatOpenAI
    try:
        body = LocalChatStreamRequest(
            api_key="k",
            base_url="https://api.example.com/v1",
            model="scripted",
            messages=[{"role": "user", "content": "执行任务"}],
            user_content="执行任务",
            client_job_id=f"job-4b-new-{scenario.name}",
            client_context=scenario.client_context,
            client_tool_results=scenario.client_tool_results,
        )
        return await _collect_sse(body, get_settings())
    finally:
        adapter.stream_agent_events = original_adapter
        assist_service.stream_assist = original_assist
        app_api.load_mcp_tools_from_servers = original_loader
        app_api.ChatOpenAI = original_chat_openai


def _to_ai_round(round_: Sequence[Chunk]) -> list[AIMessageChunk]:
    out: list[AIMessageChunk] = []
    for chunk in round_:
        out.extend(to_ai_chunks(chunk))
    return out


# ── 适配器级（不经 HTTP）对照：更细的失败定位 ──────────────────────────


async def adapter_frames(scenario: Scenario) -> list[dict[str, Any]]:
    """只驱动 ``stream_agent_events``（不叠加 HTTP 层）的帧列表。

    ``has_tools=False`` 时返回空列表：该分支**没有适配器参与**
    （两侧都直接调 ``chat_service.stream_chat``），因此没有可对照的适配器直连帧。
    ``main`` 会跳过这一项而不是伪造一份。
    """
    if not scenario.has_tools:
        return []

    tools = _tool_instances(scenario.tools_spec)
    phase_ctx = derive_task_phase(scenario.task_phase_states)
    messages = _input_messages(scenario)
    model = ScriptedStreamChat(
        rounds=[_to_ai_round(round_) for round_ in scenario.rounds]
    )
    agent = build_langchain_agent(
        model,
        tools,
        middleware=build_business_middleware(max_tool_rounds=scenario.max_tool_rounds),
        name="lr_agent_candidate_4b",
    )
    frames: list[StreamEventPayload] = []
    async for frame in _ORIGINAL_STREAM_AGENT_EVENTS(
        agent,
        messages=list(messages),
        config=SseStreamConfig(
            context=AgentContext(
                mode="assist",
                client_context=scenario.client_context,
                task_phase_context=phase_ctx,
                completed_tool_ids=frozenset(
                    r.tool_call_id for r in scenario.client_tool_results
                ),
            )
        ),
        client_context=scenario.client_context,
        task_phase_ctx=phase_ctx,
    ):
        frames.append(frame)
    return [frame.to_sse_dict() for frame in frames]


# ── 对照与报告 ─────────────────────────────────────────────────────────


def first_difference(old: list[dict], new: list[dict]) -> tuple[int, Any, Any] | None:
    for index in range(max(len(old), len(new))):
        left = old[index] if index < len(old) else "<missing>"
        right = new[index] if index < len(new) else "<missing>"
        if left != right:
            return index, left, right
    return None


def testset_fingerprint() -> tuple[int, str]:
    """阶段 0 §1.1 的**规范算法**：``tests/**/*.py`` → 按完整路径排序 →
    ``basename:size`` → ``|`` 连接 → SHA-256 → 前 16 位大写。"""
    files = sorted(
        (path for path in (ROOT / "tests").rglob("*.py") if path.is_file()),
        key=lambda path: str(path),
    )
    joined = "|".join(f"{path.name}:{path.stat().st_size}" for path in files)
    digest = hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16].upper()
    return len(files), digest


async def main() -> int:
    count, digest = testset_fingerprint()
    print(f"测试集指纹（阶段 0 §1.1 规范算法）：{count} 文件 / {digest}")
    print("两侧入口：stream_assist（旧） / stream_agent_events（新）；均再过 _stream_local_chat")
    scenarios = scenario_list()
    failures: list[str] = []
    for scenario in scenarios:
        old = await old_frames(scenario)
        new = await new_frames(scenario)
        adapter_only = await adapter_frames(scenario)
        print(f"\n########## {scenario.name}（{scenario.baseline_class}）##########")
        print(f"  OLD ({len(old)} frames):")
        for index, frame in enumerate(old):
            print(f"    [{index}] {json.dumps(frame, ensure_ascii=False)}")
        print(f"  NEW ({len(new)} frames):")
        for index, frame in enumerate(new):
            print(f"    [{index}] {json.dumps(frame, ensure_ascii=False)}")
        if not scenario.has_tools:
            # 无工具纯聊天分支：没有候选图 / 适配器，故不比较「适配器直连」。
            # 改为打印两侧的模型输入观测：帧相同但输入不同也可能是巧合，这里把它排除。
            old_obs = _NO_TOOLS_OBSERVATIONS.get("old", {})
            new_obs = _NO_TOOLS_OBSERVATIONS.get("new", {})
            print("  [无工具分支] 模型工厂观测（两侧应逐键相同）:")
            print(f"    OLD: {json.dumps(old_obs, ensure_ascii=False)}")
            print(f"    NEW: {json.dumps(new_obs, ensure_ascii=False)}")
            _NO_TOOLS_OBSERVATIONS.clear()
            if old == new:
                if old_obs != new_obs:
                    failures.append(scenario.name)
                    print("  FAIL: 帧一致但两侧的模型输入不一致（输入不同 ⇒ 对照无效）")
                else:
                    print("  PASS: 逐帧一致（无工具纯聊天分支；两侧模型输入逐键相同）")
                continue
            diff = first_difference(old, new)
            index, left, right = diff  # type: ignore[misc]
            failures.append(scenario.name)
            print(f"  FAIL: 第 {index} 帧不同")
            print(f"    OLD: {json.dumps(left, ensure_ascii=False) if left != '<missing>' else left}")
            print(f"    NEW: {json.dumps(right, ensure_ascii=False) if right != '<missing>' else right}")
            continue
        if old == new:
            if new[:-1] != adapter_only:
                failures.append(scenario.name)
                print("  FAIL: HTTP 层与适配器直连帧不一致（HTTP 层改写了帧）")
            else:
                print("  PASS: 逐帧一致（含 HTTP/SSE 层）")
            continue
        diff = first_difference(old, new)
        index, left, right = diff  # type: ignore[misc]
        failures.append(scenario.name)
        print(f"  FAIL: 第 {index} 帧不同")
        print(f"    OLD: {json.dumps(left, ensure_ascii=False) if left != '<missing>' else left}")
        print(f"    NEW: {json.dumps(right, ensure_ascii=False) if right != '<missing>' else right}")

    print(f"\n===== 汇总：{len(scenarios) - len(failures)}/{len(scenarios)} 场景逐帧一致 =====")
    if failures:
        print("不一致场景：" + ", ".join(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
