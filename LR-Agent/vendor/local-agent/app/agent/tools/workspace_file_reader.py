"""工作区文件读取与写入实现：文本/代码、文档（PDF/DOCX）、图片（视觉）、写文件提案。

由 registry 注册为 LLM 工具；视觉与写文件相关辅助函数供 assist_service / assist_vision 使用：
  - extract_vision_path_from_tool_result：从工具结果提取图片绝对路径
  - format_vision_tool_result_for_display：隐藏内部路径标记后展示给用户
  - extract_doc_proposal_from_tool_result：从写文件工具结果提取文档提案数据
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from app.agent.tools.tool_result import build_tool_result, format_tool_result_for_display
from app.agent.tools.workspace_path import (
    relative_display_path,
    resolve_workspace_file,
    resolve_workspace_write_path,
)
from app.agent.tools.workspace_text_extensions import (
    TEXT_BLOCKLIST_SUFFIXES,
    is_allowed_text_extension,
)
from app.core.config import Settings
from app.schemas.agent import ClientContextInput

VISION_TOOL_NAME = "read_image_for_vision"
WRITE_TOOL_NAME = "write_workspace_file"
STR_REPLACE_TOOL_NAME = "str_replace_workspace_file"
DELETE_TOOL_NAME = "delete_workspace_file"
MOVE_TOOL_NAME = "move_workspace_file"
FILE_PROPOSAL_TOOLS = frozenset(
    {WRITE_TOOL_NAME, STR_REPLACE_TOOL_NAME, DELETE_TOOL_NAME, MOVE_TOOL_NAME}
)
# 工具结果 JSON 中的内部字段，assist_service 据此注入多模态消息
VISION_PATH_MARKER = "__vision_image_path__"
# 工具结果 JSON 中的内部字段，assist_service 据此发出 file_proposal SSE 事件
DOC_PROPOSAL_MARKER = "__doc_proposal__"

IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"})
DOCUMENT_SUFFIXES = frozenset({".pdf", ".docx"})


# 单行展示上限：防止 minified / 单行巨型文件把工具结果撑爆
MAX_LINE_DISPLAY_CHARS = 2000


def _cap_line(line: str) -> str:
    if len(line) <= MAX_LINE_DISPLAY_CHARS:
        return line
    return f"{line[:MAX_LINE_DISPLAY_CHARS]}…[行已截断，共 {len(line)} 字符]"


def _read_line_window(
    resolved: Path,
    start: int,
    end: int | None,
    max_lines: int,
) -> tuple[list[str], int | None, bool, str | None]:
    """流式读取 [start, end]（1-indexed，含首尾；end=None 表示到 EOF）行窗口。

    返回 (lines, total_lines, truncated, error)：
    - total_lines 为 None 表示提前停止（按 end 或窗口上限），总行数未知
    - truncated=True 表示窗口超过 max_lines 被截断
    """
    for encoding in ("utf-8", "utf-8-sig"):
        try:
            collected: list[str] = []
            total: int | None = 0
            truncated = False
            with resolved.open("r", encoding=encoding) as fh:
                for idx, raw_line in enumerate(fh, start=1):
                    if idx < start:
                        total = idx
                        continue
                    if end is not None and idx > end:
                        total = None
                        break
                    if len(collected) >= max_lines:
                        truncated = True
                        total = None
                        break
                    collected.append(raw_line.rstrip("\n"))
                    total = idx
            return collected, total, truncated, None
        except UnicodeDecodeError:
            continue
        except OSError as exc:
            return [], None, False, f"读取失败：{exc}"
    return [], None, False, f"「{resolved.name}」不是 UTF-8 文本，暂不支持读取。"


def _read_ranged_text(
    resolved: Path,
    size: int,
    start_line: int | None,
    end_line: int | None,
    max_lines: int,
) -> str:
    """行范围读取：流式窗口，不受 max_bytes / max_lines 对文件头部的预截断影响。"""
    s = max(1, start_line if start_line is not None else 1)
    if end_line is not None and end_line < s:
        return f"无效行范围：start_line ({s}) 不能大于 end_line ({end_line})。"

    try:
        with resolved.open("rb") as fh:
            if b"\x00" in fh.read(8192):
                return f"「{resolved.name}」似乎是二进制文件，请使用对应专用工具。"
    except OSError as exc:
        return f"读取失败：{exc}"

    lines, total, truncated, read_err = _read_line_window(resolved, s, end_line, max_lines)
    if read_err is not None:
        return read_err

    header = f"文件：{resolved.name}\n大小：{size} 字节\n"
    end_label = f"L{end_line}" if end_line is not None else "EOF"
    header += f"行范围：L{s}-{end_label}"
    if total is not None:
        header += f"（共 {total} 行）"
    header += "\n"
    if truncated:
        header += (
            f"（行窗口已截断，最多 {max_lines} 行；"
            "可用 start_line/end_line 继续分段读取）\n"
        )
    header += "---\n"
    if not lines:
        if total is not None:
            return header + f"（起始行超出文件末尾，共 {total} 行）"
        return header + "（指定范围内无内容）"
    numbered = [
        f"{s + offset:6d}|{_cap_line(line)}"
        for offset, line in enumerate(lines)
    ]
    return header + "\n".join(numbered)


def read_workspace_text_file(
    client_context: ClientContextInput | None,
    path: str,
    *,
    settings: Settings,
    start_line: int | None = None,
    end_line: int | None = None,
) -> str:
    """读取 UTF-8 文本/代码文件，按配置截断字节数与行数；可选行范围（1-indexed，含首尾）。

    指定行范围时按流式窗口读取，支持大文件任意位置；否则读取文件头部并截断。
    """
    resolved, err = resolve_workspace_file(client_context, path)
    if resolved is None:
        return err

    suffix = resolved.suffix.lower()
    if suffix in TEXT_BLOCKLIST_SUFFIXES:
        return (
            f"「{resolved.name}」不是纯文本文件。"
            f"图片请用 {VISION_TOOL_NAME}；PDF/DOCX 请用 read_document_file。"
        )

    max_bytes = settings.agent_read_file_max_bytes
    max_lines = settings.agent_read_file_max_lines

    try:
        size = resolved.stat().st_size
    except OSError as exc:
        return f"无法读取文件：{exc}"

    if start_line is not None or end_line is not None:
        return _read_ranged_text(resolved, size, start_line, end_line, max_lines)

    truncated = False
    try:
        if size > max_bytes:
            truncated = True
            raw = resolved.read_bytes()[:max_bytes]
        else:
            raw = resolved.read_bytes()
    except OSError as exc:
        return f"读取失败：{exc}"

    if b"\x00" in raw[:8192]:
        return f"「{resolved.name}」似乎是二进制文件，请使用对应专用工具。"

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return f"「{resolved.name}」不是 UTF-8 文本，暂不支持读取。"

    lines = text.splitlines()
    if len(lines) > max_lines:
        truncated = True
        lines = lines[:max_lines]

    header = f"文件：{resolved.name}\n大小：{size} 字节\n"
    if truncated:
        header += (
            f"（内容已截断，最多 {max_bytes} 字节 / {max_lines} 行；"
            "可用 start_line/end_line 分段读取后续内容）\n"
        )
    header += "---\n"
    numbered = [
        f"{1 + offset:6d}|{_cap_line(line)}"
        for offset, line in enumerate(lines)
    ]
    return header + "\n".join(numbered)


def read_image_for_vision_tool(
    client_context: ClientContextInput | None,
    path: str,
    *,
    provider_is_vision: bool,
) -> str:
    """加载图片元信息并返回 JSON；assist_service 据此注入多模态用户消息。"""
    if not provider_is_vision:
        return (
            "当前大模型未通过视觉能力探针，无法分析图片内容。"
            "请在「大模型配置」中选用支持视觉的模型并重探视觉能力。"
        )

    resolved, err = resolve_workspace_file(client_context, path)
    if resolved is None:
        return err

    suffix = resolved.suffix.lower()
    if suffix not in IMAGE_SUFFIXES:
        return f"「{resolved.name}」不是支持的图片格式（{', '.join(sorted(IMAGE_SUFFIXES))}）。"

    try:
        with Image.open(resolved) as img:
            width, height = img.size
            fmt = (img.format or suffix.lstrip(".")).upper()
    except OSError as exc:
        return f"无法打开图片：{exc}"

    payload = {
        "ok": True,
        "path": str(resolved),
        "name": resolved.name,
        "width": width,
        "height": height,
        "format": fmt,
        VISION_PATH_MARKER: str(resolved),
        "message": (
            f"已加载图片 {resolved.name}（{width}x{height} {fmt}）。"
            "系统将在本条工具结果后注入附图，请根据图像回答用户问题。"
        ),
    }
    return json.dumps(payload, ensure_ascii=False)


def read_document_file(
    client_context: ClientContextInput | None,
    path: str,
    *,
    settings: Settings,
) -> str:
    """提取 PDF / DOCX 正文，按配置截断页数与字符数。"""
    resolved, err = resolve_workspace_file(client_context, path)
    if resolved is None:
        return err

    suffix = resolved.suffix.lower()
    if suffix not in DOCUMENT_SUFFIXES:
        return f"「{resolved.name}」不是支持的文档格式（pdf、docx）。"

    max_pages = settings.agent_read_document_max_pages

    try:
        if suffix == ".pdf":
            text, meta = _extract_pdf_text(resolved, max_pages=max_pages)
        else:
            text, meta = _extract_docx_text(resolved)
    except Exception as exc:
        return f"解析文档失败：{exc}"

    if not text.strip():
        return f"「{resolved.name}」未能提取到文本（{meta}）。"

    max_chars = settings.agent_read_file_max_bytes
    truncated = len(text) > max_chars
    if truncated:
        text = text[:max_chars]

    header = f"文件：{resolved.name}\n{meta}\n"
    if truncated:
        header += f"（正文已截断至 {max_chars} 字符）\n"
    header += "---\n"
    return header + text


def _extract_pdf_text(path: Path, *, max_pages: int) -> tuple[str, str]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    total = len(reader.pages)
    limit = min(total, max_pages)
    parts: list[str] = []
    for idx in range(limit):
        page = reader.pages[idx]
        parts.append(page.extract_text() or "")
    meta = f"PDF 共 {total} 页，已提取前 {limit} 页"
    return "\n\n".join(parts), meta


def _extract_docx_text(path: Path) -> tuple[str, str]:
    from docx import Document

    doc = Document(str(path))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(paragraphs), f"DOCX 段落数：{len(paragraphs)}"


def extract_vision_path_from_tool_result(tool_name: str, result_text: str) -> str | None:
    """从 read_image_for_vision 工具结果中提取图片绝对路径。"""
    if tool_name != VISION_TOOL_NAME:
        return None
    try:
        data = json.loads(result_text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not data.get("ok"):
        return None
    path = str(data.get(VISION_PATH_MARKER) or "").strip()
    if not path:
        return None
    candidate = Path(path)
    return str(candidate) if candidate.is_file() else None


def format_vision_tool_result_for_display(result_text: str) -> str:
    """格式化视觉工具结果供前端展示，移除内部路径标记。"""
    try:
        data = json.loads(result_text)
    except json.JSONDecodeError:
        return result_text
    if not isinstance(data, dict):
        return result_text
    display = dict(data)
    display.pop(VISION_PATH_MARKER, None)
    return json.dumps(display, ensure_ascii=False, indent=2)


def _relative_display_path(
    client_context: ClientContextInput | None,
    resolved: Path,
    fallback: str,
) -> str:
    return relative_display_path(client_context, resolved, fallback)


# 同一轮请求内的未落盘提案内容接力：key 为 resolved 绝对路径字符串，
# value 为 (落盘时的磁盘快照或 None, 提案完整内容)。None 表示整文件覆写，
# 不依赖磁盘快照。str_replace 以最新提案内容为基线，避免第二份提案
# 基于未含第一处修改的磁盘原文、确认落盘后吞掉前一处修改。
PendingProposalContents = dict[str, tuple[str | None, str]]


def write_workspace_file_tool(
    client_context: ClientContextInput | None,
    relative_path: str,
    content: str,
    pending_proposals: PendingProposalContents | None = None,
) -> str:
    """准备写文件提案：校验路径后返回 file_proposal 标记供 assist_service 转换为 SSE 事件。

    不直接写盘——写操作由前端在用户确认后执行。
    """
    resolved, err = resolve_workspace_write_path(client_context, relative_path)
    if resolved is None:
        return build_tool_result(
            ok=False,
            tool=WRITE_TOOL_NAME,
            status="error",
            summary=f"无法写入文件：{err}",
        )

    rel_display = _relative_display_path(client_context, resolved, relative_path)

    suffix = resolved.suffix.lower()
    if not is_allowed_text_extension(suffix):
        return build_tool_result(
            ok=False,
            tool=WRITE_TOOL_NAME,
            status="error",
            summary=(
                f"write_workspace_file 不支持后缀 {suffix!r}（二进制/富媒体格式）。"
                f"请使用 UTF-8 文本或代码文件。"
            ),
        )

    title = resolved.stem.replace("-", " ").replace("_", " ").title()
    summary = (
        f"已生成文件提案：{rel_display}。"
        "文件尚未写入磁盘；用户确认（Keep All）后才会落盘。"
        "请勿在回复中声称文件已创建或已保存。"
    )
    if pending_proposals is not None:
        pending_proposals[str(resolved)] = (None, content)
    return build_tool_result(
        ok=True,
        tool=WRITE_TOOL_NAME,
        status="proposal_ready",
        summary=summary,
        file_written=False,
        proposal_pending=True,
        **{
            DOC_PROPOSAL_MARKER: True,
            "relative_path": rel_display,
            "title": title,
            "content": content,
            "operation": "write",
        },
    )


def str_replace_workspace_file_tool(
    client_context: ClientContextInput | None,
    relative_path: str,
    old_string: str,
    new_string: str,
    replace_all: bool = False,
    pending_proposals: PendingProposalContents | None = None,
) -> str:
    """在已有文本文件中做精确替换，生成完整新内容的 file_proposal。"""
    resolved, err = resolve_workspace_file(client_context, relative_path)
    if resolved is None:
        # 文件在磁盘上不存在：若同路径已有未落盘的 write 提案，
        # 则以提案为基线继续（否则保持原有报错）。
        if pending_proposals is not None:
            write_resolved, _ = resolve_workspace_write_path(
                client_context, relative_path
            )
            if write_resolved is not None and str(write_resolved) in pending_proposals:
                resolved = write_resolved
        if resolved is None:
            return build_tool_result(
                ok=False,
                tool=STR_REPLACE_TOOL_NAME,
                status="error",
                summary=f"无法读取文件：{err}",
            )

    suffix = resolved.suffix.lower()
    if not is_allowed_text_extension(suffix):
        return build_tool_result(
            ok=False,
            tool=STR_REPLACE_TOOL_NAME,
            status="error",
            summary=f"不支持后缀 {suffix!r}，请使用 UTF-8 文本或代码文件。",
        )

    if not old_string:
        return build_tool_result(
            ok=False,
            tool=STR_REPLACE_TOOL_NAME,
            status="error",
            summary="old_string 不能为空。",
        )

    try:
        original = resolved.read_text(encoding="utf-8")
    except FileNotFoundError:
        # write 提案尚未落盘：以空字符串作为磁盘快照参与基线判断
        original = ""
    except UnicodeDecodeError:
        try:
            original = resolved.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            return build_tool_result(
                ok=False,
                tool=STR_REPLACE_TOOL_NAME,
                status="error",
                summary="文件不是 UTF-8 文本。",
            )
    except OSError as exc:
        return build_tool_result(
            ok=False,
            tool=STR_REPLACE_TOOL_NAME,
            status="error",
            summary=f"读取失败：{exc}",
        )

    # 基线接力：同路径已有未落盘提案且磁盘未再被改动时，以提案内容为基线，
    # 使本轮的多处修改在同一份提案里累积。
    base = original
    base_from_pending = False
    if pending_proposals is not None:
        pending = pending_proposals.get(str(resolved))
        if pending is not None:
            pending_disk_snap, pending_content = pending
            if pending_disk_snap is None or pending_disk_snap == original:
                base = pending_content
                base_from_pending = True
            else:
                # 磁盘在提案生成后又被改动（如用户手动保存），旧提案基线过期。
                pending_proposals.pop(str(resolved), None)

    count = base.count(old_string)
    if count == 0:
        hint = (
            "（注意：本轮对该文件已有未落盘的提案，替换基线是提案内容而非磁盘原文，"
            "read_workspace_file 读到的磁盘原文可能不含此前提案的修改）"
            if base_from_pending
            else ""
        )
        first_line = old_string.splitlines()[0][:80] if old_string else ""
        return build_tool_result(
            ok=False,
            tool=STR_REPLACE_TOOL_NAME,
            status="error",
            summary=(
                f"未找到 old_string（首行：{first_line}）。"
                "常见原因：缩进/空白字符与原文不一致，或该处内容已变化。"
                "请先用 read_workspace_file 核对目标段落，原样复制（含缩进）后重试。"
                f"{hint}"
            ),
        )
    if count > 1 and not replace_all:
        return build_tool_result(
            ok=False,
            tool=STR_REPLACE_TOOL_NAME,
            status="error",
            summary=(
                f"old_string 出现 {count} 次。请前后多带几行上下文使片段唯一；"
                "确需替换全部出现时设 replace_all=true。"
            ),
        )

    content = base.replace(old_string, new_string) if replace_all else base.replace(
        old_string, new_string, 1
    )
    if pending_proposals is not None:
        pending_proposals[str(resolved)] = (original, content)
    rel_display = _relative_display_path(client_context, resolved, relative_path)
    title = resolved.stem.replace("-", " ").replace("_", " ").title()
    summary = (
        f"已生成补丁提案：{rel_display}（替换 {count if replace_all else 1} 处）。"
        "文件尚未写入磁盘；用户确认（Keep All）后才会落盘。"
    )
    return build_tool_result(
        ok=True,
        tool=STR_REPLACE_TOOL_NAME,
        status="proposal_ready",
        summary=summary,
        file_written=False,
        proposal_pending=True,
        **{
            DOC_PROPOSAL_MARKER: True,
            "relative_path": rel_display,
            "title": title,
            "content": content,
            "operation": "write",
        },
    )


def delete_workspace_file_tool(
    client_context: ClientContextInput | None,
    relative_path: str,
    pending_proposals: PendingProposalContents | None = None,
) -> str:
    """准备删除文本文件的提案；用户确认后才删盘。"""
    resolved, err = resolve_workspace_file(client_context, relative_path)
    if resolved is None:
        return build_tool_result(
            ok=False,
            tool=DELETE_TOOL_NAME,
            status="error",
            summary=f"无法删除文件：{err}",
        )

    write_resolved, write_err = resolve_workspace_write_path(
        client_context, relative_path
    )
    if write_resolved is None:
        return build_tool_result(
            ok=False,
            tool=DELETE_TOOL_NAME,
            status="error",
            summary=f"无法删除文件：{write_err}",
        )

    suffix = resolved.suffix.lower()
    if not is_allowed_text_extension(suffix):
        return build_tool_result(
            ok=False,
            tool=DELETE_TOOL_NAME,
            status="error",
            summary=f"不支持删除后缀 {suffix!r}。",
        )

    rel_display = _relative_display_path(client_context, resolved, relative_path)
    title = f"删除 {resolved.name}"
    summary = (
        f"已生成删除提案：{rel_display}。"
        "文件尚未删除；用户确认（Keep All）后才会从磁盘移除。"
    )
    if pending_proposals is not None:
        pending_proposals.pop(str(resolved), None)
    return build_tool_result(
        ok=True,
        tool=DELETE_TOOL_NAME,
        status="proposal_ready",
        summary=summary,
        file_written=False,
        proposal_pending=True,
        **{
            DOC_PROPOSAL_MARKER: True,
            "relative_path": rel_display,
            "title": title,
            "content": "",
            "operation": "delete",
        },
    )


def move_workspace_file_tool(
    client_context: ClientContextInput | None,
    relative_path: str,
    new_relative_path: str,
    pending_proposals: PendingProposalContents | None = None,
) -> str:
    """准备移动/重命名文件的提案；用户确认后才在磁盘执行。"""
    resolved, err = resolve_workspace_file(client_context, relative_path)
    if resolved is None:
        return build_tool_result(
            ok=False,
            tool=MOVE_TOOL_NAME,
            status="error",
            summary=f"无法移动文件：{err}",
        )

    suffix = resolved.suffix.lower()
    if not is_allowed_text_extension(suffix):
        return build_tool_result(
            ok=False,
            tool=MOVE_TOOL_NAME,
            status="error",
            summary=f"不支持移动后缀 {suffix!r} 的文件。",
        )

    new_raw = (new_relative_path or "").strip()
    if not new_raw:
        return build_tool_result(
            ok=False,
            tool=MOVE_TOOL_NAME,
            status="error",
            summary="new_relative_path 不能为空。",
        )

    target, err = resolve_workspace_write_path(client_context, new_raw)
    if target is None:
        return build_tool_result(
            ok=False,
            tool=MOVE_TOOL_NAME,
            status="error",
            summary=f"目标路径无效：{err}",
        )

    if target == resolved:
        return build_tool_result(
            ok=False,
            tool=MOVE_TOOL_NAME,
            status="error",
            summary="目标路径与原路径相同，无需移动。",
        )
    if target.exists():
        return build_tool_result(
            ok=False,
            tool=MOVE_TOOL_NAME,
            status="error",
            summary=f"目标已存在：{relative_display_path(client_context, target, new_raw)}。请换一个目标路径。",
        )
    target_suffix = target.suffix.lower()
    if not is_allowed_text_extension(target_suffix):
        return build_tool_result(
            ok=False,
            tool=MOVE_TOOL_NAME,
            status="error",
            summary=f"目标后缀 {target_suffix!r} 不受支持，请使用 UTF-8 文本或代码文件。",
        )

    old_display = _relative_display_path(client_context, resolved, relative_path)
    new_display = _relative_display_path(client_context, target, new_raw)
    title = f"移动 {resolved.name}"
    summary = (
        f"已生成移动/重命名提案：{old_display} → {new_display}。"
        "文件尚未改动；用户确认（Keep All）后才会在磁盘执行。"
    )
    if pending_proposals is not None:
        pending_proposals.pop(str(resolved), None)
        pending_proposals.pop(str(target), None)
    return build_tool_result(
        ok=True,
        tool=MOVE_TOOL_NAME,
        status="proposal_ready",
        summary=summary,
        file_written=False,
        proposal_pending=True,
        **{
            DOC_PROPOSAL_MARKER: True,
            "relative_path": new_display,
            "old_path": old_display,
            "title": title,
            "content": "",
            "operation": "rename",
        },
    )


def extract_doc_proposal_from_tool_result(
    tool_name: str, result_text: str
) -> dict | None:
    """从写/补丁/删除工具结果中提取文档提案数据。"""
    if tool_name not in FILE_PROPOSAL_TOOLS:
        return None
    try:
        data = json.loads(result_text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not data.get(DOC_PROPOSAL_MARKER):
        return None
    operation = str(data.get("operation") or "write")
    if operation not in ("write", "delete", "rename"):
        operation = "write"
    return {
        "relative_path": str(data.get("relative_path") or "document.md"),
        "title": str(data.get("title") or "文档"),
        "content": str(data.get("content") or ""),
        "operation": operation,
        "old_path": str(data.get("old_path") or ""),
    }


def format_write_tool_result_for_display(result_text: str) -> str:
    return format_tool_result_for_display(result_text)
