"""llm-generate 图片处理：路径优先、统一压缩为 JPEG、无法加载时 400。"""

import base64
import io

import pytest
from fastapi import HTTPException
from PIL import Image

from app.api.v1.annotation_agent import _build_generate_image_data_url
from app.schemas.annotation_agent import LlmGenerateRequest


class _Settings:
    annotation_llm_image_max_edge = 1280
    annotation_llm_image_jpeg_quality = 85


def _png_bytes(width: int, height: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


def _request(**overrides) -> LlmGenerateRequest:
    base = {
        "provider_id": "p1",
        "api_key": "k",
        "base_url": "https://example.com",
        "model": "m",
        "user_prompt": "描述图片",
    }
    base.update(overrides)
    return LlmGenerateRequest(**base)


def _decode_jpeg(data_url: str) -> Image.Image:
    assert data_url.startswith("data:image/jpeg;base64,")
    raw = base64.b64decode(data_url.split(",", 1)[1])
    image = Image.open(io.BytesIO(raw))
    image.load()
    return image


def test_no_image_returns_empty() -> None:
    assert _build_generate_image_data_url(_request(), _Settings()) == ""


def test_base64_image_is_resized_to_jpeg() -> None:
    big = _png_bytes(2400, 1200)
    body = _request(image_base64=base64.b64encode(big).decode("ascii"))
    data_url = _build_generate_image_data_url(body, _Settings())
    image = _decode_jpeg(data_url)
    assert max(image.size) <= 1280
    assert image.size == (1280, 640)


def test_data_url_prefix_is_stripped() -> None:
    raw = _png_bytes(100, 50)
    body = _request(
        image_base64=f"data:image/png;base64,{base64.b64encode(raw).decode('ascii')}"
    )
    image = _decode_jpeg(_build_generate_image_data_url(body, _Settings()))
    assert image.size == (100, 50)


def test_absolute_path_takes_precedence(tmp_path) -> None:
    path = tmp_path / "a.png"
    path.write_bytes(_png_bytes(2000, 2000))
    body = _request(
        image_absolute_path=str(path),
        image_base64=base64.b64encode(_png_bytes(10, 10)).decode("ascii"),
    )
    image = _decode_jpeg(_build_generate_image_data_url(body, _Settings()))
    # 来自路径的 2000px 图被缩放，而非 base64 的 10px 图
    assert image.size == (1280, 1280)


def test_unloadable_image_raises_400() -> None:
    body = _request(image_absolute_path="/nonexistent/x.png")
    with pytest.raises(HTTPException) as exc_info:
        _build_generate_image_data_url(body, _Settings())
    assert exc_info.value.status_code == 400
