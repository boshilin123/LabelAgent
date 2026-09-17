"""工作区 / 项目文件路径解析与安全校验。

所有文件读取工具（workspace_file_reader、assist_vision）的统一入口：
  1. 确定允许访问的根目录（workspace_root + project_directory）
  2. 解析用户/LLM 传入的路径，回退到当前打开文件
  3. 校验路径在根目录内、禁止 .. 穿越
"""

from __future__ import annotations

from pathlib import Path

from app.agent.context_helpers import project_directory
from app.schemas.agent import ClientContextInput


def normalize_relative_path(relative_path: str) -> str:
    """将相对路径统一为正斜杠格式，去除空段与 `.`。"""
    return "/".join(part for part in relative_path.replace("\\", "/").split("/") if part and part != ".")


LR_AGENT_DIR = ".lr-agent"
LR_AGENT_WRITE_DENIED = (
    "不能用本工具写入标注。新增/重写请调用 auto_annotate，修改请调用 mutate_annotation。"
)


def is_lr_agent_relative(relative_path: str) -> bool:
    """相对路径是否落入 .lr-agent 标注库目录。"""
    parts = [p for p in normalize_relative_path(relative_path).split("/") if p]
    return any(part == LR_AGENT_DIR for part in parts)


def _is_lr_agent_under_root(candidate: Path, root: Path) -> bool:
    try:
        rel = candidate.relative_to(root)
    except ValueError:
        return False
    return any(part == LR_AGENT_DIR for part in rel.parts)


def allowed_roots(client_context: ClientContextInput | None) -> list[Path]:
    """返回可访问的根目录列表（项目目录优先 + 工作区根，去重）。

    顺序必须与前端 applyFileBlock 的写入根一致（project.directoryPath
    ?? workspaceRoot）：提案的 relative_display_path 以列表第一个匹配根
    计算，若后端 workspace 优先而前端 project 优先，Keep All 会把文件
    写到另一个根下（历史隐患：同文件在两个根各落一份）。
    """
    roots: list[Path] = []
    seen: set[str] = set()
    if client_context is None:
        return roots

    for raw in (
        (project_directory(client_context) or "").strip(),
        (client_context.workspace_root or "").strip(),
    ):
        if not raw:
            continue
        try:
            resolved = str(Path(raw).resolve())
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        roots.append(Path(resolved))
    return roots


def _is_under_root(candidate: Path, root: Path) -> bool:
    """判断 candidate 是否在 root 目录树下。"""
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def relative_display_path(
    client_context: ClientContextInput | None,
    resolved: Path,
    fallback: str,
) -> str:
    """将已解析的绝对路径转为相对显示路径（正斜杠），不在任何根内时回退 fallback。"""
    for root in allowed_roots(client_context):
        try:
            return str(resolved.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
    return fallback.strip()


def normalize_write_display_path(
    client_context: ClientContextInput | None,
    raw_path: str,
) -> str:
    """把模型给的写入路径归一为与工具结果一致的显示路径。

    流式拦截器（file_proposal_start / delta）与工具结果定稿事件必须产出
    同一条路径字符串，否则前端按路径匹配提案块时会裂成两张卡片
    （历史 bug：模型写绝对路径或 ./ 前缀导致）。解析失败时退化为
    normalize_relative_path，保证至少分隔符/空段是干净的。
    """
    resolved, _err = resolve_workspace_write_path(client_context, raw_path)
    if resolved is None:
        return normalize_relative_path(raw_path)
    return relative_display_path(client_context, resolved, raw_path)


def resolve_workspace_file(
    client_context: ClientContextInput | None,
    path: str,
) -> tuple[Path | None, str]:
    """解析并校验文件路径，返回 (绝对路径, 错误信息)。

    - path 为空时回退到 active_file_path / active_relative_path
    - 支持绝对路径（须在 allowed_roots 内）与相对路径
    - 禁止 .. 目录穿越
    """
    raw = (path or "").strip()
    if not raw and client_context is not None:
        active_abs = (client_context.active_file_path or "").strip()
        if active_abs:
            raw = active_abs
        else:
            rel = normalize_relative_path(client_context.active_relative_path or "")
            if rel:
                raw = rel

    if not raw:
        return None, "请提供相对路径，或在工作区中打开目标文件后再提问。"

    roots = allowed_roots(client_context)
    if not roots:
        return None, "未绑定工作区或项目目录，无法读取本地文件。"

    candidate_input = Path(raw)
    if candidate_input.is_absolute():
        try:
            candidate = candidate_input.resolve()
        except OSError as exc:
            return None, f"路径无效：{exc}"
        for root in roots:
            if _is_under_root(candidate, root) and candidate.is_file():
                return candidate, ""
        return None, "文件不在当前工作区或项目目录内。"

    rel = normalize_relative_path(raw)
    if ".." in rel.split("/"):
        return None, "路径不能包含 .."

    for root in roots:
        candidate = (root / rel).resolve()
        if not _is_under_root(candidate, root):
            continue
        if candidate.is_file():
            return candidate, ""
    return None, f"未找到文件：{rel}"


def resolve_workspace_directory(
    client_context: ClientContextInput | None,
    path: str,
) -> tuple[Path | None, str]:
    """解析并校验目录路径，返回 (绝对路径, 错误信息)。

    - path 为空时回退到第一个 allowed root（工作区根）
    - 支持绝对路径（须在 allowed_roots 内）与相对路径
    - 禁止 .. 目录穿越
    """
    raw = (path or "").strip()
    roots = allowed_roots(client_context)
    if not roots:
        return None, "未绑定工作区或项目目录，无法访问本地目录。"

    if not raw:
        root = roots[0]
        if root.is_dir():
            return root, ""
        return None, "工作区根目录无效。"

    candidate_input = Path(raw)
    if candidate_input.is_absolute():
        try:
            candidate = candidate_input.resolve()
        except OSError as exc:
            return None, f"路径无效：{exc}"
        for root in roots:
            if _is_under_root(candidate, root) and candidate.is_dir():
                return candidate, ""
        return None, "目录不在当前工作区或项目目录内。"

    rel = normalize_relative_path(raw)
    if ".." in rel.split("/"):
        return None, "路径不能包含 .."

    for root in roots:
        candidate = (root / rel).resolve()
        if not _is_under_root(candidate, root):
            continue
        if candidate.is_dir():
            return candidate, ""
    return None, f"未找到目录：{rel}"


def relative_path_from_roots(candidate: Path, roots: list[Path]) -> str:
    """将绝对路径转为相对工作区根的路径（正斜杠）。"""
    for root in roots:
        try:
            return normalize_relative_path(str(candidate.relative_to(root)))
        except ValueError:
            continue
    return candidate.name


def resolve_workspace_write_path(
    client_context: ClientContextInput | None,
    path: str,
) -> tuple[Path | None, str]:
    """解析并校验写文件目标路径，返回 (绝对路径, 错误信息)。

    与 resolve_workspace_file 的差异：目标文件不要求已存在，仅校验：
    - 路径在 allowed_roots 内
    - 无 .. 目录穿越
    - 父目录不存在时由前端/Electron ensureDir 自动创建
    """
    raw = (path or "").strip()
    if not raw:
        return None, "请提供写入目标的相对路径（如 reports/summary.md）。"

    roots = allowed_roots(client_context)
    if not roots:
        return None, "未绑定工作区或项目目录，无法写入本地文件。"

    candidate_input = Path(raw)
    if candidate_input.is_absolute():
        try:
            candidate = candidate_input.resolve()
        except OSError as exc:
            return None, f"路径无效：{exc}"
        for root in roots:
            if _is_under_root(candidate, root):
                if _is_lr_agent_under_root(candidate, root):
                    return None, LR_AGENT_WRITE_DENIED
                return candidate, ""
        return None, "目标路径不在当前工作区或项目目录内。"

    rel = normalize_relative_path(raw)
    if ".." in rel.split("/"):
        return None, "路径不能包含 .."
    if is_lr_agent_relative(rel):
        return None, LR_AGENT_WRITE_DENIED

    for root in roots:
        candidate = (root / rel).resolve()
        if not _is_under_root(candidate, root):
            continue
        return candidate, ""
    return None, f"无法解析写入路径：{rel}"
