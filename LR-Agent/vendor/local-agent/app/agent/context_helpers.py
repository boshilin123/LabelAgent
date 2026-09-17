"""客户端上下文提取与格式化工具。

从 ClientContextInput 中统一读取标注项目、工作区路径等字段，供下游模块复用：
  - tools/workspace_path、tools/registry：解析项目目录作为文件读取的根路径
"""

from __future__ import annotations

from app.schemas.agent import ClientContextInput


def project_directory(client_context: ClientContextInput | None) -> str | None:
    """获取标注项目目录绝对路径，优先 client_context，其次快照内字段。"""
    if client_context is None:
        return None
    direct = (client_context.project_directory_path or "").strip()
    if direct:
        return direct
    snap = client_context.annotation_project_snapshot
    if snap and getattr(snap, "project_directory_path", None):
        return str(snap.project_directory_path).strip() or None
    return None
