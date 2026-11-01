# 学习导航：标注相关 HTTP 接口：参数验证与模型对象创建在接口层，计划/映射等计算交给 annotation 服务层。
# 这些是专项服务接口，不是父 Agent 的 create_agent 工厂。
import base64
import logging

from fastapi import APIRouter, HTTPException, status
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from openai import BadRequestError

from app.agent.annotation import (
    heuristic_map_boxes,
    map_detection_boxes_to_labels_unified,
    prepare_batch_annotation,
)
from app.agent.annotation.debug_log import log_annotation_agent
from app.agent.annotation.image_bytes_loader import (
    image_bytes_to_data_url,
    load_image_bytes,
)
from app.agent.annotation.mutation_prepare_service import prepare_mutation_annotation
from app.agent.annotation.schemas import AnnotationScopePayload
from app.core.deps import SettingsDep
from app.schemas.annotation_agent import (
    BatchPrepareRequest,
    HeuristicMapRequest,
    LlmGenerateRequest,
    MapDetectionBoxesRequest,
    MutationPrepareRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent/annotation", tags=["agent-annotation"])


# 把模型错误转换成 HTTP 错误：请求参数问题用 400，其他上游调用失败通常用 502。
def _http_from_llm_error(exc: Exception) -> HTTPException:
    msg = str(exc)
    if isinstance(exc, BadRequestError):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=msg or "llm_bad_request",
        )
    if "response_format" in msg.lower() or "json_schema" in msg.lower():
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="当前模型不支持结构化输出，请使用普通对话模型或更换提供商",
        )
    logger.exception("annotation_llm_error")
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=msg[:500] if msg else "llm_invoke_failed",
    )


# 检查请求传来的模型配置并创建 ChatOpenAI；实际网络请求在后续 ainvoke/astream 时发生。
def _require_direct_llm(
    *,
    api_key: str,
    base_url: str,
    model: str,
    temperature: float,
    streaming: bool = False,
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
        streaming=streaming,
        temperature=temperature,
        timeout=120,
    )


# 不用 LLM，直接以检测类名/OCR 规则尝试映射标签。
@router.post("/map-heuristic", summary="启发式检测框映射（无 LLM）")
async def api_map_heuristic(
    body: HeuristicMapRequest,
):
    mappings = heuristic_map_boxes(
        body.boxes,
        body.label_candidates,
        ocr_text=body.ocr_text,
    )
    return {"data": {"mappings": mappings, "method": "heuristic"}}


# 把请求中的候选文件、标签和选中实例交给修改准备服务，返回结构化操作。
@router.post("/mutation-prepare", summary="标注变更准备（改标签/删框，单次 LLM）")
async def api_mutation_prepare(
    body: MutationPrepareRequest,
    settings: SettingsDep,
):
    if not settings.agent_mutation_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="agent_mutation_disabled",
        )
    try:
        llm = _require_direct_llm(
            api_key=body.api_key,
            base_url=body.base_url,
            model=body.model,
            temperature=settings.annotation_prepare_temperature,
        )
        label_names = None
        if body.project is not None:
            label_names = [
                str(label.get("name") or "")
                for label in (body.project.labels or [])
                if str(label.get("name") or "").strip()
            ]

        result = await prepare_mutation_annotation(
            llm,
            user_request=body.user_request,
            current_relative_path=(body.current_relative_path or "").strip(),
            candidates=[candidate.model_dump() for candidate in body.candidates],
            label_names=label_names or [],
            selected_annotation_ids=body.selected_annotation_ids or None,
            conversation_transcript=body.conversation_transcript,
        )
        return {
            "data": {
                **result.model_dump(),
                "resolved_user_request": body.user_request,
            }
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise _http_from_llm_error(exc) from exc


# 为规划场景调用一次批量准备服务，返回有效选图与计划；此接口不直接运行检测和写盘。
@router.post("/batch-prepare", summary="批量准备（范围+计划，单次 LLM）")
async def api_batch_prepare(
    body: BatchPrepareRequest,
    settings: SettingsDep,
):
    try:
        llm = _require_direct_llm(
            api_key=body.api_key,
            base_url=body.base_url,
            model=body.model,
            temperature=settings.annotation_prepare_temperature,
        )
        provider_is_vision = body.supports_vision

        label_names = None
        project_name = None
        if body.project is not None:
            project_name = body.project.name or None
            label_names = [
                str(label.get("name") or "")
                for label in (body.project.labels or [])
                if str(label.get("name") or "").strip()
            ]

        current_rel = (body.current_relative_path or "").strip()
        candidates = [candidate.model_dump() for candidate in body.candidates]
        result = await prepare_batch_annotation(
            llm,
            user_request=body.user_request,
            current_relative_path=current_rel,
            candidates=candidates,
            label_candidates=body.label_candidates,
            detection_models=body.detection_models,
            default_conf=body.default_conf_threshold,
            default_iou=body.default_iou_threshold,
            provider_is_vision=provider_is_vision,
            project_name=project_name,
            label_names=label_names,
            conversation_transcript=body.conversation_transcript,
            preselected_paths=body.preselected_paths or None,
        )
        payload = {
            "selected_paths": result.selected_paths,
            "scope_reason": result.scope_reason,
            "resolved_user_request": body.user_request,
            **result.plan.model_dump(),
        }
        return {"data": payload}
    except HTTPException:
        raise
    except Exception as exc:
        raise _http_from_llm_error(exc) from exc


# 根据 use_vision 与 supports_vision 决定是否创建视觉模型，再交给统一映射服务。
@router.post("/map-detection-boxes", summary="Fusion 统一检测框映射（启发式或逐框视觉）")
async def api_map_detection_boxes(
    body: MapDetectionBoxesRequest,
    settings: SettingsDep,
):
    try:
        provider_is_vision = body.supports_vision
        use_vision_requested = bool(body.use_vision)
        # 用户想用视觉与声明的模型能力同时满足才启用，否则走无视觉的映射路径。
        use_vision = use_vision_requested and provider_is_vision
        llm = None
        if use_vision:
            llm = _require_direct_llm(
                api_key=body.api_key,
                base_url=body.base_url,
                model=body.model,
                temperature=settings.annotation_llm_temperature,
            )
        log_annotation_agent(
            "map-api",
            "map-detection-boxes 请求",
            provider_id=body.provider_id,
            provider_name=body.model,
            provider_model=body.model,
            provider_is_vision=provider_is_vision,
            vision_probe_detail="direct",
            use_vision_requested=use_vision_requested,
            use_vision_effective=use_vision,
            box_count=len(body.boxes),
            has_image_bytes=bool(
                load_image_bytes(
                    image_absolute_path=body.image_absolute_path,
                    image_base64=body.image_base64,
                )[0]
            ),
            image_absolute_path=bool(body.image_absolute_path.strip()),
            label_names=[
                str(candidate.get("name") or "")
                for candidate in (body.label_candidates or [])[:20]
            ],
        )
        scope = AnnotationScopePayload.model_validate(body.annotation_scope or {})
        result = await map_detection_boxes_to_labels_unified(
            llm,
            user_request=body.user_request,
            intent_summary=body.intent_summary,
            label_candidates=body.label_candidates,
            boxes=body.boxes,
            use_vision=use_vision,
            ocr_text=body.ocr_text,
            scope=scope,
            label_strategy=body.label_strategy,
            single_label_id=body.single_label_id,
            image_absolute_path=body.image_absolute_path,
            image_base64=body.image_base64,
            mime_type=body.mime_type,
        )
        log_annotation_agent(
            "map-api-result",
            "map-detection-boxes 响应",
            ok=result.get("ok"),
            method=result.get("method"),
            mapped=len(result.get("mappings") or [])
            - len(result.get("unmapped_indices") or []),
            unmapped=len(result.get("unmapped_indices") or []),
            label_pool_source=result.get("label_pool_source"),
            hint=result.get("hint"),
        )
        return {"data": result}
    except HTTPException:
        raise
    except Exception as exc:
        raise _http_from_llm_error(exc) from exc


# 优先读本地图片，base64 兜底，压缩后生成 data URL；明确传图但读取失败时返回 400。
def _build_generate_image_data_url(
    body: LlmGenerateRequest,
    settings,
) -> str:
    """组装 llm-generate 的多模态图片 data URL。

    路径优先、base64 兜底；统一压缩为 JPEG（长边 / 质量见 Settings）。
    请求声明了图片但字节无法加载时抛 400，让前端跳过该文件（与旧的前端读图
    失败行为一致）；压缩失败则回退发送未压缩原图。
    """
    wants_image = bool(
        (body.image_absolute_path or "").strip() or (body.image_base64 or "").strip()
    )
    if not wants_image:
        return ""

    raw, _source = load_image_bytes(
        image_absolute_path=body.image_absolute_path,
        image_base64=body.image_base64,
    )
    if raw is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="image_load_failed",
        )
    try:
        return image_bytes_to_data_url(
            raw,
            max_edge=settings.annotation_llm_image_max_edge,
            jpeg_quality=settings.annotation_llm_image_jpeg_quality,
        )
    except Exception:
        logger.warning("llm-generate image resize failed, send raw", exc_info=True)
        return f"data:{body.image_mime_type};base64,{base64.b64encode(raw).decode('ascii')}"


# 为 caption 等生成任务组装系统/用户消息和可选图片，等待完整响应后返回文字内容。
@router.post("/llm-generate", summary="通用 LLM 生成代理（caption/cot/instruction 等）")
async def api_llm_generate(
    body: LlmGenerateRequest,
    settings: SettingsDep,
):
    try:
        llm = _require_direct_llm(
            api_key=body.api_key,
            base_url=body.base_url,
            model=body.model,
            temperature=body.temperature,
        )
        # bind 在本次调用对象上附加输出 token 上限，还没有发送模型请求。
        llm = llm.bind(max_tokens=body.max_tokens)

        messages = []
        if body.system_prompt.strip():
            messages.append(SystemMessage(content=body.system_prompt))

        image_data_url = _build_generate_image_data_url(body, settings)
        if image_data_url:
            human_content = [
                {"type": "text", "text": body.user_prompt or ""},
                {
                    "type": "image_url",
                    "image_url": {"url": image_data_url},
                },
            ]
            messages.append(HumanMessage(content=human_content))
        else:
            messages.append(HumanMessage(content=body.user_prompt or ""))

        resp = await llm.ainvoke(messages)
        content = resp.content if hasattr(resp, "content") else str(resp)
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in content
            )
        return {"data": {"ok": True, "content": str(content)}}
    except HTTPException:
        raise
    except Exception as exc:
        raise _http_from_llm_error(exc) from exc
