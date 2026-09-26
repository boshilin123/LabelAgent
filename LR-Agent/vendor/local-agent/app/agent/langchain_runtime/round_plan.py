"""阶段 2 纯函数层：「本轮计划」——严格复刻旧 ``ToolLoopRunner.execute_round`` 的决策顺序。

设计边界（对应 ``docs/阶段2-业务middleware设计备忘.md`` §2 与阶段 2 实施清单第 1 项）：

- **纯函数、无副作用、无 I/O**：不碰 ``self``，不读全局，不写 messages。
  中间件实例跨并发 run 共享，因此本轮计划**只放 state 通道**（见 :mod:`middleware`）。
- **只复用既有生产件**，不引入新的工具抽象：
  ``app.agent.tools.tool_registry_meta``（runner 类型）、
  ``app.agent.assist.task_phase``（门禁 + 路径提取）、
  ``app.agent.tools.tool_result``（统一 ToolMessage JSON）。
- **决策顺序 = 旧路径顺序**（``app/agent/assist/tool_loop.py:456-617``）：
  already_completed → 同轮标注写/工作区写互斥 → ``check_call_allowed`` 门禁 →
  多 ``auto_annotate`` 合并 → 同批异步去重。
  顺序不同会导致注入的 ``ToolMessage`` 顺序不同，进而改变模型看到的内容顺序。

**与旧路径的一处刻意差异**（见 ``docs/阶段2-业务middleware设计备忘.md`` §2 的机制说明）：
旧路径里「被合并 / 被去重」的调用**不会**进入模型可见的 messages（该轮以
``tool_pending`` 结束，model 不再被调用）：只有 ``already_completed`` 与
``phase_blocked`` 会 ``messages.append(ToolMessage(...))``
（``tool_loop.py:473-485`` / ``:506-515`` / ``:530-536``）。
候选路径必须为每个被抑制的调用补一条 ``ToolMessage``——否则图会把它当作
pending tool_call 送进 ``tools`` 节点执行。本站因此把四类抑制统一放进
:attr:`RoundPlan.deferred`，比旧路径**多**给了合并/去重调用一条结果消息；
副作用是「模型后续若因其他原因继续，不会重复发起被合并的调用」，属安全方向。

**阶段 3 边界**：``already_completed`` 依赖请求级 ``client_tool_results``
（``assist_service.py:83-93``），hook 看不到 resume 状态；
本模块因此把它做成**显式入参**（默认空集），由阶段 3 跨请求播种。
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessage, AnyMessage, ToolMessage

from app.agent.assist.task_phase import (
    ANNOTATION_WRITE_TOOLS,
    WORKSPACE_WRITE_TOOLS,
    TaskPhaseContext,
    check_call_allowed,
    extract_call_paths,
)
from app.agent.tool_invocation import normalize_api_tool_calls
from app.agent.tools.tool_registry_meta import get_tool_runner, ToolRunner
from app.agent.tools.tool_result import build_tool_result

__all__ = [
    "ALREADY_COMPLETED_SUMMARY",
    "COALESCED_TEMPLATE",
    "DUPLICATE_SUMMARY",
    "WORKSPACE_WRITE_BLOCKED_SUMMARY",
    "RoundPlan",
    "RoundToolCall",
    "plan_round",
]


ALREADY_COMPLETED_SUMMARY = (
    "该工具本轮已执行，请勿重复调用。请总结，勿重跑标注工具。"
)
"""逐字复刻 ``app/agent/assist/tool_loop.py:65-67``。"""

WORKSPACE_WRITE_BLOCKED_SUMMARY = (
    "本轮已包含标注写入（auto_annotate / mutate_annotation）。"
    "请先完成标注并等待用户 Keep All，再写报告或修改文件。"
)
"""逐字复刻 ``tool_loop.py:509-512``（首个新增的抑制调用 id 取 ``tool_loop.py:2592``）。"""

DUPLICATE_SUMMARY = "同一轮内相同范围的重复标注调用已忽略，请勿重复发起。"
"""逐字复刻 ``tool_loop.py:605``。"""

COALESCED_TEMPLATE = (
    "本次调用已并入第一个 auto_annotate（paths 合并为 {paths}），请勿重复发起。"
)
"""逐字复刻 ``tool_loop.py:580-581``；``{paths}`` 用 ``str(list)`` 填充（与旧路径同）。"""


@dataclass(frozen=True)
class RoundToolCall:
    """本轮某个工具调用的最终去向。

    - ``result_json`` 为 ``None``：该调用**不会被抑制**，交给后续环节
      （同步工具由 ``tools`` 节点执行；异步工具挂起给客户端）；
    - ``result_json`` 非 ``None``：该调用**已被抑制**，由 ``after_model``
      注入同 id 的 ``ToolMessage``，永不进入 ``tools`` 节点。
    """

    tool_call_id: str
    name: str
    arguments: dict[str, Any]
    result_json: str | None = None

    @property
    def suppressed(self) -> bool:
        return self.result_json is not None

    @property
    def tool_message(self) -> ToolMessage | None:
        if self.result_json is None:
            return None
        return ToolMessage(content=self.result_json, tool_call_id=self.tool_call_id)


@dataclass(frozen=True)
class RoundPlan:
    """一轮模型输出对应的完整执行计划（不可变、可安全放进 state 通道）。"""

    calls: tuple[RoundToolCall, ...] = ()
    """模型本轮发起的全部调用，**保持模型给出的原始顺序**（含被抑制者）。"""

    execute_now: tuple[RoundToolCall, ...] = ()
    """交给 ``tools`` 节点执行的调用（``immediate``：SYNC / PROPOSAL）。顺序 = 旧路径顺序。"""

    deferred: tuple[RoundToolCall, ...] = ()
    """由客户端执行的挂起调用（``async_pending``）。

    合并后的首个 ``auto_annotate`` 携带**合并参数**；已被合并/去重的调用
    **不在此列**（它们在 :attr:`suppressed` 中）。
    """

    suppressed: tuple[RoundToolCall, ...] = ()
    """被抑制的调用（``already_completed`` / ``phase_blocked`` / ``coalesced`` /
    ``duplicate_call``），**按旧路径的产出顺序**排列。

    ``after_model`` 按此顺序注入 ``ToolMessage``——顺序不同会改变模型看到的内容顺序。
    """

    merged_arguments: dict[str, dict[str, Any]] = field(default_factory=dict)
    """``tool_call_id`` → 合并后的参数（仅合并后的首个 ``auto_annotate``）。

    ``wrap_tool_call`` 用它做兜底改写（幂等：写回的是同一份内容）。
    """

    already_completed_ids: tuple[str, ...] = ()

    @property
    def injected_messages(self) -> list[ToolMessage]:
        """``after_model`` 要注入的 ``ToolMessage``，顺序 = 旧路径产出顺序。"""
        return [
            call.tool_message
            for call in self.suppressed
            if call.tool_message is not None
        ]

    @property
    def has_any_call(self) -> bool:
        return bool(self.calls)

    @property
    def all_calls_resolved_here(self) -> bool:
        """本轮每个调用都有归宿（执行 / 挂起 / 抑制），不存在未处理项。"""
        return len(self.execute_now) + len(self.deferred) + len(self.suppressed) == len(
            self.calls
        )

    @property
    def suppression_reasons(self) -> tuple[str, ...]:
        """被抑制调用各自的 ``status``（从结果 JSON 里取，顺序同 :attr:`suppressed`）。"""
        reasons: list[str] = []
        for call in self.suppressed:
            if not call.result_json:
                continue
            try:
                payload = json.loads(call.result_json)
            except (TypeError, ValueError):
                continue
            status = payload.get("status") if isinstance(payload, dict) else None
            if isinstance(status, str):
                reasons.append(status)
        return tuple(reasons)


def _args_of(call: Mapping[str, Any]) -> dict[str, Any]:
    raw = call.get("args")
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def _duplicate_scope(name: str, arguments: Mapping[str, Any]) -> tuple[str, frozenset[str]]:
    """同范围判定键：``(name, extract_call_paths(args))``（``tool_loop.py:600``）。"""
    return (name, extract_call_paths(dict(arguments)))


def _coalesce_auto_annotate(
    calls: Sequence[RoundToolCall],
) -> tuple[RoundToolCall, list[RoundToolCall], list[str]]:
    """把同轮多个 ``auto_annotate`` 合并为一个（``tool_loop.py:543-593``）。

    返回 ``(合并后的首个调用, 被合并掉的其余调用, 合并后的 paths)``。

    ``paths`` 首见序并集、``all_files`` 取 OR、``write_mode`` 任一为
    ``replace_matching`` 则替换（``tool_loop.py:548-567``）；更新方式与旧路径
    一致（``dict(first.arguments)`` 后逐键赋值），因此参数键顺序保持首个调用的顺序。
    """
    merged_paths: list[str] = []
    seen_paths: set[str] = set()
    merged_all_files = False
    merged_write_mode = "append"
    for call in calls:
        for path in extract_call_paths(dict(call.arguments)):
            if path not in seen_paths:
                seen_paths.add(path)
                merged_paths.append(path)
        if call.arguments.get("all_files") is True:
            merged_all_files = True
        if call.arguments.get("write_mode") == "replace_matching":
            merged_write_mode = "replace_matching"

    first = calls[0]
    first_args = dict(first.arguments)
    first_args["paths"] = merged_paths
    first_args["all_files"] = merged_all_files
    first_args["write_mode"] = merged_write_mode
    merged_first = RoundToolCall(
        tool_call_id=first.tool_call_id,
        name=first.name,
        arguments=first_args,
    )
    return merged_first, list(calls[1:]), merged_paths


def plan_round(
    message: AnyMessage | None,
    *,
    phase_ctx: TaskPhaseContext | None = None,
    completed_tool_ids: Iterable[str] = (),
) -> RoundPlan:
    """计算「本轮计划」。纯函数：相同入参恒返回相同结果，不修改任何入参。

    参数：

    - ``message``：本轮模型输出（``AIMessage``；``tool_calls`` 为其调用）；
    - ``phase_ctx``：阶段门禁上下文（``None`` 或 ``gating_enabled=False`` 时不门禁）；
    - ``completed_tool_ids``：已完成的 ``tool_call_id``（阶段 3 跨请求播种；
      阶段 2 默认空集，只覆盖同 run）。
    """
    api_tool_calls: list[Any] = []
    if isinstance(message, AIMessage):
        api_tool_calls = list(message.tool_calls or [])
    elif isinstance(message, Mapping):
        api_tool_calls = list(message.get("tool_calls") or [])

    if not api_tool_calls:
        return RoundPlan()

    # **不要**把 ``completed_tool_ids`` 交给 ``normalize_api_tool_calls``：
    # 它会把已完成的调用**直接丢弃**（``tool_invocation.py:39-40``），
    # 于是这些 ``tool_call_id`` 拿不到任何结果消息，而图仍会把它们
    # 当作 pending 送给 ``tools`` 节点（``factory.py:1953-1957`` 只认
    # ``tool_message_ids``，不认业务状态）。旧路径相反：它同样先过滤，
    # 但随后为**所有** ``api_tool_calls`` 补 ``already_completed`` 结果
    # （``tool_loop.py:469-487``）。因此候选侧必须保留完整清单，
    # 再自行拆出「已完成」的那一部分并补结果。
    resolved = normalize_api_tool_calls(api_tool_calls)
    all_calls = [
        RoundToolCall(
            tool_call_id=call.tool_call_id,
            name=call.name,
            arguments=dict(call.arguments),
        )
        for call in resolved
    ]
    completed_set = set(completed_tool_ids)
    calls = [call for call in all_calls if call.tool_call_id not in completed_set]
    already_completed = [
        call for call in all_calls if call.tool_call_id in completed_set
    ]
    suppressed: list[RoundToolCall] = [
        RoundToolCall(
            tool_call_id=call.tool_call_id,
            name=call.name,
            arguments=call.arguments,
            result_json=build_tool_result(
                ok=False,
                tool=call.name,
                status="already_completed",
                summary=ALREADY_COMPLETED_SUMMARY,
            ),
        )
        for call in already_completed
    ]
    if suppressed:
        # 旧路径在「全部调用都已完成」时直接返回，不进入后续环节（tool_loop.py:469-487）。
        # 候选路径同样短路：已完成的调用不再参与互斥 / 门禁 / 合并 / 去重。
        return RoundPlan(
            calls=tuple(all_calls),
            suppressed=tuple(suppressed),
            already_completed_ids=tuple(call.tool_call_id for call in already_completed),
        )

    # ── 同轮顺序不变量：标注写入与工作区写入不能同轮（tool_loop.py:491-520）──
    has_annotation_write = any(
        call.name in ANNOTATION_WRITE_TOOLS for call in calls
    )
    if has_annotation_write:
        kept: list[RoundToolCall] = []
        for call in calls:
            if call.name in WORKSPACE_WRITE_TOOLS:
                suppressed.append(
                    RoundToolCall(
                        tool_call_id=call.tool_call_id,
                        name=call.name,
                        arguments=call.arguments,
                        result_json=build_tool_result(
                            ok=False,
                            tool=call.name,
                            status="phase_blocked",
                            summary=WORKSPACE_WRITE_BLOCKED_SUMMARY,
                        ),
                    )
                )
                continue
            kept.append(call)
        calls = kept

    # ── 阶段门禁（tool_loop.py:522-539）：执行层唯一门禁 ──────────────
    if phase_ctx is not None and phase_ctx.gating_enabled:
        allowed: list[RoundToolCall] = []
        for call in calls:
            reason = check_call_allowed(call.name, call.arguments, phase_ctx)
            if reason is None:
                allowed.append(call)
                continue
            suppressed.append(
                RoundToolCall(
                    tool_call_id=call.tool_call_id,
                    name=call.name,
                    arguments=call.arguments,
                    result_json=build_tool_result(
                        ok=False,
                        tool=call.name,
                        status="phase_blocked",
                        summary=reason,
                    ),
                )
            )
        calls = allowed

    # ── SYNC / ASYNC 拆分（tool_loop.py:541）──────────────────────────
    immediate = [
        call
        for call in calls
        if get_tool_runner(call.name) is not ToolRunner.ASYNC
    ]
    async_pending = [
        call
        for call in calls
        if get_tool_runner(call.name) is ToolRunner.ASYNC
    ]

    # ── 同轮多个 auto_annotate 合并为一次批量（tool_loop.py:543-593）──
    auto_calls = [call for call in async_pending if call.name == "auto_annotate"]
    if len(auto_calls) > 1:
        merged_first, merged_away, merged_paths = _coalesce_auto_annotate(auto_calls)
        reason = COALESCED_TEMPLATE.format(paths=merged_paths)
        for call in merged_away:
            suppressed.append(
                RoundToolCall(
                    tool_call_id=call.tool_call_id,
                    name=call.name,
                    arguments=call.arguments,
                    result_json=build_tool_result(
                        ok=False,
                        tool=call.name,
                        status="coalesced",
                        summary=reason,
                    ),
                )
            )
        async_pending = [merged_first, *(
            call for call in async_pending if call.name != "auto_annotate"
        )]

    # ── 同批异步调用去重：同工具同范围只保留第一个（tool_loop.py:595-617）──
    merged_arguments: dict[str, dict[str, Any]] = {}
    if async_pending:
        seen_scopes: set[tuple[str, frozenset[str]]] = set()
        deduped: list[RoundToolCall] = []
        for call in async_pending:
            scope_key = _duplicate_scope(call.name, call.arguments)
            if scope_key in seen_scopes:
                suppressed.append(
                    RoundToolCall(
                        tool_call_id=call.tool_call_id,
                        name=call.name,
                        arguments=call.arguments,
                        result_json=build_tool_result(
                            ok=False,
                            tool=call.name,
                            status="duplicate_call",
                            summary=DUPLICATE_SUMMARY,
                        ),
                    )
                )
                continue
            seen_scopes.add(scope_key)
            deduped.append(call)
        async_pending = deduped

    # 合并参数改写表：只有当合并后的参数与原参数不同才登记（保持幂等）。
    for call in async_pending:
        original = next(
            (c for c in calls if c.tool_call_id == call.tool_call_id), None
        )
        if original is not None and call.arguments != original.arguments:
            merged_arguments[call.tool_call_id] = dict(call.arguments)

    return RoundPlan(
        calls=tuple(all_calls),
        execute_now=tuple(immediate),
        deferred=tuple(async_pending),
        suppressed=tuple(suppressed),
        merged_arguments=merged_arguments,
    )
