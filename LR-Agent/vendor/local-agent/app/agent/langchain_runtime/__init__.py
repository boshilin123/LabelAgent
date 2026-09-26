"""阶段 1+2 候选内核：官方 ``create_agent`` 封装（后端专用）。

**尚未接入生产路由**：本包不被 ``app/api/v1/agent.py`` 或 ``stream_assist`` 引用，
只由 ``tests/test_langchain_runtime_stage1.py`` / ``..._stage2.py`` 驱动。

公开面：

- :func:`build_langchain_agent` —— 用注入的模型实例 + 现有工具清单构建官方 Agent
  （阶段 2 起接受 ``middleware=``）。
- :func:`stream_agent_raw_events` —— 异步流入口，产出官方 v2 原始事件。
- :class:`AgentContext` —— 单次调用内的静态运行上下文（``context_schema``）。
- :class:`PendingToolCall` —— 客户端工具待执行调用（阶段 4 的 ``tool_pending`` 素材）。
- :func:`assistant_text` —— 从最终状态取最后一条 AI 文本（便利函数）。

阶段 2 新增（业务 middleware）：

- :func:`app.agent.langchain_runtime.round_plan.plan_round` —— 纯函数「本轮计划」层，
  严格复刻旧 ``ToolLoopRunner.execute_round`` 的决策顺序。
- :class:`app.agent.langchain_runtime.middleware.BusinessRoundMiddleware` ——
  ``after_model`` 注入 ``coalesced`` / ``duplicate_call`` / ``phase_blocked``
  ``ToolMessage``（按 ``tool_call_id`` 把调用从 ``pending_tool_calls`` 剔除，
  ``langchain/agents/factory.py:1953-1957``）+ ``awrap_tool_call`` 兜底门禁。
- :class:`app.agent.langchain_runtime.middleware.BudgetWrapUpMiddleware` ——
  预算收尾（``before_model`` 收尾 ``HumanMessage`` + ``wrap_model_call`` 无工具调用）。
- :func:`app.agent.langchain_runtime.middleware.build_business_middleware` ——
  按规格顺序组装 ``middleware=[...]``（含官方 ``ModelCallLimitMiddleware`` /
  ``ToolErrorMiddleware`` / ``ToolRetryMiddleware``）。

命名说明：阶段 4 的 SSE 适配器**已公开** ``stream_agent_events``
（``app/agent/langchain_runtime/sse_adapter.py``，产出 ``StreamEventPayload``，
见 ``docs/阶段4-SSE适配设计备忘.md``）；本模块的原始流入口因此命名为
``stream_agent_raw_events``，供其复用。

阶段 3 新增（客户端工具跨请求续跑）：

- :func:`app.agent.langchain_runtime.resume.prepare_resume_turn` —— 组装 resume 请求的
  图输入（复用 ``context_service.append_client_tool_results_to_messages`` 补消息、
  套用谎报防护改写、把 ``completed_tool_ids`` 播种进 :class:`AgentContext`）。
- :func:`app.agent.langchain_runtime.resume.build_resume_agent` —— 按阶段 2 的顺序
  组装带业务 middleware 的候选 Agent。
- :func:`app.agent.langchain_runtime.resume.stream_resume_raw_events` —— resume 流入口，
  **显式关闭 messages 流早停**（早停已收窄为纯客户端轮，业务路径不再依赖它）。
- :attr:`AgentContext.completed_tool_ids` —— 跨请求的 ``already_completed`` 去重输入。
"""

from app.agent.langchain_runtime.middleware import (
    BUDGET_WRAP_UP_TEXT,
    RETRYABLE_TOOL_NAMES,
    SYNC_TOOL_NAMES,
    BudgetWrapUpMiddleware,
    BusinessRoundMiddleware,
    BusinessRoundState,
    build_business_middleware,
)
from app.agent.langchain_runtime.resume import (
    ResumeTurn,
    answered_tool_call_ids,
    build_resume_agent,
    completed_tool_ids_from,
    prepare_resume_messages,
    prepare_resume_turn,
    proposals_applied,
    stream_resume_raw_events,
    unanswered_client_tool_results,
    with_completed_tool_ids,
)
from app.agent.langchain_runtime.round_plan import (
    ALREADY_COMPLETED_SUMMARY,
    COALESCED_TEMPLATE,
    DUPLICATE_SUMMARY,
    WORKSPACE_WRITE_BLOCKED_SUMMARY,
    RoundPlan,
    RoundToolCall,
    plan_round,
)
from app.agent.langchain_runtime.runtime import (
    STREAM_MODES,
    STREAM_VERSION,
    AgentContext,
    AgentEvent,
    PendingToolCall,
    assistant_text,
    build_langchain_agent,
    stream_agent_raw_events,
)
from app.agent.langchain_runtime.sse_adapter import (
    FrameworkErrorPolicy,
    RoundTailState,
    SseStreamConfig,
    stream_agent_events,
)
from app.agent.langchain_runtime.subagent import (
    EXPLORE_READONLY_DESCRIPTION,
    SUBAGENT_EVENT_TYPES,
    SubagentEventCollector,
    build_explore_readonly_agent_tool,
    subagent_event_payload,
)
from app.agent.langchain_runtime.vision import (
    VISION_FALLBACK_ID_PREFIX,
    VISION_FALLBACK_IMAGE_TEXT,
    VisionFallbackMiddleware,
    VisionFallbackState,
    VisionToolResultMiddleware,
    vision_event_payload,
)

__all__ = [
    "ALREADY_COMPLETED_SUMMARY",
    "AgentContext",
    "AgentEvent",
    "BUDGET_WRAP_UP_TEXT",
    "BudgetWrapUpMiddleware",
    "BusinessRoundMiddleware",
    "BusinessRoundState",
    "COALESCED_TEMPLATE",
    "DUPLICATE_SUMMARY",
    "EXPLORE_READONLY_DESCRIPTION",
    "FrameworkErrorPolicy",
    "PendingToolCall",
    "RETRYABLE_TOOL_NAMES",
    "ResumeTurn",
    "RoundPlan",
    "RoundTailState",
    "RoundToolCall",
    "STREAM_MODES",
    "STREAM_VERSION",
    "SUBAGENT_EVENT_TYPES",
    "SYNC_TOOL_NAMES",
    "SseStreamConfig",
    "SubagentEventCollector",
    "VISION_FALLBACK_ID_PREFIX",
    "VISION_FALLBACK_IMAGE_TEXT",
    "VisionFallbackMiddleware",
    "VisionFallbackState",
    "VisionToolResultMiddleware",
    "WORKSPACE_WRITE_BLOCKED_SUMMARY",
    "answered_tool_call_ids",
    "assistant_text",
    "build_business_middleware",
    "build_explore_readonly_agent_tool",
    "build_langchain_agent",
    "build_resume_agent",
    "completed_tool_ids_from",
    "plan_round",
    "prepare_resume_messages",
    "prepare_resume_turn",
    "proposals_applied",
    "stream_agent_events",
    "stream_agent_raw_events",
    "stream_resume_raw_events",
    "subagent_event_payload",
    "unanswered_client_tool_results",
    "vision_event_payload",
    "with_completed_tool_ids",
]
