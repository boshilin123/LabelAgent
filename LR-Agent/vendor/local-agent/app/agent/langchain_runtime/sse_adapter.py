"""阶段 4a：官方 Agent 原始事件 → SSE ``StreamEventPayload`` 适配器（骨架 + 机制无关部分）。

对应 ``docs/阶段4-SSE适配设计备忘.md`` §8 实施清单第 **1-5、7、8** 项。
第 6 项（轮末 ``tool_start`` / ``tool_result`` / ``tool_pending`` 映射）与第 9 项
（``experiments/compare_agent_contract.py`` 改造）**本文件不实现**——第 6 项依赖
阶段 3 的「本轮计划」帧（``docs/阶段3-跨请求续跑设计备忘.md`` §2）。落点见
:func:`_round_tail` / :class:`RoundTailState`，填这一个函数即可，无需重构本文件其余部分。

## 为什么必须走 ``astream`` 而不是 ``astream_events``

``astream_events`` 会在配置里设置 ``CONFIG_KEY_STREAM_MESSAGES_V2``
（``langgraph/pregel/main.py:3548,3603``），此时 ``messages`` 分片的 ``data[0]``
变成**协议事件 dict**；而 ``isinstance(message, AIMessageChunk)`` 与
``events_from_chunk`` 的 ``chunk.content`` / ``tool_call_chunks`` 访问会**静默全部落空**
（``langgraph/pregel/_messages.py:268-272`` 明写直接 ``astream`` 的调用方保持
v1 ``AIMessageChunk`` 形状）。因此本模块只驱动
:func:`app.agent.langchain_runtime.runtime.stream_agent_raw_events`
（``stream_mode=["messages","updates"]``、``version="v2"``），并**复用**它的
task + queue + ``aclose`` 骨架，不复制。

## 硬约束（备忘 §3）

1. **不发 ``done``** —— 唯一产地是 ``app/api/v1/agent.py:498``；
2. **不发 ``preparing(stage="mcp")``** —— 由 HTTP 生成器在调用流之前发出
   （``app/api/v1/agent.py:358-368``）；
3. **素 async generator** —— 除取消判定外不吞异常；框架异常直接上抛
   （见 :func:`_framework_error_policy`）；
4. 不做任何 camelCase 手工拼装 —— 重命名一律交给 ``StreamEventPayload.to_sse_dict()``
   （``app/schemas/agent.py:171-250``）。

## 本阶段实际产出的事件

``preparing{streaming}`` → 若干 ``text_delta`` / ``reasoning_delta`` /
``file_proposal_start`` / ``file_proposal_delta`` / ``file_edit_delta``，
外加（阶段 5 反向依赖）``custom`` 帧的直通。

**尚未产出** ``tool_start`` / ``tool_result`` / ``tool_pending`` —— 属清单第 6 项。
轮末素材（``calls`` / ``results`` / 拦截器 / 控制帧）已在每个轮边界算好并交给
:func:`_round_tail`，因此第 6 项落地时只需填充该函数。
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from app.agent.assist.pending_emitter import emit_tool_pending
from app.agent.assist.proposal_streamer import ProposalStreamInterceptor
from app.agent.langchain_runtime import runtime as _runtime
from app.agent.langchain_runtime.round_plan import RoundPlan
from app.agent.langchain_runtime.runtime import AgentContext
from app.agent.stream_adapter import events_from_chunk
from app.agent.tool_invocation import ResolvedToolCall, normalize_api_tool_calls
from app.agent.tools.tool_result import (
    build_tool_result,
    format_tool_result_for_display,
)
from app.agent.tools.workspace_file_reader import (
    FILE_PROPOSAL_TOOLS,
    STR_REPLACE_TOOL_NAME,
    VISION_TOOL_NAME,
    extract_doc_proposal_from_tool_result,
    extract_vision_path_from_tool_result,
    format_vision_tool_result_for_display,
    format_write_tool_result_for_display,
)
from app.agent.tools.workspace_path import is_lr_agent_relative
from app.schemas.agent import StreamEventPayload

__all__ = [
    "FrameworkErrorPolicy",
    "RoundTailState",
    "SseStreamConfig",
    "stream_agent_events",
]


# ── 运行配置 ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SseStreamConfig:
    """适配器的一次性运行配置（``stream_agent_events(config=...)`` 的取值）。

    设计说明：``stream_agent_events`` 的签名按备忘 §8-1 固定为
    ``(agent, *, messages, config, client_context=None, task_phase_ctx=None)``。
    其中 ``config`` **不是** langgraph 的 ``RunnableConfig`` —— 候选图没有 checkpointer
    也没有 ``thread_id``（阶段 3 方案 A），``stream_agent_raw_events`` 也不接受
    ``RunnableConfig``。``config`` 承载的是「怎么读这条流」：

    - ``context``：直接给定 :class:`AgentContext`（默认由 ``mode`` +
      ``client_context`` + ``task_phase_context`` 组装）；
    - ``client_context`` / ``task_phase_context`` / ``mode``：组装上下文用；
    - ``stream_modes`` / ``version``：透传给
      :func:`~app.agent.langchain_runtime.runtime.stream_agent_raw_events`。
      ``None`` 表示取模块当时的 ``runtime.STREAM_MODES`` / ``STREAM_VERSION``
      （**刻意运行时取值**：阶段 5 会把 ``"custom"`` 追加进 ``STREAM_MODES``，
      本模块无需改动即可跟随）。

    也接受等价的 :class:`~collections.abc.Mapping`（键名必须是本 dataclass 的字段）。
    """

    context: AgentContext | None = None
    client_context: Any = None
    task_phase_context: Any = None
    mode: str = "assist"
    stream_modes: tuple[str, ...] | None = None
    version: str | None = None

    def resolved_stream_modes(self) -> tuple[str, ...]:
        if self.stream_modes is not None:
            return tuple(self.stream_modes)
        return tuple(getattr(_runtime, "STREAM_MODES", ("messages", "updates")))

    def resolved_version(self) -> str:
        if self.version is not None:
            return self.version
        return str(getattr(_runtime, "STREAM_VERSION", "v2"))


_CONFIG_FIELDS = frozenset(SseStreamConfig.__dataclass_fields__)


def _coerce_config(config: Any) -> SseStreamConfig:
    """把 ``config`` 归一为 :class:`SseStreamConfig`（映射键名非法时**报错而非静默忽略**）。"""
    if config is None:
        return SseStreamConfig()
    if isinstance(config, SseStreamConfig):
        return config
    if isinstance(config, Mapping):
        unknown = sorted(str(key) for key in config if key not in _CONFIG_FIELDS)
        if unknown:
            msg = (
                "stream_agent_events(config=...) 只接受 SseStreamConfig 或只含 "
                f"{sorted(_CONFIG_FIELDS)} 的映射；未知键：{unknown}"
            )
            raise TypeError(msg)
        return SseStreamConfig(**dict(config))
    msg = (
        "stream_agent_events(config=...) 只接受 SseStreamConfig、映射或 None；"
        f"收到 {type(config).__name__}"
    )
    raise TypeError(msg)


# ── 框架异常策略（清单第 8 项）──────────────────────────────────────────


@dataclass(frozen=True)
class FrameworkErrorPolicy:
    """框架异常的处置口径（备忘 §5）。"""

    emit_error_frame: bool
    """**不**新增 SSE ``error`` 帧。"""

    emit_done_frame: bool
    """**不**代 HTTP 层发 ``done``（截断即截断）。"""

    propagate: bool
    """异常原样上抛，交由 HTTP 层的 ``try/finally`` 收尾（``agent.py:147/500``）。"""

    tool_errors_arrive_as: str
    """工具级失败的带内等价物（旧路径同构信号）。"""

    reason: str


_FRAMEWORK_ERROR_POLICY = FrameworkErrorPolicy(
    emit_error_frame=False,
    emit_done_frame=False,
    propagate=True,
    tool_errors_arrive_as="tool_result payload with status='error'",
    reason=(
        "阶段 0 把「无 error 帧」写进断言（tests/test_agent_baseline_contract.py:1285，"
        "且 :1252-1257/:1279-1285 是整表相等）；全仓唯一 error 生产者是 "
        "annotation_quality.py:67；阶段 4 门槛是「客户端无需改动」，新帧类型即协议变更。"
        "代价：框架新增失败模式表现为截断且无 done（可诊断性不优于旧路径），"
        "真正新增 error 应作为阶段 7 的显式提案、新旧两侧同时加。"
    ),
)


def _framework_error_policy() -> FrameworkErrorPolicy:
    """返回框架异常策略（清单第 8 项的具名落点）。

    本函数是**声明式**的：:func:`stream_agent_events` 不捕获框架异常，
    因此该策略由结构保证，而不是靠运行期分支实现——测试对返回值与
    「上抛且无 error/done 帧」的行为同时断言，两者必须一致。
    """
    return _FRAMEWORK_ERROR_POLICY


# ── 事件分片解析（v2 形状：``{"type","ns","data"}``）───────────────────


def _part_kind(part: Any) -> str | None:
    """取分片模式名；无法识别时返回 ``None``（调用方跳过）。"""
    if isinstance(part, Mapping):
        kind = part.get("type")
        return kind if isinstance(kind, str) else None
    if isinstance(part, tuple) and len(part) == 2 and isinstance(part[0], str):
        return part[0]
    return None


def _part_data(part: Any) -> Any:
    """取分片负载（``runtime.AgentEvent`` 的 dict 与 tuple 两种形态都支持）。"""
    if isinstance(part, Mapping):
        return part.get("data")
    if isinstance(part, tuple) and len(part) == 2:
        return part[1]
    return None


def _message_of(data: Any) -> Any:
    """``messages`` 分片的负载是 ``(message, metadata)``（实测确认）。"""
    if isinstance(data, (tuple, list)) and data:
        return data[0]
    return None


def _metadata_of(data: Any) -> Mapping[str, Any]:
    if isinstance(data, (tuple, list)) and len(data) > 1 and isinstance(data[1], Mapping):
        return data[1]
    return {}


# ── 增量事件与提案拦截（清单第 3、4 项）───────────────────────────────


def _delta_events(chunk: AIMessageChunk) -> list[StreamEventPayload]:
    """单分片的文本 / reasoning 增量事件（**原样复用**旧路径实现）。

    ``emit_tool_chunks=False`` 是关键：``tool_call_chunks`` 交给
    :class:`ProposalStreamInterceptor`，**绝不**在此处发 ``tool_start``
    （备忘 §2 映射表）。同 chunk 内 **text 先于 reasoning**，顺序由
    ``app/agent/stream_adapter.py:12-25`` 固定，本函数不做任何重排。
    尾随空分片（``content=""``、``chunk_position="last"``）恒返回 ``[]``。
    """
    return events_from_chunk(chunk, emit_tool_chunks=False)


def _new_interceptor(client_context: Any) -> ProposalStreamInterceptor:
    """每轮新建拦截器（``assist_service.py:102-105`` 同款）。

    ``tool_call_chunks[].index`` **每轮从 0 重编号**（``langchain_core/messages/ai.py:427``），
    跨轮复用实例会把上一轮的 ``rel_path`` / ``content_sent_len`` 残留到本轮，
    导致提案 delta 错标路径、丢失新内容前缀。
    """
    return ProposalStreamInterceptor(client_context)


# ── 轮末素材（清单第 5 项；第 6 项的输入）─────────────────────────────


def _is_model_update(node: Any) -> bool:
    """``node`` 是否是「模型节点（或其 after_model 钩子）」的 updates 键。

    节点名依据：``langchain/agents/factory.py:1543/1547`` 建 ``"model"`` / ``"tools"``；
    after_model 钩子的节点名为 ``"{name}.after_model"``（``:1789``）。
    """
    name = str(node)
    return name == "model" or name.endswith(".after_model")


_AFTER_MODEL_SUFFIX = ".after_model"


def _is_after_model_node(node: Any) -> bool:
    """``node`` 是否是某个 middleware 的 ``after_model`` 钩子节点。

    **用途：``messages`` 流的节点过滤（实测，见
    ``experiments/probe_stage4b_node_attribution.py``）**。v1 handler 会把节点输出里的
    **任何** ``BaseMessage`` 回放到 ``messages`` 流（``langgraph/pregel/_messages.py:106-120``），
    因此 ``after_model`` 注入的合成 ``AIMessage`` / ``ToolMessage`` 会带着
    ``metadata["langgraph_node"] == "<Middleware>.after_model"`` 出现在流里。
    若照单全收：合成 ``AIMessage(content="")`` 会变成一条空 ``text_delta``
    （阶段 5 的视觉兜底正是靠注入合成消息实现的）；合成 ``ToolMessage`` 会被误当作
    工具执行结果。
    """
    return str(node).endswith(_AFTER_MODEL_SUFFIX)



def _model_tool_calls(update: Any) -> list[Any]:
    """从单个节点更新里取**最后一条 AI 消息**的 ``tool_calls``。

    取最后一条 AI 消息（而不是 ``messages[-1]``）：``*.after_model`` 节点的更新里
    末尾可能是被注入的 ``ToolMessage``（``middleware.py`` 的抑制注入）。
    """
    if isinstance(update, Mapping):
        messages = update.get("messages") or []
    else:
        messages = getattr(update, "messages", None) or []
    for message in reversed(list(messages)):
        if isinstance(message, Mapping):
            calls = message.get("tool_calls")
            is_ai = message.get("type") == "ai"
        else:
            calls = getattr(message, "tool_calls", None)
            is_ai = isinstance(message, AIMessage)
        if calls:
            return list(calls)
        if is_ai:
            return []
    return []


def _dedupe_calls(calls: Sequence[ResolvedToolCall]) -> list[ResolvedToolCall]:
    seen: set[str] = set()
    out: list[ResolvedToolCall] = []
    for call in calls:
        if call.tool_call_id in seen:
            continue
        seen.add(call.tool_call_id)
        out.append(call)
    return out


def _resolve_round_calls(updates: Any) -> list[ResolvedToolCall]:
    """本轮模型调用表（**保序**，即 ``tool_start`` 该用的顺序）。

    来源：``updates["model" | "*.after_model"]["messages"][-1(AI)].tool_calls``
    （备忘 §2 映射表第 4 行）。实测（本机 migration 环境探针）该分片携带的
    ``AIMessage.tool_calls`` 的 ``args`` **已是 dict**。

    归一化复用 ``app.agent.tool_invocation.normalize_api_tool_calls``（不引入新抽象）；
    缺 ``id`` 的调用会拿到一个随机兜底 id（``tool_invocation.py:41-42``）——
    真实 provider 的流式调用恒带 id，此分支只为防御。
    """
    if not isinstance(updates, Mapping):
        return []
    for node, update in updates.items():
        if not _is_model_update(node):
            continue
        api_calls = _model_tool_calls(update)
        if api_calls:
            return _dedupe_calls(normalize_api_tool_calls(api_calls))
    return []


def _resolve_round_plan(updates: Any) -> RoundPlan | None:
    """从 ``updates`` 里取**权威本轮计划**（``*.after_model`` 的 ``round_plan`` 字段）。

    依据 ``docs/阶段4-SSE适配设计备忘.md`` §8「集成决定」（阶段 3 §4-2 实测）：
    计划**不在** ``custom`` 帧里，而在 ``middleware.py:279`` 的
    ``after_model`` 返回值 ``{"round_plan": plan}`` 中——因此适配器直接读
    ``updates`` 的对应节点更新。

    ``custom`` 计划帧**不是**唯一来源；本函数只认 ``updates``。
    同一条记录里可能有多个 ``*.after_model`` 节点（``BudgetWrapUp`` /
    ``ModelCallLimit`` 也注册了同名 hook），只有真正带 ``round_plan`` 的那个算数。
    """
    if not isinstance(updates, Mapping):
        return None
    for node, update in updates.items():
        if not _is_model_update(node):
            continue
        if isinstance(update, Mapping):
            plan = update.get("round_plan")
        else:
            plan = getattr(update, "round_plan", None)
        if isinstance(plan, RoundPlan):
            return plan
    return None


def _plan_arguments(
    plan: RoundPlan, call: ResolvedToolCall
) -> dict[str, Any]:
    """该调用在**旧路径 emit 时实际使用的参数**。

    ``plan.merged_arguments`` 只登记「合并后的首个 ``auto_annotate``」
    （``round_plan.py:411-417``）。旧路径对这类调用发 ``tool_start`` 与
    ``tool_pending`` 时用的是**合并后**的参数（``tool_loop.py:316,716-720``），
    因此挂起帧必须走这张改写表，而不是 ``tool_call_chunks`` 的原始参数。
    """
    merged = plan.merged_arguments.get(call.tool_call_id)
    return dict(merged) if merged is not None else dict(call.arguments)



def _tool_messages_in(part: Any) -> list[ToolMessage]:
    """从一个原始分片里取出 ``ToolMessage``（``messages`` 与 ``updates`` 两种承载）。"""
    found: list[ToolMessage] = []
    if isinstance(part, ToolMessage):
        return [part]
    kind = _part_kind(part)
    data = _part_data(part)
    if kind == "messages":
        message = _message_of(data)
        if isinstance(message, ToolMessage):
            found.append(message)
        return found
    if isinstance(data, Mapping):
        # ``updates``：``{node: {"messages": [...]}}``
        for update in data.values():
            if isinstance(update, Mapping):
                messages = update.get("messages") or []
            else:
                messages = getattr(update, "messages", None) or []
            found.extend(m for m in messages if isinstance(m, ToolMessage))
        return found
    if isinstance(part, Mapping):
        # 裸 ``{node: {"messages": [...]}}``（便于单测直接构造）
        for update in part.values():
            if isinstance(update, Mapping):
                found.extend(
                    m
                    for m in (update.get("messages") or [])
                    if isinstance(m, ToolMessage)
                )
    return found


_TOOLS_NODE = "tools"
"""执行工具的图节点名（``langchain/agents/factory.py:1543/1547``）。"""


def _part_node(part: Any) -> str:
    """``messages`` 分片的来源节点名（``metadata["langgraph_node"]``）；取不到时空串。"""
    return str(_metadata_of(_part_data(part)).get("langgraph_node") or "")


def _tool_results(parts: Sequence[Any]) -> list[ToolMessage]:
    """工具结果（**双源去重**）。

    实测（本机探针）：同一个 ``ToolMessage`` **同时**出现在 ``messages`` 流
    （``langgraph_node="tools"``）与 ``updates["tools"]["messages"]``。v1 handler
    **不**过滤 ``ToolMessage``（``langgraph/pregel/_messages.py:307-314``），
    因此适配器必须自己按 ``tool_call_id`` 去重——否则每个工具结果会发两次。

    顺序 = 首见顺序（``messages`` 流先于同轮的 ``updates``，故等于执行顺序）。
    ``tool_call_id`` 为空的 ``ToolMessage`` 不参与去重（全部保留），
    避免把多个无 id 结果错误合并成一个。

    ``node="tools"`` 时**只**保留 ``langgraph_node == "tools"`` 的那一份：
    其余 ``ToolMessage`` 全部是 ``after_model`` 注入的**状态通道**产物
    （``middleware.py`` 的抑制注入，实测 ``langgraph_node`` 为
    ``"BusinessRoundMiddleware.after_model"``），旧路径不发它们的帧
    （``tool_loop.py:469-487`` 只补 ``ToolMessage``，不发 ``tool_result``）。
    不做这次过滤会让被抑制的调用同时发 payload 与 ``tool_result`` 两帧。
    裸分片（无 ``metadata``，如单测直接构造的 ``updates`` 形态）不参与过滤。
    """
    out: list[ToolMessage] = []
    seen: set[str] = set()
    for part in parts:
        if _part_kind(part) == "messages" and _part_node(part) not in (
            "",
            _TOOLS_NODE,
        ):
            continue
        for message in _tool_messages_in(part):
            tool_call_id = str(getattr(message, "tool_call_id", "") or "")
            if tool_call_id and tool_call_id in seen:
                continue
            if tool_call_id:
                seen.add(tool_call_id)
            out.append(message)
    return out



# ── 轮末（清单第 6 项留白）─────────────────────────────────────────────


@dataclass(frozen=True)
class RoundTailState:
    """一个「模型轮」收尾时的全部素材（:func:`_round_tail` 的唯一入参）。

    第 6 项落地时应当只读这些字段，不要再回到流里翻：

    - ``calls``：本轮模型调用表（模型给出的**原始顺序**，含被抑制者）
      —— ``tool_start`` 的顺序来源；
    - ``results``：本轮 ``ToolMessage``（双源去重）—— ``tool_result`` 的载荷来源；
      写类工具的失败摘要化/``dismissed`` 补发按 ``tool_loop.py:282-337`` 的规则做；
    - ``interceptor``：本轮拦截器 —— ``streamed_paths_by_call_id()``
      用于抑制重复的 ``file_proposal_start`` 与给悬挂卡片补 ``dismissed``；
    - ``updates``：本轮 ``updates`` 分片合并结果 —— 阶段 3 的
      ``coalesced`` / ``duplicate_call`` / ``phase_blocked`` 判定所需的 state 不在
      这里，而在 ``control_frames`` 的「本轮计划」帧里；
    - ``control_frames``：``custom`` 控制帧（``type`` 见
      :data:`_CUSTOM_CONTROL_TYPES`）；``plan_frame`` 属性给出其中的「本轮计划」帧；
    - ``interrupted``：本轮是否出现 ``{"__interrupt__": ...}``
      （阶段 3 方案 A 下**永不出现**，字段仅为形状完整保留）；
    - ``parts``：本轮全部原始 v2 分片（含 ``metadata``），供需要
      ``langgraph_step`` / ``langgraph_node`` / ``ns`` 的排序或子代理事件使用；
    - ``client_context`` / ``task_phase_ctx``：本轮拦截器与门禁的同一份上下文。
    """

    index: int
    calls: tuple[ResolvedToolCall, ...]
    results: tuple[ToolMessage, ...]
    interceptor: ProposalStreamInterceptor
    updates: Mapping[str, Any]
    parts: tuple[Any, ...]
    control_frames: tuple[Mapping[str, Any], ...]
    interrupted: bool
    client_context: Any
    task_phase_ctx: Any

    @property
    def plan_frame(self) -> Mapping[str, Any] | None:
        """阶段 3 的「本轮计划」帧（``custom``，``type="round_plan"``）—— 没有则 ``None``。

        **未验证**：阶段 3 的帧字段名尚未冻结（``docs/阶段3-跨请求续跑设计备忘.md``
        §2 只写了 ``runtime.stream_writer(round_plan_frame)``）。第 6 项落地时
        必须先用阶段 3 的实测输出核对字段名，不要假设。
        """
        for frame in self.control_frames:
            if str(frame.get("type")) == "round_plan":
                return frame
        return None


async def _round_tail(state: RoundTailState) -> AsyncIterator[StreamEventPayload]:
    """轮末映射（备忘 §8 实施清单第 6 项）：``tool_start`` / ``tool_result`` /
    ``tool_pending`` + 写类工具的 ``file_proposal*`` 定稿帧。

    在 :func:`stream_agent_events` 里，**每个轮边界**（下一轮的首个模型分片）
    与**流正常结束**时各被调用一次，位置正好是「上一轮 deltas 之后、下一轮
    deltas 之前」——与基线序列
    （``tests/test_agent_baseline_contract.py:294-299``：deltas → 模型调用序的
    ``tool_start``/``tool_result`` → 下轮 deltas）同构。

    ## 权威输入与顺序（``experiments/probe_stage4b_old_order.py`` 实测）

    本轮计划取 ``updates`` 中带 ``round_plan`` 的 ``*.after_model`` 更新
    （:func:`_resolve_round_plan`），**不读** ``custom`` 帧。计划缺席时退回
    「``model`` 更新的调用表全部视为立即执行」（阶段 1 无 middleware 的形态）。

    帧顺序 = **``suppressed`` → ``execute_now`` → ``deferred``**，其中
    ``deferred`` 保持计划里的合并后顺序。与旧路径逐字对照（探针 G/H/I/I2/J）：

    - ``suppressed`` 的 ``tool_start`` **在** ``execute_now`` 之前
      （G：``coalesced(c2)`` → ``read(r1)`` → ``pending(c1)``；
      I2：``phase_blocked(w1)`` → ``read(r1)``）；
    - ``execute_now`` 整体**在** ``deferred`` 之前，**不按模型调用序交错**
      （J：模型序 ``[a1(ASYNC), r1(SYNC)]`` 实测输出仍是 ``r1`` 先、
      ``a1`` 的 ``tool_pending`` 后，即 ``tool_loop.py:645-720`` 的
      「先 immediate 循环、后 async_pending」）；
    - **唯一按计划序的地方**：被合并掉的 ``auto_annotate`` 在计划里排在其
      存活者**之后**（``round_plan.py:367-380`` 的 ``async_pending =
      [merged_first, ...]``），而存活者属 ``deferred``，所以「suppressed 全排
      最前」对「合并 + 立即执行」共存轮**不成立**（探针 G）。本实现取
      **旧路径实际产出的顺序**（即上面 G 的序列），而不是散文式的「最前」。

    ## 三块素材的用法

    - ``suppressed``：``tool_start`` + ``tool_result(payload = RoundToolCall.result_json)``
      —— 即 ``build_tool_result`` 的
      ``{ok,tool,status,summary,file_written,proposal_pending}``，
      status 为 ``already_completed`` / ``phase_blocked`` / ``coalesced`` /
      ``duplicate_call``。它们**不查** ``ToolMessage``：旧路径这几类帧的载荷
      就是 ``build_tool_result`` 的返回值（``tool_loop.py:416-426``）。
    - ``execute_now``：``tool_start`` + ``tool_result``，载荷来自该调用的
      ``ToolMessage``（按 ``tool_call_id`` 精确配对）+ ``tool_loop.py:264-287`` 的显示层：
      视觉工具走 ``format_vision_tool_result_for_display``；写类工具**只有**
      解析出 ``__doc_proposal__`` 才 ``format_write_tool_result_for_display``，
      失败时保持**原始 JSON**（``tool_loop.py:275-280`` 的 elif 分支**没有**
      else，阶段 0 §8-6）；其余一律 ``format_tool_result_for_display``。
    - ``deferred``：``emit_tool_pending``（``tool_start`` ×N + 双写
      ``clientToolCalls``/``toolCalls`` 的 ``tool_pending``），与旧路径同一个
      生成器、同一份参数（含合并后的参数）。

    ## 必须被丢弃、永不产帧（均有实测）

    1. ``status == "client_tool_pending"`` 的 ``ToolMessage`` —— ``awrap_tool_call``
       对 ASYNC 工具返回的合成拦截消息（``middleware.py:355-368``）。旧路径此时
       **不发任何** ``tool_result``（只发 ``tool_start`` + ``tool_pending``），
       阶段 3 §4-1 有实测。
       ⚠️ **不能靠节点名识别**：该消息由 ``tools`` 节点产出，``messages`` 流里
       ``langgraph_node == "tools"``、``updates["tools"]["messages"]`` 里也有它
       （``experiments/probe_stage4b_node_attribution.py`` 实测）。本函数靠
       **计划归属**（``deferred`` 的调用一律不出 ``tool_result``）而不是内容判断。
    2. ``after_model`` 注入的合成 ``AIMessage`` / ``ToolMessage`` ——
       在 :func:`stream_agent_events` 的分片循环里按
       ``langgraph_node`` 的 ``.after_model`` 后缀整帧跳过（:func:`_is_after_model_node`）。
    """
    plan = _resolve_round_plan(state.updates)
    calls = _resolve_round_calls(state.updates)

    if plan is None:
        deferred_ids: set[str] = set()
        execute_calls = list(calls)
        deferred_calls: list[ResolvedToolCall] = []
    else:
        suppressed_ids = {call.tool_call_id for call in plan.suppressed}
        deferred_ids = {call.tool_call_id for call in plan.deferred}
        execute_calls = [
            call
            for call in calls
            if call.tool_call_id not in suppressed_ids
            and call.tool_call_id not in deferred_ids
        ]
        deferred_calls = [
            ResolvedToolCall(
                tool_call_id=call.tool_call_id,
                name=call.name,
                arguments=_plan_arguments(plan, call),
                source=call.source,
            )
            for call in calls
            if call.tool_call_id in deferred_ids
        ]

    # ── 1. suppressed：payload 直接来自本轮计划，不查 ToolMessage ──────
    if plan is not None:
        for plan_call in plan.suppressed:
            if plan_call.result_json is None:
                continue
            yield StreamEventPayload(
                type="tool_start",
                tool_call_id=plan_call.tool_call_id,
                name=plan_call.name,
                arguments=json.dumps(
                    plan_call.arguments, ensure_ascii=False, indent=2
                ),
            )
            yield StreamEventPayload(
                type="tool_result",
                tool_call_id=plan_call.tool_call_id,
                result=plan_call.result_json,
            )

    # ── 2. execute_now：真实 ToolMessage + 旧路径的显示层规则 ──────────
    by_id = {
        str(getattr(message, "tool_call_id", "") or ""): message
        for message in state.results
    }
    streamed_paths_by_call_id = state.interceptor.streamed_paths_by_call_id()
    streamed_paths = set(streamed_paths_by_call_id.values())

    for call in execute_calls:
        args = _plan_arguments(plan, call) if plan is not None else dict(call.arguments)
        yield StreamEventPayload(
            type="tool_start",
            tool_call_id=call.tool_call_id,
            name=call.name,
            arguments=json.dumps(args, ensure_ascii=False, indent=2),
        )
        message = by_id.get(call.tool_call_id)
        if message is None:
            # 该调用被计划判为「立即执行」，却没有对应的 ToolMessage：
            # 只可能是框架在 tools 节点上失败。保守地不发 tool_result
            # （旧路径此时也没有结果），而不是造一个空载荷。
            continue
        if str(getattr(message, "status", "") or "") == "client_tool_pending":
            # ASYNC 拦截消息：旧路径不发 tool_result（阶段 3 §4-1）。
            continue

        display_result, doc_proposal, vision_path = _display_result(
            call.name, str(message.content)
        )
        yield StreamEventPayload(
            type="tool_result",
            tool_call_id=call.tool_call_id,
            result=display_result,
        )
        async for proposal_event in _proposal_frames(
            call,
            doc_proposal=doc_proposal,
            vision_path=vision_path,
            streamed_paths=streamed_paths,
            streamed_paths_by_call_id=streamed_paths_by_call_id,
        ):
            yield proposal_event

    # ── 3. deferred：与旧路径同一个 pending 发射器 ────────────────────
    if deferred_calls:
        async for pending_event in emit_tool_pending(deferred_calls):
            yield pending_event


def _display_result(
    name: str, raw_result: str
) -> tuple[str, dict[str, Any] | None, str | None]:
    """复刻 ``tool_loop.py:264-287`` 的**显示层**三态选择。

    返回 ``(display_result, doc_proposal, vision_path)``：

    - 视觉工具：提取图片绝对路径（仅当文件真实存在，``workspace_file_reader.py:321-335``）；
      命中则结果去内部标记后**缩进 JSON** 展示；
    - 写类工具：只有解析出 ``__doc_proposal__`` 才摘要化，**失败保持原始 JSON**
      （``tool_loop.py:275-280`` 缺 else 分支——阶段 0 §8-6 的刻意不对称）；
    - 其余：``format_tool_result_for_display``（有 ``summary`` 取 ``summary``，
      否则 ``message``，再否则原样）。

    **去框架化（实测差异）**：模型指向未注册工具时，旧路径的 ``_invoke_tool_fn``
    发 ``{"ok": false, … "summary": "未知工具: <name>"}``（``tool_loop.py:88``），
    而框架的 ``ToolNode`` 发英文模板
    ``Error: <name> is not a valid tool, try one of [...].``
    （``langgraph/prebuilt/tool_node.py:108-110``）。两者都是「工具未就绪」的带内
    信号，但**帧必须逐字节一致**，故按模板识别后换回旧 JSON
    （:func:`_old_unknown_tool_result`）。
    """
    unknown = _old_unknown_tool_result(raw_result)
    if unknown is not None:
        return unknown, None, None
    if name == VISION_TOOL_NAME:
        vision_path = extract_vision_path_from_tool_result(name, raw_result)
        if vision_path:
            return (
                format_vision_tool_result_for_display(raw_result),
                None,
                vision_path,
            )
        return raw_result, None, None
    if name in FILE_PROPOSAL_TOOLS:
        doc_proposal = extract_doc_proposal_from_tool_result(name, raw_result)
        if doc_proposal:
            return (
                format_write_tool_result_for_display(raw_result),
                doc_proposal,
                None,
            )
        return raw_result, None, None
    return format_tool_result_for_display(raw_result), None, None


_INVALID_TOOL_PATTERN = re.compile(
    r"^Error: (?P<tool>.+?) is not a valid tool, try one of \[.*\]\.$", re.DOTALL
)
"""``langgraph/prebuilt/tool_node.py:108-110`` 的 ``INVALID_TOOL_NAME_ERROR_TEMPLATE``。"""


def _old_unknown_tool_result(raw_result: str) -> str | None:
    """把框架的「未注册工具」错误文本换回旧路径的**显示载荷**。

    旧路径先造 ``{"ok": false, … "summary": "未知工具: <name>"}``
    （``tool_loop.py:87-90``），该文本随后**照样**过
    :func:`format_tool_result_for_display`（未知工具既不在 ``FILE_PROPOSAL_TOOLS``
    也不等于 ``VISION_TOOL_NAME``），因此最终帧载荷是 ``summary`` 的值而不是整段
    JSON——阶段 0 基线 ``TestToolError::test_unknown_tool_reports_error_json``
    断言的正是 ``"未知工具: memory_read"``。

    未命中模板时返回 ``None``（**不猜**）。
    """
    match = _INVALID_TOOL_PATTERN.match(raw_result.strip())
    if match is None:
        return None
    tool = match.group("tool")
    return format_tool_result_for_display(
        build_tool_result(
            ok=False, tool=tool, status="error", summary=f"未知工具: {tool}"
        )
    )


async def _proposal_frames(
    call: ResolvedToolCall,
    *,
    doc_proposal: dict[str, Any] | None,
    vision_path: str | None,
    streamed_paths: set[str],
    streamed_paths_by_call_id: Mapping[str, str],
) -> AsyncIterator[StreamEventPayload]:
    """复刻 ``tool_loop.py:289-347`` 的提案定稿帧。

    - 工具失败（无 ``__doc_proposal__``）却在流式期间已出过卡 → 补
      ``file_proposal(status="dismissed")`` 收掉悬挂卡片，否则 Keep All 会把
      空内容写盘（``tool_loop.py:289-302``）；
    - 成功 → ``file_proposal_start`` + 200 字长 ``file_proposal_delta`` +
      ``file_proposal``；``file_proposal_start`` / delta **仅当**该路径尚未在
      流式阶段出过卡（``omit_file_proposal_start_delta``）才补发
      （``tool_loop.py:307-329``）；
    - ``is_lr_agent_relative`` 的内部路径（``.lr-agent/...``）不出任何帧
      （``tool_loop.py:307``）。

    ``vision_path`` 与 ``provider_is_vision`` 的**多模态补消息**不在本函数：
    那是图状态（messages）里的追加，属工具自身经 ``ToolRuntime`` 完成，
    适配器只负责帧。
    """
    del vision_path  # 多模态补消息是图状态，不是帧
    if doc_proposal is None:
        if call.name in FILE_PROPOSAL_TOOLS:
            streamed_path = streamed_paths_by_call_id.get(call.tool_call_id)
            if streamed_path:
                yield StreamEventPayload(
                    type="file_proposal",
                    summary=str(
                        call.arguments.get("relative_path") or streamed_path
                    ),
                    content="",
                    image_path=streamed_path,
                    mode=(
                        "edit"
                        if call.name == STR_REPLACE_TOOL_NAME
                        else "write"
                    ),
                    status="dismissed",
                )
        return

    full_content = doc_proposal["content"]
    rel_path = doc_proposal["relative_path"]
    if is_lr_agent_relative(rel_path):
        return
    operation = str(doc_proposal.get("operation") or "write")
    already_streamed = rel_path in streamed_paths if streamed_paths else False
    if operation != "delete" and not already_streamed:
        yield StreamEventPayload(
            type="file_proposal_start",
            summary=doc_proposal["title"],
            image_path=rel_path,
            detail=str(len(full_content)),
            mode=operation,
        )
        chunk_size = 200
        offset = 0
        while offset < len(full_content):
            end = min(offset + chunk_size, len(full_content))
            yield StreamEventPayload(
                type="file_proposal_delta",
                content=full_content[offset:end],
                image_path=rel_path,
                mode=operation,
            )
            offset = end
    yield StreamEventPayload(
        type="file_proposal",
        summary=doc_proposal["title"],
        content=full_content,
        image_path=rel_path,
        mode=operation,
        old_path=str(doc_proposal.get("old_path") or "") or None,
    )



# ── 轮累积器 ───────────────────────────────────────────────────────────


@dataclass
class _RoundAccumulator:
    """一个模型轮的累积状态（适配器内部；不跨轮复用）。"""

    index: int
    client_context: Any
    task_phase_ctx: Any
    interceptor: ProposalStreamInterceptor
    step: Any = None
    saw_model_update: bool = False
    interrupted: bool = False
    parts: list[Any] = field(default_factory=list)
    update_payloads: list[Mapping[str, Any]] = field(default_factory=list)
    control_frames: list[Mapping[str, Any]] = field(default_factory=list)

    def starts_new_round(self, step: Any) -> bool:
        """本分片是否属于**下一轮**。

        判据只有一条：**该轮已经见过模型分片，且新分片的 ``langgraph_step``
        与首片不同**（实测：model 轮为 4、11…；``tools`` 轮为 7…）。

        为什么不看 ``updates``：一个模型轮内部还会插入若干**别的 step** 的
        ``updates`` 分片（``*.before_model`` / ``*.*.after_model`` / ``tools``），
        并且 ``after_model`` 注入的 ``ToolMessage`` 与 ``tools`` 节点的
        ``ToolMessage`` 分别来自 step 6/7——它们**都属于本轮**（实测分片轨迹见
        ``experiments/probe_stage4b_old_order.py --framework``）。若把每个新 step
        都当轮边界，本轮的工具结果会被切进下一轮、丢失或错配。

        ``metadata`` 缺 ``langgraph_step`` 时退回「已见过本轮 ``updates["model"]``」
        这一模型更新边界（旧行为）；此时 ``updates`` 一旦出现即切轮——
        因为已无更细的排序信息可用。
        """
        if step is not None and self.step is not None:
            return step != self.step
        return self.saw_model_update

    def note_chunk(self, step: Any) -> None:
        if self.step is None and step is not None:
            self.step = step

    def note_updates(self, payload: Mapping[str, Any]) -> None:
        self.update_payloads.append(payload)
        if any(_is_model_update(node) for node in payload):
            self.saw_model_update = True
        if "__interrupt__" in payload:
            self.interrupted = True

    def combined_updates(self) -> dict[str, Any]:
        merged: dict[str, Any] = {}
        for payload in self.update_payloads:
            merged.update(payload)
        return merged

    def tail_state(self) -> RoundTailState:
        return RoundTailState(
            index=self.index,
            calls=tuple(_resolve_round_calls(self.combined_updates())),
            results=tuple(_tool_results(self.parts)),
            interceptor=self.interceptor,
            updates=self.combined_updates(),
            parts=tuple(self.parts),
            control_frames=tuple(self.control_frames),
            interrupted=self.interrupted,
            client_context=self.client_context,
            task_phase_ctx=self.task_phase_ctx,
        )


# ── custom 帧（阶段 5 反向依赖 + 阶段 3 控制帧）────────────────────────


_CUSTOM_CONTROL_TYPES: frozenset[str] = frozenset({"round_plan", "turn_end"})
"""**不给前端发帧**的 ``custom`` 控制帧类型（适配器自用）。

- ``round_plan``：阶段 3 在 ``after_model`` 里 ``runtime.stream_writer(round_plan_frame)``
  发出的「本轮计划」，供第 6 项判定抑制状态（``docs/阶段3-跨请求续跑设计备忘.md`` §2）；
- ``turn_end``：阶段 3 的收轮标记。

**inferred**：这两个类型名取自阶段 3 备忘的散文描述，尚未用阶段 3 的实测输出核对；
第 6 项落地时必须确认，必要时同步修改本集合（阶段 4 自身行为不受影响——
默认 ``stream_modes`` 不含 ``"custom"``）。
"""


def _custom_event(data: Any) -> StreamEventPayload | None:
    """把 ``custom`` 分片的 ``data`` 直通为 ``StreamEventPayload``（备忘 §1 追加要求）。

    形状依据：``langgraph/pregel/main.py:4219-4235`` 的通用分支产出
    ``{"type": "custom", "ns": ns, "data": payload}``，``payload`` 为
    ``Runtime.stream_writer`` 的入参（``langgraph/runtime.py:116``）。

    ⚠️ **``ns`` 不得用于归因**（阶段 5 前置探针实测）：``custom`` 分片恒为
    ``{"type": "custom", "ns": (), "data": payload}``——``ns`` 与 ``messages`` /
    ``updates`` 完全相同，**不标识**工具或子代理作用域。阶段 5 接子代理事件时
    只能靠 ``payload`` 内容 + 到达顺序归因（实测顺序：
    ``updates[model]`` → ``custom`` ×N → ``messages``（``ToolMessage``，
    ``node=tools``）→ ``updates[tools]``）。本函数因此只读 ``data``。

    已构造好的 :class:`StreamEventPayload` 原样返回；映射则按其字段构造
    （``StreamEventPayload`` 是 pydantic 默认 ``extra="ignore"``，多余键被忽略）。
    **载荷畸形时不静默丢弃**——让 pydantic 的校验错误上抛（素 async generator 约束）。
    """
    if isinstance(data, StreamEventPayload):
        return data
    if isinstance(data, Mapping) and isinstance(data.get("type"), str):
        return StreamEventPayload(**dict(data))
    return None


# ── 主入口 ─────────────────────────────────────────────────────────────


async def stream_agent_events(
    agent: Any,
    *,
    messages: Sequence[Any],
    config: SseStreamConfig | Mapping[str, Any] | None,
    client_context: Any = None,
    task_phase_ctx: Any = None,
) -> AsyncIterator[StreamEventPayload]:
    """驱动候选 Agent，把官方 v2 原始分片映射为 ``StreamEventPayload``。

    参数：

    - ``agent``：``build_langchain_agent`` 的返回值（``CompiledStateGraph``）；
    - ``messages``：图输入消息，原样透传（不追加、不修改）；
    - ``config``：见 :class:`SseStreamConfig`（**必填**，但允许 ``None`` = 全默认）；
    - ``client_context``：推诺给 :class:`ProposalStreamInterceptor` 的客户端快照
      （非空时覆盖 ``config.client_context``）；
    - ``task_phase_ctx``：阶段门禁上下文（非空时覆盖 ``config.task_phase_context``）；
      第 6 项留白期间不参与判定，只随 :class:`RoundTailState` 传下去。

    首帧恒为 ``preparing{stage="streaming"}``（对齐 ``assist_service.py:36``）。

    **早停（``early_stop_on_client_tools``）刻意不显式传**：阶段 3 把它做成
    「``None`` ⇒ Agent 上存在 ``after_model`` hook 即自动禁用」
    （``runtime.py:275-288``，S3 实施期新增），而业务路径挂的正是
    ``BusinessRoundMiddleware``——自动判定给出的就是业务路径需要的语义
    （纯客户端轮才早停，混合轮不再被掐断）。适配器硬编码任一取值都会与
    阶段 3 的收窄语义打架，故交给下层判定。

    **``pending_calls_out`` 已弃用（阶段 8 收尾 F3，2026-09-23）**：它是
    `runtime.py` 的按工具名**近似**，且本适配器**不读它**——权威的「本轮挂起集合」
    是阶段 3 写进 ``round_plan.deferred`` 的那一份，本文件经
    :func:`_resolve_round_plan` 直接取自 ``updates``，并由
    :func:`emit_tool_pending` 发出 ``tool_pending`` 帧。
    弃用理由（含「为什么不能接线」的时序论证）见
    :func:`app.agent.langchain_runtime.runtime.stream_agent_raw_events` 的文档。

    取消 / 中途放弃：本函数是 async generator，调用方 ``aclose()``（或所在任务被取消）
    时，``finally`` 会 ``aclose()`` 下层 :func:`stream_agent_raw_events`，
    后者在 ``finally`` 里 ``cancel()`` 并 ``await`` 包装 ``astream`` 的后台 task、
    再 ``aclose()`` 底层生成器——**因此被放弃的适配器不会留下仍在跑工具的框架流**
    （备忘 §7 的 inferred 项，本文件用测试钉住）。
    """
    cfg = _coerce_config(config)
    effective_client_context = (
        client_context if client_context is not None else cfg.client_context
    )
    effective_task_phase = (
        task_phase_ctx if task_phase_ctx is not None else cfg.task_phase_context
    )
    context = cfg.context or AgentContext(
        mode=cfg.mode,
        client_context=effective_client_context,
        task_phase_context=effective_task_phase,
    )

    yield StreamEventPayload(type="preparing", stage="streaming")

    state: _RoundAccumulator | None = None
    rounds = 0

    def begin_round() -> _RoundAccumulator:
        nonlocal rounds
        rounds += 1
        return _RoundAccumulator(
            index=rounds,
            client_context=effective_client_context,
            task_phase_ctx=effective_task_phase,
            interceptor=_new_interceptor(effective_client_context),
        )

    raw = _runtime.stream_agent_raw_events(
        agent,
        messages,
        context=context,
        stream_modes=cfg.resolved_stream_modes(),
        version=cfg.resolved_version(),
    )
    try:
        async for part in raw:
            kind = _part_kind(part)
            data = _part_data(part)

            if kind == "messages":
                message = _message_of(data)
                metadata = _metadata_of(data)
                node = metadata.get("langgraph_node")
                if _is_after_model_node(node):
                    # 中间件注入的合成消息（AIMessage / ToolMessage）只是**状态通道**：
                    # 旧路径既不发它的 text_delta，也不发它的 tool_result
                    # （实测见 experiments/probe_stage4b_node_attribution.py）。
                    continue
                if isinstance(message, ToolMessage):
                    if state is None:
                        state = begin_round()
                    state.parts.append(part)
                    continue
                if not isinstance(message, AIMessageChunk):
                    continue

                step = metadata.get("langgraph_step")
                if state is None or state.starts_new_round(step):
                    if state is not None:
                        async for tail_event in _round_tail(state.tail_state()):
                            yield tail_event
                    state = begin_round()
                state.note_chunk(step)
                state.parts.append(part)

                for event in _delta_events(message):
                    # 防御式丢弃空载荷帧（尾随空分片不应产出任何帧）
                    if event.content:
                        yield event
                for proposal_event in state.interceptor.on_chunk(message):
                    yield proposal_event
                continue

            if kind == "updates":
                if state is None:
                    state = begin_round()
                state.parts.append(part)
                state.note_updates(data if isinstance(data, Mapping) else {})
                continue

            if kind == "custom":
                custom_type = data.get("type") if isinstance(data, Mapping) else None
                if isinstance(custom_type, str) and custom_type in _CUSTOM_CONTROL_TYPES:
                    if state is None:
                        state = begin_round()
                    state.parts.append(part)
                    state.control_frames.append(dict(data))
                    continue
                event = _custom_event(data)
                if event is not None:
                    yield event
                continue

        if state is not None:
            async for tail_event in _round_tail(state.tail_state()):
                yield tail_event
    finally:
        # 取消 / 放弃时把框架流真正关掉（备忘 §7）：不得吞异常，也不得在此 yield。
        await raw.aclose()
