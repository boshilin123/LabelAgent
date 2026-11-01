# 学习导航：质量报告流式接口：校验输入体积、创建模型，再把服务产生的文字事件编码成 SSE。
import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from langchain_openai import ChatOpenAI

from app.agent.annotation.quality_report_compose_service import (
    stream_quality_report_compose,
)
from app.agent.text_sanitize import sanitize_json_value
from app.core.deps import SettingsDep
from app.schemas.annotation_quality import QualityReportComposeRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent/annotation-quality", tags=["annotation-quality"])


# 检查模型连接配置并创建开启流式输出的 ChatOpenAI 实例。
def _require_direct_llm(
    *,
    api_key: str,
    base_url: str,
    model: str,
) -> ChatOpenAI:
    if not api_key.strip() or not base_url.strip() or not model.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="provider_credentials_required",
        )
    return ChatOpenAI(
        model=model.strip(),
        api_key=api_key.strip(),
        base_url=base_url.strip().rstrip("/"),
        streaming=True,
        temperature=0.2,
        timeout=120,
    )


# 按 UTF-8 编码后的字节数检查报告输入体积，过大则返回 400。
def _validate_compose_payload(payload: dict, settings: SettingsDep) -> None:
    payload_bytes = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    max_bytes = 512_000
    if payload_bytes > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="compose_payload_too_large",
        )


# 逐个转发报告事件，成功时追加 done；异常时记录日志并发送 error 事件。
async def _compose_sse(
    llm,
    *,
    compose_payload: dict,
    settings: SettingsDep,
) -> AsyncIterator[str]:
    try:
        async for event in stream_quality_report_compose(
            llm,
            compose_payload=compose_payload,
        ):
            yield f"data: {json.dumps(event.to_sse_dict(), ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'type': 'done'}, ensure_ascii=False)}\n\n"
    except Exception:
        logger.exception("quality_report_compose_stream_error")
        err = {"type": "error", "message": "quality_report_compose_failed"}
        if settings.debug:
            err["detail"] = "quality_report_compose_failed"
        yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"


# HTTP 入口：先校验和清洗质量数据，再返回逐段生成报告的 StreamingResponse。
@router.post("/report/compose/stream", summary="流式撰写标注质量报告")
async def api_quality_report_compose_stream(
    body: QualityReportComposeRequest,
    settings: SettingsDep,
) -> StreamingResponse:
    _validate_compose_payload(body.compose_payload, settings)

    llm = _require_direct_llm(
        api_key=body.api_key,
        base_url=body.base_url,
        model=body.model,
    )

    return StreamingResponse(
        _compose_sse(
            llm,
            compose_payload=sanitize_json_value(body.compose_payload),
            settings=settings,
        ),
        media_type="text/event-stream",
    )
