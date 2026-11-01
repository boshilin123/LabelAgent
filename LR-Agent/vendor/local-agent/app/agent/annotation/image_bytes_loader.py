# 学习导航：统一加载与压缩图片，供视觉标注、候选预筛和生成类接口共用。
"""图像字节加载：从本地绝对路径或 base64 获取原始图像数据。

Electron 客户端与后端 API 同机部署时优先读 image_absolute_path；
否则回退 image_base64。供 map_labels_service 裁剪、chat_message_builder 多模态消息使用。
"""

from __future__ import annotations

import base64
import io
from pathlib import Path


# 优先从本地绝对路径读取，失败时尝试 base64；返回（图片字节或 None，来源标记）。
def load_image_bytes(
    *,
    image_absolute_path: str = "",
    image_base64: str = "",
) -> tuple[bytes | None, str]:
    """加载图像字节，返回 (bytes, source)，source 为 path | base64 | none。"""
    path_str = (image_absolute_path or "").strip()
    if path_str:
        try:
            path = Path(path_str)
            if path.is_file():
                return path.read_bytes(), "path"
        except OSError:
            pass

    raw = (image_base64 or "").strip()
    if not raw:
        return None, "none"
    try:
        if "," in raw[:80]:
            raw = raw.split(",", 1)[1]
        return base64.b64decode(raw), "base64"
    except Exception:
        return None, "none"


# 等比限制最长边、处理透明背景并编码为 JPEG，返回（压缩字节，MIME 类型）。
def resize_image_to_jpeg_bytes(
    raw: bytes,
    *,
    max_edge: int,
    jpeg_quality: int,
) -> tuple[bytes, str]:
    """等比缩放并编码为 JPEG，返回 (jpeg_bytes, mime)。"""
    from PIL import Image

    image = Image.open(io.BytesIO(raw))
    if image.mode not in ("RGB",):
        if image.mode in ("RGBA", "LA", "P"):
            background = Image.new("RGB", image.size, (255, 255, 255))
            if image.mode == "P":
                image = image.convert("RGBA")
            background.paste(
                image,
                mask=image.split()[-1] if image.mode == "RGBA" else None,
            )
            image = background
        else:
            image = image.convert("RGB")
    w, h = image.size
    scale = min(1.0, max_edge / max(w, h))
    if scale < 1.0:
        image = image.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True)
    return buffer.getvalue(), "image/jpeg"


# 先压缩再转成 base64 data URL，让多模态接口可以把图片放在 image_url 字段。
def image_bytes_to_data_url(
    raw: bytes,
    *,
    max_edge: int,
    jpeg_quality: int,
) -> str:
    jpeg_bytes, mime = resize_image_to_jpeg_bytes(
        raw,
        max_edge=max_edge,
        jpeg_quality=jpeg_quality,
    )
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    return f"data:{mime};base64,{b64}"
