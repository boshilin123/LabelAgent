# 学习导航：读取本地项目的已有标注文档；每张图片的标注保存在 .lr-agent/annotations/files 下的 JSON 文件中。
"""Read per-file annotation JSON from project .lr-agent/annotations (Electron co-located API)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

PROJECT_HIDDEN = ".lr-agent"
ANNOTATIONS_DIR = "annotations"
FILES_DIR = "files"


# 统一斜杠并去掉空路径段，让相同写法的相对路径使用一致的标注文件键。
def normalize_relative_path(relative_path: str) -> str:
    return "/".join(part for part in relative_path.replace("\\", "/").split("/") if part)


# 对归一化后的图片相对路径计算 SHA-256，作为标注 JSON 文件名；这里不读取或哈希图片内容。
def compute_file_key(relative_path: str) -> str:
    normalized = normalize_relative_path(relative_path)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# 拼出项目内部的标注文件目录，便于其他读取函数复用。
def annotations_files_dir(project_dir: str) -> Path:
    return Path(project_dir) / PROJECT_HIDDEN / ANNOTATIONS_DIR / FILES_DIR


# 根据图片相对路径定位标注 JSON，返回（文档字典或 None，错误/说明文字）。
def read_file_annotation_doc(project_dir: str, relative_path: str) -> tuple[dict | None, str]:
    """
    Return (document dict or None, error/detail message).
    """
    root = (project_dir or "").strip()
    if not root:
        return None, "未提供项目目录路径（project_directory_path）。"

    rel = normalize_relative_path(relative_path.strip())
    if not rel:
        return None, "请提供相对路径（如 data/2.jpg）。"

    base = Path(root)
    if not base.is_dir():
        return None, f"项目目录不可读：{root}"

    file_key = compute_file_key(rel)
    doc_path = annotations_files_dir(root) / f"{file_key}.json"
    if not doc_path.is_file():
        return None, f"未找到 {rel} 的标注文件（可能尚未标注）。"

    try:
        data = json.loads(doc_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"读取标注失败：{exc}"

    if not isinstance(data, dict):
        return None, "标注文件格式无效。"
    return data, ""
