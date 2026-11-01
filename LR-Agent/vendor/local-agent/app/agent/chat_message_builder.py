# 学习导航：把本地图片或图片字节转成模型接口需要的多模态 HumanMessage。
"""Build LangChain messages including optional vision attachment for the latest user turn."""

from __future__ import annotations

import asyncio
import base64

from langchain_core.messages import HumanMessage

from app.agent.annotation.image_bytes_loader import load_image_bytes, resize_image_to_jpeg_bytes


# 统一复用图片压缩逻辑，返回（JPEG 字节，MIME 类型），控制发送给模型的数据量。
def _resize_image_bytes(
    raw: bytes,
    *,
    max_edge: int,
    jpeg_quality: int,
) -> tuple[bytes, str]:
    return resize_image_to_jpeg_bytes(raw, max_edge=max_edge, jpeg_quality=jpeg_quality)


# 同步读取、压缩并编码图片，返回可放进 image_url 的 data URL。
def _encode_image_data_url(
    *,
    image_absolute_path: str,
    image_base64: str,
    max_edge: int,
    jpeg_quality: int,
) -> str | None:
    """同步重活：读盘 + 解码 + 缩放 + JPEG 编码 + base64。

    单独抽出来是为了能整体丢进线程池执行。
    """
    raw, _source = load_image_bytes(
        image_absolute_path=image_absolute_path,
        image_base64=image_base64,
    )
    if raw is None:
        return None

    try:
        jpeg_bytes, mime = _resize_image_bytes(
            raw,
            max_edge=max_edge,
            jpeg_quality=jpeg_quality,
        )
    except Exception:
        return None

    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    return f"data:{mime};base64,{b64}"


# 异步构建“文字 + 图片”消息；耗时的读盘和压缩放在线程中执行，失败时保留文字消息。
async def build_multimodal_user_message(
    text: str,
    *,
    image_absolute_path: str = "",
    image_base64: str = "",
    max_edge: int = 1280,
    jpeg_quality: int = 85,
) -> HumanMessage:
    """构造带附图的多模态消息。

    图片解码与编码是 CPU 密集的同步操作，大图可达数百毫秒；丢到线程池执行，
    避免阻塞事件循环（否则会卡住同进程内其它会话的 SSE 流）。
    """
    data_url = await asyncio.to_thread(
        _encode_image_data_url,
        image_absolute_path=image_absolute_path,
        image_base64=image_base64,
        max_edge=max_edge,
        jpeg_quality=jpeg_quality,
    )
    if data_url is None:
        return HumanMessage(content=text)

    content: list[dict] = [
        {"type": "text", "text": text},
        {"type": "image_url", "image_url": {"url": data_url}},
    ]
    return HumanMessage(content=content)
