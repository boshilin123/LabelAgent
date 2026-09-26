"""阶段 2 业务 middleware：合批去重 / 阶段门禁 / 预算收尾。

对应 ``docs/阶段2-业务middleware设计备忘.md`` §1-§5 与实施清单第 2-7 项。

三个自定义件（官方件不重写）：

- :class:`BusinessRoundMiddleware`
  ``after_model`` 注入 ``coalesced`` / ``duplicate_call`` / ``phase_blocked``
  ``ToolMessage``（顺序 = 旧 ``execute_round`` 的产出顺序）+ 路由；
  ``awrap_tool_call`` 做兜底门禁 + 合并参数改写（defence-in-depth）。
- :class:`BudgetWrapUpMiddleware`
  ``before_model`` 自增计数并加收尾 ``HumanMessage`` →
  ``wrap_model_call`` ``override(tools=[], tool_choice=None)`` + 清空 ``tool_calls``。
- :func:`build_business_middleware`
  返回按规格 §1 排序的 ``middleware=[...]`` 列表。

**机制（``experiments/probe_stage2_after_model_injection.py`` 实测确认）**：
``after_model`` 返回 ``{"messages": [ToolMessage(tool_call_id=X)]}`` 后，
``langchain/agents/factory.py:1953-1957`` 的 ``pending_tool_calls`` 过滤会把
``X`` 剔除（``_fetch_last_ai_and_tool_messages`` 把「最后一条 AI 消息**之后**的
所有 ToolMessage」都算作 ``tool_message_ids``），因此该调用**永不进入 ``tools`` 节点**。

**实测确认的三条关键边界**（``experiments/probe_stage2_middleware_e2e.py`` /
``probe_stage2_jump.py``，不要在这些点上做假设）：

1. **``after_model`` 返回含 ``messages`` 的 dict ⇒ 无条件进入 ``tools`` 节点。**
   抑制只对「确实不该执行」的调用有效；若同一轮还有合法 SYNC 调用，
   它们会照常执行（符合基线）。但若本轮**没有任何**调用该执行，
   就必须让 ``after_model`` 额外返回 ``{"jump_to": "model"}`` 走
   ``factory.py:1933-1938`` 的 ``_resolve_jump`` → ``loop_entry_node``
   （``factory.py:1704-1705`` 在 ``loop_exit_node != "model"`` 时把
   ``loop_entry_node`` 加进候选目的地）。否则被抑制的调用会被送进
   ``tools`` 节点执行——**这正是第一次实现里 ASYNC 工具仍被执行的原因**。
2. **``after_model`` 里 ``jump_to="end"`` 会静默跳过 ``tools`` 节点**，
   连合法 SYNC 调用一起跳过。回合终止必须两段式：
   本轮 ``after_model`` 只决定「去 model」或「去 tools」，
   下一轮 ``before_model`` 再 ``jump_to="end"``（``factory.py:1775-1784``）。
3. 被抑制的 ``tool_call_id`` **不会**进入 ``awrap_tool_call``（未被调度），
   故兜底门禁只覆盖「已进入 ``tools`` 节点」的调用；门禁唯一入口是 ``after_model``。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

from langchain.agents.middleware import (
    AgentMiddleware,
    AgentState,
    ModelCallLimitMiddleware,
    ToolErrorMiddleware,
    ToolRetryMiddleware,
    hook_config,
)
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage
from typing_extensions import NotRequired

from app.agent.assist.task_phase import (
    ANNOTATION_WRITE_TOOLS,
    WORKSPACE_WRITE_TOOLS,
    TaskPhaseContext,
    check_call_allowed,
)
from app.agent.langchain_runtime.round_plan import RoundPlan, plan_round
from app.agent.tools.tool_registry_meta import TOOL_RUNNERS, ToolRunner, get_tool_runner
from app.agent.tools.tool_result import build_tool_result

__all__ = [
    "BUDGET_WRAP_UP_TEXT",
    "BusinessRoundMiddleware",
    "BusinessRoundState",
    "BudgetWrapUpMiddleware",
    "RETRYABLE_TOOL_NAMES",
    "SYNC_TOOL_NAMES",
    "build_business_middleware",
]


BUDGET_WRAP_UP_TEXT = (
    "工具调用预算已用完。请基于以上进展直接给出最终回答，不要再调用工具。"
)
"""逐字复刻 ``app/agent/assist_service.py:175-182``。"""


# ── 工具分类（复用注册元数据，不新增抽象）───────────────────────────────

SYNC_TOOL_NAMES: tuple[str, ...] = tuple(
    name for name, runner in TOOL_RUNNERS.items() if runner is not ToolRunner.ASYNC
)
"""交回后端的工具名（SYNC + PROPOSAL）。

``ToolRetryMiddleware`` / ``ToolErrorMiddleware`` 都只对这批工具生效——
异步工具永不进入 ``tools`` 节点，给它们配重试没有意义。
"""

RETRYABLE_TOOL_NAMES: tuple[str, ...] = ()
"""**不重试任何工具**（阶段 8 故障注入裁决后改为空集，2026-09-23）。

原实现把「只读工具」列为可重试（``ToolRetryMiddleware(max_retries=2)``），
但阶段 8 故障注入实测出两处不可接受的后果（见 ``docs/阶段8-对照度量.md`` D2）：

1. **与旧路径不等价且不可见**：只读工具抛 ``ConnectionError``/``TimeoutError`` 时
   候选执行 **3 次**、旧路径 **1 次**，而**帧序列两侧逐字节相同**、
   ``langchain/agents/middleware/tool_retry.py`` 全文件**无任何日志**——
   等于不可监控的 3× 调用放大与 +1–3 s 退避。
2. **会重跑整个子代理**：该集合原本包含 ``explore_readonly``，重试它会重新执行
   内层 ``ExploreReadonlyRunner`` 并把 ``subagent_*`` 自定义帧重复送出。

计划 §5-阶段 2 的措辞是「**可以**对明确允许重试的只读工具使用 ToolRetryMiddleware」
（可选），而其强制部分（「标注写入默认不自动重试」）由「完全不重试」同样满足。
故此处取严格等价：``tools=()`` 使 ``ToolRetryMiddleware`` 对任何工具都不生效。
"""


# ── state 通道 ─────────────────────────────────────────────────────────


class BusinessRoundState(AgentState):
    """业务 middleware 的 state 扩展。

    这些字段会与 ``AgentState`` 合并成图状态 schema（``factory.py:1180-1182`` 的
    ``_resolve_schemas``），因此 ``awrap_tool_call`` 能通过 ``request.state`` 读到
    （``ToolCallRequest.state`` 在执行时从 channels 水合）。
    """

    round_plan: NotRequired[Any]
    """本轮计划（:class:`~app.agent.langchain_runtime.round_plan.RoundPlan`）。"""

    round_plan_message_id: NotRequired[str]
    """已计算过计划的 AI 消息 id——防止同一轮被重复计算/重复注入。"""

    round_executed: NotRequired[bool]
    """本轮已有合法调用进过 ``tools`` 节点（用于两段式终止的第二段判定）。"""

    end_after_round: NotRequired[bool]
    """本轮结束后应终止回合（下一轮 ``before_model`` 读它并 ``jump_to="end"``）。"""

    wrap_up_calls: NotRequired[int]
    """已发起的模型调用序号（1-based）；预算收尾的计数通道。"""

    wrap_up_active: NotRequired[bool]
    """是否已进入收尾模式（无工具调用的最终回答轮）。"""


# ── 自定义中间件 1：本轮计划 + 路由 + 兜底门禁 ───────────────────────────


class BusinessRoundMiddleware(AgentMiddleware):
    """复刻旧 ``execute_round`` 的「工具执行前」决策（合批 / 去重 / 门禁）。

    并发安全：本实例**不保存**任何本轮状态（middleware 实例跨并发 run 共享），
    计划只走 ``state`` 通道。
    """

    state_schema = BusinessRoundState

    def __init__(
        self,
        *,
        phase_ctx: TaskPhaseContext | None = None,
        completed_tool_ids: frozenset[str] = frozenset(),
        phase_ctx_getter: Callable[[Any], TaskPhaseContext | None] | None = None,
        end_turn_on_deferred: bool = True,
    ) -> None:
        super().__init__()
        self._phase_ctx = phase_ctx
        self._completed = frozenset(completed_tool_ids)
        self._phase_ctx_getter = phase_ctx_getter
        self._end_turn_on_deferred = end_turn_on_deferred

    # ── 内部：从 runtime / state 取上下文 ────────────────────────────
    @staticmethod
    def _context_of(runtime: Any) -> Any:
        return getattr(runtime, "context", None)

    def _phase_ctx_for(self, runtime: Any) -> TaskPhaseContext | None:
        if self._phase_ctx_getter is not None:
            return self._phase_ctx_getter(self._context_of(runtime))
        ctx = self._context_of(runtime)
        found = getattr(ctx, "task_phase_context", None)
        if found is not None:
            return found
        return self._phase_ctx

    def _completed_for(self, runtime: Any) -> frozenset[str]:
        """已回传结果的 ``tool_call_id`` 集合（跨请求去重，阶段 3 播种）。

        取值顺序（均为**请求级**数据，middleware 实例不保存任何 per-run 状态）：

        1. ``runtime.context.completed_tool_ids``（阶段 3 新增的一等字段，
           由 ``app.agent.langchain_runtime.resume`` 播种）；
        2. ``runtime.context.extra["completed_tool_ids"]``（阶段 2 的兼容通道）；
        3. 构造时传入的 ``completed_tool_ids``（同 run 用 / 测试用）。

        复刻旧路径 ``assist_service.py:84-85`` 的 ``loop.mark_completed(completed_ids)``：
        模型若复读上一轮已挂起的调用，按 ``already_completed`` 抑制，不二次执行。
        """
        ctx = self._context_of(runtime)
        if ctx is not None:
            direct = getattr(ctx, "completed_tool_ids", None)
            if direct:
                return frozenset(str(item) for item in direct)
            extra = getattr(ctx, "extra", None)
            if isinstance(extra, dict):
                seeded = extra.get("completed_tool_ids")
                if seeded is not None:
                    return frozenset(str(item) for item in seeded)
        return self._completed

    def _plan_for(self, state: Any, runtime: Any) -> RoundPlan:
        messages = state["messages"] if isinstance(state, dict) else state.messages
        last = messages[-1] if messages else None
        return plan_round(
            last,
            phase_ctx=self._phase_ctx_for(runtime),
            completed_tool_ids=self._completed_for(runtime),
        )

    @staticmethod
    def _should_end_turn(plan: RoundPlan) -> bool:
        """本轮结束后是否终止回合（阶段 2 需要它才能保证「零后端执行」可观测）。

        旧路径在 ``emit_tool_pending`` 后 ``return``（``tool_loop.py:716-720`` +
        ``assist_service.py:148-150``），因此：

        - 有挂起给客户端的调用（``deferred``）→ 终止；
        - 有被合并 / 被去重的调用（``coalesced`` / ``duplicate_call``）→
          旧路径同样以 ``tool_pending`` 结束该轮 → 终止；
        - 纯 ``phase_blocked`` 抑制 → 旧路径**继续**调模型让它读到门禁反馈
          （``tool_loop.py:537-539`` + ``assist_service.py:153``）→ **不**终止。
        """
        if plan.deferred:
            return True
        return any(
            reason in ("coalesced", "duplicate_call")
            for reason in plan.suppression_reasons
        )

    # ── hook：after_model（注入抑制用 ToolMessage + 路由）─────────────
    @hook_config(can_jump_to=["end"])
    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """计算本轮计划，注入被抑制调用的 ``ToolMessage``，并决定路由。

        **``@hook_config(can_jump_to=[...])`` 是硬要求（实测）**：
        ``factory.py:2067-2091`` 只在 ``can_jump_to`` 非空时才把该 hook 的边建成
        **条件边**，否则退化成 ``graph.add_edge(name, default_destination)``，
        返回的 ``jump_to`` 被**静默忽略**。

        - ``plan.execute_now`` **为空**（纯挂起 / 纯合并去重轮）：
          ``jump_to="end"``。此时没有任何调用需要执行——必须显式改道，
          否则 ``after_model`` 返回的 ``messages`` 会让图把这些
          「不该执行」的调用 ``Send`` 给 ``tools`` 节点
          （``factory.py:1953-1964``；``experiments/probe_stage2_min.py`` 实测）。
        - ``plan.execute_now`` **非空**（同一轮还有合法 SYNC 调用）：
          **不**能在此处 ``jump_to="end"``，否则合法 SYNC 调用被静默跳过
          （``factory.py:1933-1938`` 的 jump 优先于 pending_tool_calls 判定）；
          让路由照常去 ``tools``，等它执行完回到 ``before_model`` 时收尾
          ——这就是「两段式」的落点。
        - 纯 ``phase_blocked`` 轮（``end_after_round`` 为假）：旧路径**继续**调模型
          让它读到门禁反馈（``tool_loop.py:537-539`` + ``assist_service.py:153``），
          因此不加任何 jump，让图自然回到模型节点。
        """
        messages = state["messages"] if isinstance(state, dict) else state.messages
        last = messages[-1] if messages else None
        message_id = str(getattr(last, "id", "") or "")
        seen = state.get("round_plan_message_id") if isinstance(state, dict) else None
        already_planned = bool(message_id) and seen == message_id
        executed = bool(isinstance(state, dict) and state.get("round_executed"))

        if already_planned:
            if executed:
                # 第二段：本轮合法调用已进过 ``tools`` 节点，现在终止回合。
                return {"round_executed": False, "jump_to": "end"}
            # 未执行过任何工具：纯 ``phase_blocked`` 轮 —— 旧路径**继续**调模型
            # 让它读到门禁反馈（``tool_loop.py:537-539`` + ``assist_service.py:153``），
            # 因此不加 jump，让图自然回到模型节点。
            return None

        plan = self._plan_for(state, runtime)
        if not plan.has_any_call:
            return None

        update: dict[str, Any] = {"round_plan": plan}
        if message_id:
            update["round_plan_message_id"] = message_id
        injected = plan.injected_messages
        if injected:
            update["messages"] = injected

        end_after = self._end_turn_on_deferred and self._should_end_turn(plan)
        update["round_executed"] = bool(plan.execute_now)

        if end_after and not plan.execute_now:
            # 本轮没有任何调用该进 ``tools`` 节点（纯挂起 / 纯合并去重轮）：
            # 必须显式 ``jump_to="end"``，否则 ``after_model`` 返回的 ``messages``
            # 会让图把「不该执行」的调用 ``Send`` 给 ``tools`` 节点
            # （``factory.py:1953-1964``；``experiments/probe_stage2_min.py`` 实测）。
            update["end_after_round"] = False
            update["jump_to"] = "end"
            return update

        # 本轮有合法调用要进 ``tools`` 节点（``plan.execute_now`` 非空）或不需要
        # 终止（纯 phase_blocked）。两种情况都**不**在这里 jump：
        # 前者若 jump 会静默跳过合法调用（``factory.py:1933-1938`` 的 jump 优先于
        # pending_tool_calls 判定）；后者的终止由 ``before_model`` 两段式的第一段负责。
        update["end_after_round"] = end_after
        return update

    # ── hook：before_model（两段式回合终止的第一段）────────────────────
    @hook_config(can_jump_to=["end"])
    def before_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """上一轮标记了「本轮结束即终止」且合法调用已执行完时，在此终止回合。

        ``after_model`` 不能自己 ``jump_to="end"`` 吗？——对「还有合法 SYNC 调用」
        的那一轮确实不能（会跳过 ``tools`` 节点），所以由 ``tools`` → ``model``
        回边进入本 hook 来完成终止。

        **``@hook_config`` 是必需的（实测）**：``factory.py:2067-2091`` 只在
        ``can_jump_to`` 非空时才把该 hook 的边建成**条件边**，否则退化成
        ``graph.add_edge(name, default_destination)``——此时返回的 ``jump_to``
        被**静默忽略**。缺少它的实测症状：``before_model`` 明确返回
        ``{"jump_to": "end"}``，模型节点却照常执行（混合轮多出一次模型调用）。
        """
        if not isinstance(state, dict):
            return None
        if state.get("end_after_round") and state.get("round_executed"):
            return {
                "round_executed": False,
                "end_after_round": False,
                "jump_to": "end",
            }
        return None

    # ── hook：awrap_tool_call（执行层唯一门禁 + 合并参数改写）──────────
    async def awrap_tool_call(self, request: Any, handler: Callable[..., Any]) -> Any:
        """执行层门禁（**后端零执行的最终保证**）。

        三道检查，按「必须先挡住」的顺序：

        1. **ASYNC 工具恒不执行**：``ToolRunner.ASYNC``（``auto_annotate`` /
           ``mutate_annotation`` / ``start_terminal_command``）由客户端执行，
           后端在任何合法路径下都不该跑它们。这一条是**无条件**的，
           不依赖 ``after_model`` 的注入或路由是否生效
           （``experiments/probe_stage2_edge_detail.py`` 实测：同一轮里
           含 ASYNC 调用时，框架仍可能把它 ``Send`` 给 ``tools`` 节点——
           路由只看 ``tool_call_id``，不看业务语义）。
           返回的 ``ToolMessage`` 沿用旧路径的 ``build_tool_result`` 结构。
        2. ``check_call_allowed`` 阶段门禁（``task_phase.py:177-233``），
           拒绝时逐字返回旧理由。
        3. 合并参数改写：把 ``after_model`` 算出的合并后参数写回
           （幂等；仅当 ``plan.merged_arguments`` 命中该 ``tool_call_id``）。
        """
        tool_call = dict(request.tool_call or {})
        name = str(tool_call.get("name") or "")
        tool_call_id = str(tool_call.get("id") or "")
        args = tool_call.get("args")
        args = dict(args) if isinstance(args, dict) else {}

        if get_tool_runner(name) is ToolRunner.ASYNC:
            return ToolMessage(
                content=build_tool_result(
                    ok=False,
                    tool=name,
                    status="client_tool_pending",
                    summary=(
                        f"{name} 由客户端执行，后端不执行；调用已挂起，"
                        "请等待客户端回传结果。"
                    ),
                ),
                tool_call_id=tool_call_id,
                name=name,
            )

        ctx = self._phase_ctx_for(getattr(request, "runtime", None))
        reason = check_call_allowed(name, args, ctx)
        if reason is not None:
            return ToolMessage(
                content=build_tool_result(
                    ok=False, tool=name, status="phase_blocked", summary=reason
                ),
                tool_call_id=tool_call_id,
                name=name,
            )

        state = request.state
        plan = state.get("round_plan") if isinstance(state, dict) else None
        if isinstance(plan, RoundPlan):
            merged = plan.merged_arguments.get(tool_call_id)
            if merged is not None and merged != args:
                tool_call["args"] = merged
                request = request.override(tool_call=tool_call)
        return await handler(request)

    def wrap_tool_call(self, request: Any, handler: Callable[..., Any]) -> Any:
        """同步入口（本项目只走 ``astream``；成对实现以免 sync 路径静默缺失门禁）。"""
        tool_call = dict(request.tool_call or {})
        name = str(tool_call.get("name") or "")
        tool_call_id = str(tool_call.get("id") or "")
        if get_tool_runner(name) is ToolRunner.ASYNC:
            return ToolMessage(
                content=build_tool_result(
                    ok=False,
                    tool=name,
                    status="client_tool_pending",
                    summary=(
                        f"{name} 由客户端执行，后端不执行；调用已挂起，"
                        "请等待客户端回传结果。"
                    ),
                ),
                tool_call_id=tool_call_id,
                name=name,
            )
        ctx = self._phase_ctx_for(getattr(request, "runtime", None))
        args = tool_call.get("args")
        args = dict(args) if isinstance(args, dict) else {}
        reason = check_call_allowed(name, args, ctx)
        if reason is not None:
            return ToolMessage(
                content=build_tool_result(
                    ok=False, tool=name, status="phase_blocked", summary=reason
                ),
                tool_call_id=tool_call_id,
                name=name,
            )
        return handler(request)


# ── 自定义中间件 2：预算收尾 ────────────────────────────────────────────


class BudgetWrapUpMiddleware(AgentMiddleware):
    """复刻 ``assist_service.py:170-188`` 的预算耗尽兜底。

    ``ModelCallLimitMiddleware`` 单独**不等价**：超限时它注入固定
    ``AIMessage("Model call limits exceeded: …")``（``model_call_limit.py:203-208``），
    而旧路径是追加 ``HumanMessage`` 后**无工具**再调一次模型。

    实现（规格 §4）：

    1. ``before_model`` 自增 ``wrap_up_calls``；
    2. 计数 == ``max_tool_rounds + 2`` 时追加收尾 ``HumanMessage`` 并进入收尾模式
       （**实测修正**：规格 §4 写的是 ``+1``，那会吃掉最后一次工具轮，
       见 :attr:`wrap_up_at`）；
    3. 收尾模式下 ``wrap_model_call`` 用 ``override(tools=[], tool_choice=None)``，
       使 ``factory.py:1432-1439`` 走 ``model.bind()`` 而不 ``bind_tools``
       （等价于 ``assist_service.py:183`` 的 ``llm.astream(messages)``）；
    4. 再把返回的 ``AIMessage.tool_calls`` 清空，使 ``model_to_tools`` 走
       ``factory.py:1950-1951`` 的 END 分支——复刻「兜底轮 tool_call 不执行」。
       实测：即使绑定清单为空，假模型仍可能吐出 ``tool_call_chunks``，
       故第 4 步是必需的，不能只靠第 3 步。
    """

    state_schema = BusinessRoundState

    def __init__(self, *, max_tool_rounds: int) -> None:
        super().__init__()
        if max_tool_rounds < 0:
            raise ValueError("max_tool_rounds 必须 >= 0")
        self._max_tool_rounds = max_tool_rounds

    @property
    def wrap_up_at(self) -> int:
        """进入收尾模式的模型调用序号（1-based）＝ ``max_tool_rounds + 2``。

        为什么是 ``+2`` 而不是规格 §4 写的 ``+1``（**实测修正**）：

        旧路径的工具轮是 ``for round_idx in range(max_tool_rounds + 1)``
        （``assist_service.py:98``）——``max_tool_rounds=1`` 时**两次**工具轮
        都会跑完并各执行一次工具，然后才进 ``else`` 分支做收尾
        （基线 ``TestBudgetExhausted`` 断言「执行 2 次、``astream`` 3 次」）。
        ``before_model`` 在**每一次**模型调用前都会跑（``factory.py:1767-1784``
        的链式边在 tools → model 回边之后同样经过），所以第 *k* 次模型调用对应的
        ``wrap_up_calls`` 就是 *k*。若按 ``+1`` 判定，收尾会在第
        ``max_tool_rounds + 1`` 次调用前插入，**吃掉最后一次工具轮**
        （实测：``max_tool_rounds=1`` 只执行 1 次工具、只有 2 次模型调用）。
        取 ``+2`` 后：第 1..max+1 次是工具轮，第 max+2 次才是无工具的收尾轮。
        """
        return self._max_tool_rounds + 2

    @staticmethod
    def _count(state: Any) -> int:
        if not isinstance(state, dict):
            return 0
        value = state.get("wrap_up_calls")
        return int(value) if isinstance(value, int) else 0

    # ── hook：before_model（计数 + 收尾提示）───────────────────────────
    def before_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        count = self._count(state) + 1
        update: dict[str, Any] = {"wrap_up_calls": count}
        if count == self.wrap_up_at:
            update["wrap_up_active"] = True
            update["messages"] = [HumanMessage(content=BUDGET_WRAP_UP_TEXT)]
        return update

    @staticmethod
    def _is_wrap_up(state: Any) -> bool:
        return bool(isinstance(state, dict) and state.get("wrap_up_active"))

    # ── hook：wrap_model_call / awrap_model_call（无工具收尾）──────────
    def wrap_model_call(self, request: ModelRequest, handler: Callable[..., Any]) -> Any:
        if not self._is_wrap_up(request.state):
            return handler(request)
        return _blank_tool_calls(handler(request.override(tools=[], tool_choice=None)))

    async def awrap_model_call(
        self, request: ModelRequest, handler: Callable[..., Any]
    ) -> Any:
        if not self._is_wrap_up(request.state):
            return await handler(request)
        response = await handler(request.override(tools=[], tool_choice=None))
        return _blank_tool_calls(response)


def _blank_tool_calls(response: Any) -> Any:
    """把 ``ModelResponse.result`` 里 AI 消息的 ``tool_calls`` 清空。

    ``tool_calls`` 与 ``tool_call_chunks`` 必须同时清空：
    ``AIMessage`` 会从 ``tool_call_chunks`` 反推 ``tool_calls``
    （``langchain_core/messages/ai.py``），只清其一会“复活”。
    """
    result = getattr(response, "result", None)
    if result is None:
        return response
    blanked: list[AnyMessage] = []
    changed = False
    for message in result:
        if isinstance(message, AIMessage) and (
            getattr(message, "tool_calls", None)
            or getattr(message, "tool_call_chunks", None)
        ):
            message = message.model_copy(
                update={"tool_calls": [], "tool_call_chunks": []}
            )
            changed = True
        blanked.append(message)
    if not changed:
        return response
    return ModelResponse(
        result=blanked,
        structured_response=getattr(response, "structured_response", None),
    )


# ── 官方件的文本映射 ────────────────────────────────────────────────────


def _old_error_text(exc: Exception, request: Any) -> str:
    """把工具异常映射为旧路径的 ``tool_result`` 文本。

    逐字复刻 ``tool_loop.py:100-104``（普通工具）。未注册工具由 ``ToolNode``
    上游处理（``tool_node.py:383-391`` 的 "not a valid tool"），不经此处。
    写类工具失败**不做摘要化**（``tool_loop.py:275-280`` 缺 ``else``）——
    该不对称属阶段 4 适配器职责，此处只负责文本。
    """
    tool_call = getattr(request, "tool_call", None) or {}
    name = str(tool_call.get("name") or "")
    # **必须逐字等于旧路径的手写 4 键载荷**（``tool_loop.py:101-104``）。
    # ``build_tool_result`` 恒产 6 键（多 ``file_written`` / ``proposal_pending``）：
    # 只读工具失败会被 ``format_tool_result_for_display`` 取成 ``summary``，看不出差异；
    # 但**写类工具失败不做摘要化**（``tool_loop.py:275-280`` 缺 ``else``），
    # 那两个多出的键会直接进入模型可见的 ``tool_result.result``。
    # 阶段 8 故障注入实测 D1，此处按严格等价修正。
    return json.dumps(
        {
            "ok": False,
            "tool": name,
            "status": "error",
            "summary": f"工具执行失败: {exc}",
        },
        ensure_ascii=False,
    )


async def _old_error_text_async(exc: Exception, request: Any) -> str:
    return _old_error_text(exc, request)


def _retry_on(exc: Exception) -> bool:
    """只重试可重试的**瞬时**异常（规格 §5）。

    框架默认 ``default_retry_on`` 会重试「所有未分类异常」
    （``tool_retry.py:159-161``，已逐字复核）——那会把基线的
    ``RuntimeError("磁盘炸了")`` 重试成 4 次，违反「恰好执行 1 次」。
    不匹配的异常**立即 re-raise** 且不走 ``on_failure``（``tool_retry.py:334-336``），
    因此错误照常交给外层 ``ToolErrorMiddleware``。
    """
    return isinstance(exc, (ConnectionError, TimeoutError))


# ── 工厂 ───────────────────────────────────────────────────────────────


def build_business_middleware(
    *,
    max_tool_rounds: int,
    phase_ctx: TaskPhaseContext | None = None,
    completed_tool_ids: frozenset[str] = frozenset(),
    phase_ctx_getter: Callable[[Any], TaskPhaseContext | None] | None = None,
    end_turn_on_deferred: bool = True,
    extra: Sequence[AgentMiddleware] = (),
) -> list[AgentMiddleware]:
    """返回 ``middleware=[...]``（顺序见下，**已按实测修正**）。

    **顺序**（``experiments/probe_stage2_order_fix.py`` 实测确定）::

        [BusinessRoundMiddleware, ModelCallLimitMiddleware,
         ToolErrorMiddleware, ToolRetryMiddleware, BudgetWrapUpMiddleware]

    为什么 ``BusinessRoundMiddleware`` 必须在**首位**（而不是规格 §1 的第 4 位）：

    - ``after_model`` 的执行序是**逆序**（``factory.py:1789-1800``），
      ``loop_exit_node`` = 列表里**第一个**带 ``after_model`` 的中间件
      （``factory.py:1664-1665``）。方括号里的 return dict 是**整体替换**式更新，
      后执行的 ``after_model`` 会覆盖先执行的 ``jump_to``。
    - ``ModelCallLimitMiddleware.after_model`` 返回
      ``{"thread_model_call_count": …, "run_model_call_count": …}``
      （``model_call_limit.py:236-251``）——**不含** ``jump_to``。
      若它排在 ``BusinessRoundMiddleware`` 之后执行，我方设的 ``jump_to``
      会被这一个 dict 静默抹掉，路由于是回到 ``tools`` 节点，
      **被抑制的 ASYNC 调用照常在后端执行**（实测：I 组 ``EXEC`` 非空）。
    - 放在首位后，``BusinessRoundMiddleware.after_model`` 成为
      ``loop_exit_node``（最后执行），``jump_to`` 得以保留（实测：J 组 ``EXEC`` 为空）。
    - 代价：``before_model`` 执行序变为 ``BusinessRound → ModelCallLimit → BudgetWrapUp``。
      收尾 ``HumanMessage`` 由 ``BudgetWrapUp.before_model`` 追加，
      而 ``BusinessRound.before_model`` 只读 ``end_after_round``，二者无耦合；
      硬上限仍由 ``ModelCallLimitMiddleware`` 在 ``model`` 节点前判定
      （``model_call_limit.py:201-208`` 返回 ``jump_to="end"``）。

    其余顺序依据：

    - ``wrap_model_call`` / ``wrap_tool_call``：列表首个 = **最外层**
      （``factory.py:1052-1056,1154-1161``）。因此 ``BusinessRoundMiddleware``
      的门禁兜底在最内层（贴近真实执行），符合「执行层唯一门禁 + 兜底」的定位。
    - ``ToolErrorMiddleware`` 必须在 ``ToolRetryMiddleware`` **外层**：retry 在内层且
      ``on_failure="error"``，异常才会交给 error middleware（``tool_error.py:58-60``）。
    """
    return [
        BusinessRoundMiddleware(
            phase_ctx=phase_ctx,
            completed_tool_ids=completed_tool_ids,
            phase_ctx_getter=phase_ctx_getter,
            end_turn_on_deferred=end_turn_on_deferred,
        ),
        ModelCallLimitMiddleware(run_limit=max_tool_rounds + 2, exit_behavior="end"),
        ToolErrorMiddleware(
            on_error=_old_error_text,
            aon_error=_old_error_text_async,
            tools=list(SYNC_TOOL_NAMES),
        ),
        ToolRetryMiddleware(
            max_retries=2,
            tools=list(RETRYABLE_TOOL_NAMES),
            retry_on=_retry_on,
            on_failure="error",
            backoff_factor=2.0,
            initial_delay=1.0,
            max_delay=60.0,
            jitter=True,
        ),
        BudgetWrapUpMiddleware(max_tool_rounds=max_tool_rounds),
        *extra,
    ]
