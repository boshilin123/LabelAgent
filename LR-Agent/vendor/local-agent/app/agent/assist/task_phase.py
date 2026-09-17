"""标注任务阶段状态机：从结构化提案状态推导阶段，按阶段门禁工具调用。

设计要点：
  - 后端无状态：每次请求由 derive_task_phase 根据 client_context.proposal_states
    重新推导，不持久化任何阶段。
  - 阶段是不变量约束而非线性流程：无标注提案历史的请求返回 None，
    不启用任何门禁（旧客户端与纯问答零行为变化）。
  - 门禁分两级：
    1. 工具级：await_confirm 阶段禁止全部写入工具（标注写入 + 工作区写入），
       防止"报告跑在落盘前"与"未确认就重复标注"。
    2. 路径级：verify 阶段禁止对已 applied 的标注路径重复调用标注工具。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from typing import Any

from app.schemas.agent import ProposalStateInput

ANNOTATION_WRITE_TOOLS: frozenset[str] = frozenset(
    {"auto_annotate", "mutate_annotation"}
)
WORKSPACE_WRITE_TOOLS: frozenset[str] = frozenset(
    {
        "write_workspace_file",
        "str_replace_workspace_file",
        "delete_workspace_file",
        "move_workspace_file",
    }
)


class TaskPhase(str, Enum):
    """标注任务阶段。SCAN/ANNOTATE/REPORT 目前仅作语义标记，门禁集中在
    AWAIT_CONFIRM 与 VERIFY。"""

    SCAN = "scan"
    ANNOTATE = "annotate"
    AWAIT_CONFIRM = "await_confirm"
    VERIFY = "verify"
    REPORT = "report"


@dataclass(frozen=True)
class TaskPhaseContext:
    """一次请求推导出的阶段上下文。"""

    phase: TaskPhase
    pending_annotation_paths: frozenset[str]
    applied_annotation_paths: frozenset[str]
    applied_annotation_ids: frozenset[str] = frozenset()

    @property
    def gating_enabled(self) -> bool:
        return self.phase in (TaskPhase.AWAIT_CONFIRM, TaskPhase.VERIFY)


def normalize_rel_path(path: str) -> str:
    """归一化相对路径，便于跨调用比对（统一斜杠、去 ./ 前缀）。"""
    normalized = path.strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def derive_task_phase(
    proposal_states: list[ProposalStateInput] | None,
) -> TaskPhaseContext | None:
    """从结构化提案状态推导任务阶段。

    返回 None 表示不启用门禁：
      - 无 proposal_states（旧客户端 / 纯问答 / 无提案历史）
      - 所有提案均为 dismissed（用户关闭提案，重新规划）
    """
    if not proposal_states:
        return None
    pending = frozenset(
        normalize_rel_path(state.path)
        for state in proposal_states
        if state.kind == "annotation" and state.status == "pending"
    )
    applied = frozenset(
        normalize_rel_path(state.path)
        for state in proposal_states
        if state.kind == "annotation" and state.status == "applied"
    )
    applied_ids = frozenset(
        ann_id
        for state in proposal_states
        if state.kind == "annotation" and state.status == "applied"
        for ann_id in state.annotation_ids
        if ann_id
    )
    if pending:
        return TaskPhaseContext(
            phase=TaskPhase.AWAIT_CONFIRM,
            pending_annotation_paths=pending,
            applied_annotation_paths=applied,
            applied_annotation_ids=applied_ids,
        )
    if applied:
        return TaskPhaseContext(
            phase=TaskPhase.VERIFY,
            pending_annotation_paths=frozenset(),
            applied_annotation_paths=applied,
            applied_annotation_ids=applied_ids,
        )
    return None


def coerce_str_list(value: Any) -> list[str]:
    """把模型传来的 list / JSON 数组字符串 / 逗号分隔 / 单值收成字符串列表。

    部分模型会把 array 参数序列化成 '["data/4.jpg"]' 或 'data/4.jpg'，
    不能按 list 去迭代字符串（否则会拆成单字符）。
    """
    if value is None:
        return []
    if isinstance(value, list):
        items: list[Any] = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        parsed: Any = None
        if text[:1] in "[{":
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                parsed = None
        if isinstance(parsed, list):
            items = parsed
        elif "," in text:
            items = text.split(",")
        else:
            items = [text]
    else:
        items = [value]
    return [str(item).strip() for item in items if str(item).strip()]


def coerce_bool(value: Any) -> bool:
    """把模型传来的 true/false（含字符串形式）收成 bool。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return bool(value)


def extract_call_paths(arguments: dict[str, Any]) -> frozenset[str]:
    """从标注工具参数中提取目标路径集合（paths 优先，兼容 scope_hint）。"""
    paths: set[str] = set()
    for item in coerce_str_list(arguments.get("paths")):
        paths.add(normalize_rel_path(item))
    scope_hint = arguments.get("scope_hint")
    if isinstance(scope_hint, str):
        for item in scope_hint.split(","):
            text = item.strip()
            if text:
                paths.add(normalize_rel_path(text))
    return frozenset(paths)


def blocked_tool_names(ctx: TaskPhaseContext | None) -> frozenset[str]:
    """工具级门禁：bind_tools 时直接移除的工具集合。"""
    if ctx is None or not ctx.gating_enabled:
        return frozenset()
    if ctx.phase == TaskPhase.AWAIT_CONFIRM:
        return ANNOTATION_WRITE_TOOLS | WORKSPACE_WRITE_TOOLS
    return frozenset()


def check_call_allowed(
    name: str,
    arguments: dict[str, Any],
    ctx: TaskPhaseContext | None,
) -> str | None:
    """执行前门禁。返回 None 表示允许；否则返回给模型的错误说明。

    覆盖 bind 过滤之外的兜底场景（例如阶段上下文存在但工具未被移除）。
    """
    if ctx is None or not ctx.gating_enabled:
        return None
    if ctx.phase == TaskPhase.AWAIT_CONFIRM:
        if name in ANNOTATION_WRITE_TOOLS or name in WORKSPACE_WRITE_TOOLS:
            pending = "、".join(sorted(ctx.pending_annotation_paths))
            return (
                f"当前存在未确认的标注提案（{pending}），用户尚未 Keep All，提案未写盘。"
                "禁止标注写入与文件写入操作。请用一两句说明提案内容，"
                "提示用户 Keep All 或关闭提案后再继续。"
            )
        return None
    if ctx.phase == TaskPhase.VERIFY and name in ANNOTATION_WRITE_TOOLS:
        if not ctx.applied_annotation_paths:
            return None
        applied_paths_text = "、".join(sorted(ctx.applied_annotation_paths))
        if coerce_bool(arguments.get("all_files")):
            return (
                f"以下文件本轮已完成标注并经用户确认落盘：{applied_paths_text}。"
                "禁止 all_files=true 的全量重标；如确需对其他文件标注，请用 paths 明确指定。"
            )
        call_paths = extract_call_paths(arguments)
        if name == "auto_annotate":
            if not call_paths:
                return (
                    f"以下文件本轮已完成标注并经用户确认落盘：{applied_paths_text}。"
                    "auto_annotate 未指明 paths/scope_hint，无法确认是否重复标注已落盘文件，"
                    "请用 paths 明确指定要标注的新文件。"
                )
            overlap = call_paths & ctx.applied_annotation_paths
            if overlap:
                return (
                    f"以下文件本轮已完成标注并经用户确认落盘：{'、'.join(sorted(overlap))}。"
                    "请勿重复标注。如核对后认为确需重标，必须向用户说明检测到的不一致"
                    "（检测到几个框、标签是什么、与预期差在哪），"
                    "并给出确切的下一步指令（如「请说：重新标注 data/x.jpg」），由用户发起。"
                )
            return None
        # mutate_annotation
        annotation_ids = coerce_str_list(arguments.get("annotation_ids"))
        if not call_paths and not annotation_ids:
            return (
                f"以下文件本轮已完成标注并经用户确认落盘：{applied_paths_text}。"
                "mutate_annotation 未指明 paths 或 annotation_ids，无法确认是否修改已落盘标注，"
                "请明确指定目标。"
            )
        # 定向修正（含已落盘文件）放行；整文件重标仍由 auto_annotate 分支拦截
        return None
    return None


def phase_prompt_block(ctx: TaskPhaseContext | None) -> str:
    """阶段提示词块，追加到系统提示词末尾。"""
    if ctx is None or not ctx.gating_enabled:
        return ""
    if ctx.phase == TaskPhase.AWAIT_CONFIRM:
        paths = "、".join(sorted(ctx.pending_annotation_paths))
        return (
            "【任务阶段】等待用户确认标注提案\n"
            f"- 以下文件的标注提案未确认、未写盘：{paths}\n"
            "- 禁止调用标注写入与文件写入工具；禁止声称已标注/已修改/已写入。\n"
            "- 不要用 read_file_annotation 验证提案内容（磁盘仍是旧态，以提案台账为准）。\n"
            "- 用一两句说明提案内容，提示用户 Keep All 或关闭提案。"
        )
    if ctx.phase == TaskPhase.VERIFY:
        paths = "、".join(sorted(ctx.applied_annotation_paths))
        return (
            "【任务阶段】标注提案已确认落盘\n"
            f"- 以下文件的标注提案已由用户 Keep All 并写盘：{paths}\n"
            "- 可用 read_file_annotation 核对落盘结果；如任务要求报告，用 write_workspace_file 生成。\n"
            "- 禁止对上述路径重复调用 auto_annotate 整文件重标；核对发现错标/漏标/重复框时，"
            "用 mutate_annotation 定向修正，并带上 paths 或 annotation_ids。\n"
            "- 提案已确认落盘，禁止再要求用户确认、Keep All 或查看提案。\n"
            "- 报告中的每个数字必须来自工具返回或提案明细，禁止估算或凭印象填写。\n"
            "- 工具完成后用一两句确认即可，不要重复输出报告全文。"
        )
    return ""
