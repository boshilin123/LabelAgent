# 学习导航：所有工作区读写工具共用的路径解析规则：先确定允许的根目录，再解析和校验目标。
# 返回值通常为（路径，错误文字）；失败使用 None 表示，调用方据此给出工具反馈。
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


# 只统一斜杠、空段和点号写法；真正的根目录边界检查在 resolve 系列函数中。
def normalize_relative_path(relative_path: str) -> str:
    """将相对路径统一为正斜杠格式，去除空段与 `.`。"""
    return "/".join(part for part in relative_path.replace("\\", "/").split("/") if part and part != ".")


LR_AGENT_DIR = ".lr-agent"
LR_AGENT_WRITE_DENIED = (
    "不能用本工具写入标注。新增/重写请调用 auto_annotate，修改请调用 mutate_annotation。"
)


# 检查路径中是否包含 .lr-agent 目录段，保护项目内部标注数据。
def is_lr_agent_relative(relative_path: str) -> bool:
    """相对路径是否落入 .lr-agent 标注库目录。"""
    parts = [p for p in normalize_relative_path(relative_path).split("/") if p]
    return any(part == LR_AGENT_DIR for part in parts)


# 把绝对目标转为根内相对路径，再检查是否进入内部标注目录。
def _is_lr_agent_under_root(candidate: Path, root: Path) -> bool:
    try:
        rel = candidate.relative_to(root)
    except ValueError:
        return False
    return any(part == LR_AGENT_DIR for part in rel.parts)


# 按项目目录优先、工作区其次的顺序返回去重后的绝对根目录，与提案应用时的根目录约定一致。
def allowed_roots(client_context: ClientContextInput | None) -> list[Path]:
    """返回可访问的根目录列表（项目目录优先 + 工作区根，去重）。

    顺序必须与前端 applyFileBlock 的写入根一致（project.directoryPath
    ?? workspaceRoot）：提案的 relative_display_path 以列表第一个匹配根
    计算，若后端 workspace 优先而前端 project 优先，Keep All 会把文件
    写到另一个根下（历史隐患：同文件在两个根各落一份）。
    """
    # roots 保留优先顺序，seen 只用来去重；不能随意改成无序集合。
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


# 使用 Path.relative_to 判断目标是否属于根目录，避免只比较字符串前缀。
def _is_under_root(candidate: Path, root: Path) -> bool:
    """判断 candidate 是否在 root 目录树下。"""
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


# 将合法绝对路径变成相对显示路径，让流式提案与最终工具结果使用一致的路径标识。
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


# 优先按写入规则解析路径再生成显示路径；无法解析时只做形式归一，仍需工具后续校验。
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


# 解析已存在文件的绝对/相对路径，检查工作区边界；失败返回 None 和原因。
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


# 解析可访问目录，供目录列表和递归搜索共用。
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


# 按允许根目录顺序尝试生成相对路径，输出统一使用正斜杠。
def relative_path_from_roots(candidate: Path, roots: list[Path]) -> str:
    """将绝对路径转为相对工作区根的路径（正斜杠）。"""
    for root in roots:
        try:
            return normalize_relative_path(str(candidate.relative_to(root)))
        except ValueError:
            continue
    return candidate.name


# 校验写入目标属于允许根且不指向内部标注目录；文件尚不存在也可以生成提案。
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

    # 先判断输入是绝对路径还是相对路径，再分别解析到允许的根目录。
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
