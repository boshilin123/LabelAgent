"""阶段 3：客户端工具跨请求续跑（方案 A —— 保持请求体 ``client_tool_results``，**无 checkpointer**）。

对应 ``docs/阶段3-跨请求续跑设计备忘.md`` §3-§5 与实施清单第 3-7、10 项。

## 模型

方案 A 的「会话」**只存在于请求体**：服务端不持久化任何跨请求状态。

- 请求 1：模型发起客户端（``ToolRunner.ASYNC``）调用 → ``BusinessRoundMiddleware``
  注入合成 ``ToolMessage`` 并按两段式终止回合（阶段 2）→ 后端对该调用**零执行**；
- 请求 2：客户端把执行结果放进 ``client_tool_results`` **重发**，
  本模块负责把结果补成模型可见的 ``ToolMessage``，让推理在同一段对话上继续。

## 本模块做的事（全部复用既有生产件，不重写消息拼装）

1. **消息补齐**：复用 :func:`app.agent.context_service.append_client_tool_results_to_messages`
   （旧路径同款）。已声明过的 ``tool_call_id`` 只补 ``ToolMessage``；
   从未声明的才补「合成 ``AIMessage`` + ``ToolMessage``」对。
2. **谎报防护**：``proposals_applied`` 由**本请求**的阶段上下文推导
   （``TaskPhase.VERIFY`` ⇔ 用户已 Keep All），与旧路径
   ``assist_service.py:90-92`` 逐字同源；改写发生在**模型看到之前**。
3. **``completed_tool_ids`` 播种**：把 ``client_tool_results`` 的 id 集写进
   :attr:`AgentContext.completed_tool_ids`（= 旧 ``assist_service.py:84-85`` 的
   ``completed_ids``），使 ``BusinessRoundMiddleware`` 的 ``already_completed``
   短路**跨请求**成立（模型复读上一轮已挂起的调用时不再执行、不再写盘）。
4. **关闭 messages 流早停**：业务路径显式传
   ``early_stop_on_client_tools=False``（阶段 1 早停会在混合同轮掐断 SYNC 工具，
   见 :func:`app.agent.langchain_runtime.runtime.stream_agent_raw_events`）。
   挂起 / 抑制完全由阶段 2 的 middleware 表达；``pending_calls_out``
   （**已弃用**，见 :func:`stream_resume_raw_events` 的文档）仍按
   ``client_tool_names``（默认取注册表真相源 ``CLIENT_TOOL_NAMES``）做**结构防线**记录。

## 幂等（清单第 10 项）

- **消息层**：第 2 次投递同一批 ``client_tool_results`` 时，
  这些 id 在输入 ``messages`` 里**已有** ``ToolMessage``
  → :func:`prepare_resume_messages` 直接跳过，**不追加**第二条
  （旧函数在这种情况下会补一对合成 ``AIMessage``+``ToolMessage``）。
- **执行层**：resume 请求内没有服务端副作用代码路径
  （ASYNC 标注写盘只由客户端执行；后端 SYNC / PROPOSAL 调用由阶段门禁与
  ``awrap_tool_call`` 统一拦截），因此重复投递不可能二次写盘；
  重复 id 另由 ``completed_tool_ids`` 的 ``already_completed`` 抑制兜底。

**必须活在请求外的状态：无。** 未引入 checkpointer / ``interrupt()`` /
``StateGraph``；唯一例外是旧路径既有的 ``app/api/v1/agent.py`` 取消事件注册表。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import ToolMessage

from app.agent.assist.task_phase import TaskPhase, TaskPhaseContext
from app.agent.context_service import append_client_tool_results_to_messages
from app.agent.langchain_runtime.middleware import build_business_middleware
from app.agent.langchain_runtime.runtime import (
    STREAM_MODES,
    STREAM_VERSION,
    AgentContext,
    AgentEvent,
    PendingToolCall,
    build_langchain_agent,
    stream_agent_raw_events,
)
from app.agent.tools.tool_registry_meta import CLIENT_TOOL_NAMES

__all__ = [
    "ResumeTurn",
    "answered_tool_call_ids",
    "build_resume_agent",
    "completed_tool_ids_from",
    "prepare_resume_messages",
    "prepare_resume_turn",
    "proposals_applied",
    "stream_resume_raw_events",
    "unanswered_client_tool_results",
    "with_completed_tool_ids",
]


# ── 阶段上下文 → 谎报防护开关 ──────────────────────────────────────────


def proposals_applied(phase_ctx: TaskPhaseContext | None) -> bool:
    """用户是否已 Keep All（本请求处于 ``VERIFY`` 阶段）。

    逐字复刻旧路径 ``assist_service.py:90-92``::

        proposals_applied=bool(task_phase_ctx and task_phase_ctx.phase == TaskPhase.VERIFY)

    只有 ``VERIFY`` 才改写 ``proposal_pending`` / ``file_written``；
    ``AWAIT_CONFIRM``（提案仍未确认）必须保留 pending 口径，禁止模型宣称已写盘。
    """
    return phase_ctx is not None and getattr(phase_ctx, "phase", None) is TaskPhase.VERIFY


# ── 消息补齐 ───────────────────────────────────────────────────────────


def answered_tool_call_ids(messages: Sequence[Any]) -> frozenset[str]:
    """输入消息里**已经有结果**的 ``tool_call_id``（用于重复投递幂等）。"""
    return frozenset(
        str(message.tool_call_id)
        for message in messages
        if isinstance(message, ToolMessage) and str(message.tool_call_id or "").strip()
    )


def unanswered_client_tool_results(
    messages: Sequence[Any],
    client_tool_results: Sequence[Any] | None,
) -> list[Any]:
    """过滤掉「输入消息里已有 ``ToolMessage``」的重复投递。

    这是 :func:`prepare_resume_messages` 的幂等前提：
    :func:`append_client_tool_results_to_messages` 对「已答」id 会走
    「补合成 ``AIMessage`` + ``ToolMessage``」分支（它只区分「已声明未答」与
    「未声明」），因此重复投递会多出一对消息。此处先按输入消息过滤，
    使重复投递成为**空操作**。
    """
    if not client_tool_results:
        return []
    answered = answered_tool_call_ids(messages)
    return [
        ctr
        for ctr in client_tool_results
        if str(getattr(ctr, "tool_call_id", "") or "") not in answered
    ]


def prepare_resume_messages(
    lc_messages: Sequence[Any],
    client_tool_results: Sequence[Any] | None = None,
    *,
    user_content: str = "",
    phase_ctx: TaskPhaseContext | None = None,
) -> list:
    """补齐 resume 的客户端工具结果，返回**新的** messages 列表（不改入参）。

    - 复用 :func:`append_client_tool_results_to_messages`（不重写消息拼装）；
    - ``proposals_applied`` 由 ``phase_ctx`` 推导（谎报防护在模型看到之前生效）；
    - 重复投递（id 已有 ``ToolMessage``）被跳过 → 幂等；
    - **从未回来的 id 不会凭空生成 ``ToolMessage``**：本函数只处理
      ``client_tool_results`` 里的 id，其余挂起调用保持无结果（与旧路径同态）。
    """
    messages = list(lc_messages)
    fresh = unanswered_client_tool_results(messages, client_tool_results)
    if not fresh:
        return messages
    return append_client_tool_results_to_messages(
        messages,
        list(fresh),
        user_content=user_content,
        proposals_applied=proposals_applied(phase_ctx),
    )


# ── 跨请求 ``completed_tool_ids`` 播种 ─────────────────────────────────


def completed_tool_ids_from(
    client_tool_results: Sequence[Any] | None,
) -> frozenset[str]:
    """``client_tool_results`` 的 id 集（= 旧 ``assist_service.py:84`` 的 ``completed_ids``）。"""
    return frozenset(
        str(ctr.tool_call_id)
        for ctr in (client_tool_results or ())
        if str(getattr(ctr, "tool_call_id", "") or "").strip()
    )


def with_completed_tool_ids(
    context: AgentContext,
    tool_call_ids: Iterable[str],
) -> AgentContext:
    """把已回传的 ``tool_call_id`` 播种进 :class:`AgentContext`（返回副本）。

    幂等：重复播种同一批 id 得到相同结果；``context`` 本身不被修改。
    """
    ids = frozenset(str(item) for item in tool_call_ids if str(item or "").strip())
    if not ids:
        return context
    merged = frozenset(context.completed_tool_ids) | ids
    if merged == context.completed_tool_ids:
        return context
    return context.model_copy(update={"completed_tool_ids": merged})


# ── 一次 resume 请求的完整输入 ─────────────────────────────────────────


@dataclass(frozen=True)
class ResumeTurn:
    """一次 resume 请求交给候选 Agent 的 ``(messages, context)``。

    ``completed_tool_ids`` 单独留一份只读副本，便于日志 / 阶段 4 的观测，
    它同时已经在 ``context.completed_tool_ids`` 里（middleware 的实际读取点）。
    """

    messages: list
    context: AgentContext
    completed_tool_ids: frozenset[str] = frozenset()


def prepare_resume_turn(
    lc_messages: Sequence[Any],
    client_tool_results: Sequence[Any] | None = None,
    *,
    context: AgentContext | None = None,
    phase_ctx: TaskPhaseContext | None = None,
    user_content: str = "",
    context_updates: Mapping[str, Any] | None = None,
) -> ResumeTurn:
    """组装 resume 请求的图输入（消息 + 上下文）。

    参数：

    - ``lc_messages``：本请求由 API 层拼出的消息（``agent.py:280-285`` 的
      ``_build_lc_messages_from_local`` 输出形态），**不被修改**；
    - ``client_tool_results``：请求体的 ``list[ClientToolResult]``；
    - ``context``：已构造的 :class:`AgentContext`；缺省新建。
      客户端工具名集合默认取注册表真相源
      :data:`app.agent.tools.tool_registry_meta.CLIENT_TOOL_NAMES`
      （``auto_annotate`` / ``mutate_annotation`` / ``start_terminal_command``）——
      它只是 ``pending_calls_out`` 的**结构防线**，**不是**终止判据
      （:func:`stream_resume_raw_events` 显式关闭早停）；
    - ``phase_ctx``：本请求推导出的阶段上下文（``agent.py:241-245`` 推导一次），
      同时用于谎报防护与执行层门禁；
    - ``context_updates``：附加的上下文覆盖（``mode`` / ``client_context`` /
      ``workspace_root`` / ``client_tool_names`` 等），经 ``model_copy`` 落到副本上。
    """
    base = context if context is not None else AgentContext()
    updates: dict[str, Any] = dict(context_updates or {})
    if phase_ctx is not None and base.task_phase_context is None:
        updates["task_phase_context"] = phase_ctx
    if not base.client_tool_names and "client_tool_names" not in updates:
        updates["client_tool_names"] = frozenset(CLIENT_TOOL_NAMES)
    if updates:
        base = base.model_copy(update=updates)

    messages = prepare_resume_messages(
        lc_messages,
        client_tool_results,
        user_content=user_content,
        phase_ctx=phase_ctx if phase_ctx is not None else base.task_phase_context,
    )
    completed = completed_tool_ids_from(client_tool_results)
    return ResumeTurn(
        messages=messages,
        context=with_completed_tool_ids(base, completed),
        completed_tool_ids=completed,
    )


# ── 候选 Agent 组装（顺序与阶段 2 一致）────────────────────────────────


def build_resume_agent(
    model: Any,
    tools: Sequence[Any],
    *,
    max_tool_rounds: int = 5,
    sys_prompt: str | None = None,
    name: str | None = "lr_agent_candidate",
    extra_middleware: Sequence[Any] = (),
) -> Any:
    """构建带业务 middleware 的候选 Agent（跨请求续跑用）。

    ``BusinessRoundMiddleware`` 必须在首位（阶段 2 实测：``after_model`` 逆序执行，
    ``jump_to`` 会被后执行的 ``ModelCallLimitMiddleware.after_model`` 静默抹掉），
    本函数直接复用 :func:`build_business_middleware` 的既定顺序，不重排。

    阶段门禁 / ``completed_tool_ids`` **不在此处传**：它们来自
    :attr:`AgentContext.task_phase_context` / ``completed_tool_ids``
    （请求级数据，middleware 实例跨并发 run 共享，不得保存 per-run 状态）。
    """
    middleware = build_business_middleware(
        max_tool_rounds=max_tool_rounds,
        extra=list(extra_middleware),
    )
    return build_langchain_agent(
        model,
        tools,
        system_prompt=sys_prompt,
        name=name,
        middleware=middleware,
    )


# ── 流入口 ─────────────────────────────────────────────────────────────


async def stream_resume_raw_events(
    agent: Any,
    turn: ResumeTurn,
    *,
    stream_modes: Iterable[str] = STREAM_MODES,
    version: str = STREAM_VERSION,
    pending_calls_out: list[PendingToolCall] | None = None,
) -> AsyncIterator[AgentEvent]:
    """驱动 resume 回合，产出官方原始事件（阶段 4 适配器的输入）。

    与 :func:`app.agent.langchain_runtime.runtime.stream_agent_raw_events` 的唯一
    语义差异：**显式关闭 messages 流早停**（``early_stop_on_client_tools=False``），
    因为业务路径的挂起 / 抑制由阶段 2 的 middleware 表达；早停若在此生效，
    混合同轮的 SYNC 工具会被静默跳过，且 ``after_model`` 的回合计划不会被计算
    （阶段 4 看不到计划帧）。

    ``pending_calls_out`` 仍是**按工具名的近似**（**已弃用**，阶段 8 收尾 F3）；
    权威的「本轮挂起集合」请读 ``round_plan.deferred``（见阶段 4 备忘，
    以及 :func:`app.agent.langchain_runtime.runtime.stream_agent_raw_events`
    的弃用声明 —— 该参数无生产消费者，且在 ``finally`` 里流结束后才回填，
    无法供**流中**发出的 ``tool_pending`` 帧使用）。
    """
    async for event in stream_agent_raw_events(
        agent,
        turn.messages,
        context=turn.context,
        stream_modes=stream_modes,
        version=version,
        pending_calls_out=pending_calls_out,
        early_stop_on_client_tools=False,
    ):
        yield event
