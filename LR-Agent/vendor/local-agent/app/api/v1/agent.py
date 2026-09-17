"""Agent API — stateless Assist chat/stream for tool-enabled sessions.

Session/chat CRUD and LLM provider config live in the Electron frontend
(local SQLite storage + direct LLM API calls for simple chat).
"""

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI

from app.agent import assist_service, chat_service
from app.agent.assist.task_phase import (
    derive_task_phase,
    phase_prompt_block,
)
from app.agent.assist_mode_router import resolve_assist_tool_set
from app.agent.context_service import CHAT_SYSTEM_PROMPT
from app.agent.context_snapshot import (
    build_assist_system_prompt,
    format_runtime_identity_block,
)
from app.agent.tools.mcp_client import (
    load_mcp_tools_from_servers,
    probe_mcp_tools,
    should_expose_mcp_tool,
)
from app.agent.tools.registry import build_tools_by_name_set
from app.agent.tools.tool_registry_meta import CANONICAL_CAPABILITIES
from app.core.deps import SettingsDep
from app.models.user import User
from app.schemas.agent import (
    ChatCancelRequest,
    ClientContextInput,
    LocalChatStreamRequest,
    McpProbeRequest,
    StreamEventPayload,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])

_cancel_events: dict[str, asyncio.Event] = {}


def _get_or_create_cancel_event(client_job_id: str) -> asyncio.Event:
    if client_job_id not in _cancel_events:
        _cancel_events[client_job_id] = asyncio.Event()
    return _cancel_events[client_job_id]


def _cleanup_cancel_event(client_job_id: str) -> None:
    _cancel_events.pop(client_job_id, None)


def _anonymous_user() -> User:
    """Minimal anonymous User for tool building in stateless mode."""
    import uuid

    return User(
        id=uuid.uuid4(),
        email="anonymous@local",
        email_verified=False,
        username="anonymous",
        display_name="本地匿名用户",
    )


def _build_lc_messages_from_local(
    body: LocalChatStreamRequest,
    system_prompt: str,
) -> list:
    """Build LangChain messages from LocalChatStreamRequest (no DB dependency)."""
    lc_messages: list = [SystemMessage(content=system_prompt)]

    if body.context_summary:
        lc_messages.append(
            SystemMessage(content=f"【此前对话摘要】\n{body.context_summary}"),
        )

    for item in body.messages:
        if item.role == "user":
            lc_messages.append(
                HumanMessage(content=item.content or "")
            )

        elif item.role == "assistant":
            tool_calls = [
                {
                    "id": tc.id,
                    "name": tc.name,
                    "args": tc.args,
                }
                for tc in (item.tool_calls or [])
            ]

            lc_messages.append(
                AIMessage(
                    content=item.content or "",
                    tool_calls=tool_calls,
                )
                if tool_calls
                else AIMessage(
                    content=item.content or ""
                )
            )

        elif item.role == "tool":
            if not (item.tool_call_id or "").strip():
                continue

            lc_messages.append(
                ToolMessage(
                    content=item.content or "",
                    tool_call_id=item.tool_call_id,
                )
            )

        elif item.role == "system":
            lc_messages.append(
                SystemMessage(content=item.content or "")
            )

    return lc_messages


async def _stream_local_chat(
    body: LocalChatStreamRequest,
    settings,
) -> Any:
    """无状态 chat/stream 生成器——所有数据从请求体获取，不读 DB。"""

    client_job_id: str = body.client_job_id
    cancel_event = _get_or_create_cancel_event(
        client_job_id
    )

    async def is_cancelled() -> bool:
        return cancel_event.is_set()

    try:
        base_url = body.base_url.rstrip("/")

        # DeepSeek Agent Tool Calling 暂时关闭 Thinking 模式，
        # 避免多轮工具调用时 reasoning_content 回传兼容问题
        deepseek_extra_body = (
            {
                "thinking": {
                    "type": "disabled"
                }
            }
            if (
                "deepseek" in body.model.lower()
                or "deepseek" in base_url.lower()
            )
            else None
        )

        llm = ChatOpenAI(
            model=body.model,
            api_key=body.api_key,
            base_url=base_url,
            streaming=True,
            temperature=0.7,
            timeout=120,
            extra_body=deepseek_extra_body,
        )

        # 辅助模型：
        # 子代理查阅等轻量调用使用；
        # 未配置时跟随主模型
        aux_llm: ChatOpenAI | None = None

        if (
            body.aux_model.strip()
            and body.aux_api_key.strip()
            and body.aux_base_url.strip()
        ):
            aux_base_url = (
                body.aux_base_url
                .strip()
                .rstrip("/")
            )

            aux_deepseek_extra_body = (
                {
                    "thinking": {
                        "type": "disabled"
                    }
                }
                if (
                    "deepseek"
                    in body.aux_model.lower()
                    or "deepseek"
                    in aux_base_url.lower()
                )
                else None
            )

            aux_llm = ChatOpenAI(
                model=body.aux_model.strip(),
                api_key=body.aux_api_key.strip(),
                base_url=aux_base_url,
                streaming=True,
                temperature=0.7,
                timeout=120,
                extra_body=aux_deepseek_extra_body,
            )

        client_ctx: ClientContextInput | None = (
            body.client_context
        )

        has_tools = bool(
            client_ctx
            and (
                (
                    client_ctx.workspace_root
                    or ""
                ).strip()
                or client_ctx.active_annotation_project_id
                or (
                    client_ctx.annotation_project_snapshot
                    is not None
                )
            )
        )

        if has_tools:
            user = _anonymous_user()

            # 标注任务阶段机：
            # 从结构化提案状态推导阶段
            # （无状态，每次请求重推导）
            task_phase_ctx = derive_task_phase(
                client_ctx.proposal_states
                if client_ctx
                else None,
            )

            identity = format_runtime_identity_block(
                model=body.model,
                provider_label="local",
                supports_vision=body.supports_vision,
            )

            if client_ctx:
                system_prompt = (
                    build_assist_system_prompt(
                        client_ctx,
                        model=body.model,
                        provider_label="local",
                        supports_vision=(
                            body.supports_vision
                        ),
                    )
                )
            else:
                system_prompt = (
                    f"{identity}\n\n"
                    f"{CHAT_SYSTEM_PROMPT}"
                )

            phase_block = phase_prompt_block(
                task_phase_ctx
            )

            if phase_block:
                system_prompt = (
                    f"{system_prompt}\n\n"
                    f"{phase_block}"
                )

            lc_messages = (
                _build_lc_messages_from_local(
                    body,
                    system_prompt,
                )
            )

            has_workspace = bool(
                client_ctx
                and (
                    client_ctx.workspace_root
                    or ""
                ).strip()
            )

            has_project_snapshot = bool(
                client_ctx
                and (
                    client_ctx.annotation_project_snapshot
                    is not None
                )
            )

            is_editor = bool(
                client_ctx
                and client_ctx.work_mode == "editor"
            )

            tool_set = resolve_assist_tool_set(
                has_project_snapshot=(
                    has_project_snapshot
                ),
                agent_mode=(
                    client_ctx.agent_mode
                    if client_ctx
                    else None
                ),
                is_editor=is_editor,
                has_workspace=has_workspace,
            )

            tools = build_tools_by_name_set(
                user,
                client_ctx,
                tool_set,
                settings=settings,
                provider_is_vision=(
                    body.supports_vision
                ),
            )

            mcp_url = (
                (
                    client_ctx.mcp_server_url
                    or ""
                ).strip()
                if client_ctx
                else ""
            )

            remote_mcp = (
                list(client_ctx.mcp_servers)
                if client_ctx
                else []
            )

            local_mcp_token = (
                (
                    client_ctx.mcp_server_token
                    or ""
                ).strip()
                if client_ctx
                else ""
            )

            if mcp_url or remote_mcp:
                # 先发一个 preparing 事件，
                # MCP 发现期间渲染层即有反馈
                yield (
                    "data: "
                    + json.dumps(
                        StreamEventPayload(
                            type="preparing",
                            stage="mcp",
                        ).to_sse_dict(),
                        ensure_ascii=False,
                    )
                    + "\n\n"
                )

                try:
                    mcp_tools = (
                        await load_mcp_tools_from_servers(
                            mcp_url or None,
                            remote_mcp,
                            local_server_token=(
                                local_mcp_token
                                or None
                            ),
                            existing_capabilities=(
                                CANONICAL_CAPABILITIES
                            ),
                            ttl_seconds=(
                                settings
                                .agent_mcp_tools_ttl_seconds
                            ),
                        )
                    )

                    if mcp_tools:
                        memory_on = bool(
                            client_ctx
                            and (
                                client_ctx
                                .workspace_memory_enabled
                            )
                        )

                        existing = {
                            t.name
                            for t in tools
                        }

                        tools = tools + [
                            t
                            for t in mcp_tools
                            if (
                                t.name
                                not in existing
                            )
                            and should_expose_mcp_tool(
                                t.name,
                                workspace_memory_enabled=(
                                    memory_on
                                ),
                                agent_mode=(
                                    client_ctx.agent_mode
                                    if client_ctx
                                    else None
                                ),
                            )
                        ]

                except Exception:
                    logger.warning(
                        "Failed to load MCP tools",
                        exc_info=True,
                    )

            # tools 列表保持稳定（按名称排序）：
            # 阶段门禁不在 bind 时增删工具，
            # 交由执行层 check_call_allowed 拦截
            # （tool_loop.py）
            tools = sorted(
                tools,
                key=lambda t: t.name,
            )

            stream = (
                assist_service.stream_assist(
                    llm,
                    lc_messages,
                    tools,
                    settings=settings,
                    max_tool_rounds=(
                        settings
                        .agent_max_tool_rounds
                    ),
                    is_cancelled=is_cancelled,
                    provider_is_vision=(
                        body.supports_vision
                    ),
                    client_context=client_ctx,
                    user_content=(
                        body.user_content
                    ),
                    client_tool_results=(
                        body.client_tool_results
                        or None
                    ),
                    task_phase_ctx=(
                        task_phase_ctx
                    ),
                    aux_llm=aux_llm,
                )
            )

        else:
            system_prompt = (
                body.system_prompt
                or CHAT_SYSTEM_PROMPT
            )

            lc_messages = (
                _build_lc_messages_from_local(
                    body,
                    system_prompt,
                )
            )

            stream = chat_service.stream_chat(
                llm,
                lc_messages,
            )

        async for event in stream:
            if await is_cancelled():
                break

            yield (
                "data: "
                + json.dumps(
                    event.to_sse_dict(),
                    ensure_ascii=False,
                )
                + "\n\n"
            )

        yield 'data: {"type": "done"}\n\n'

    finally:
        _cleanup_cancel_event(
            client_job_id
        )


@router.post("/chat/stream")
async def local_chat_stream(
    body: LocalChatStreamRequest,
    settings: SettingsDep,
) -> StreamingResponse:
    """无状态 chat/stream —— 所有数据从请求体获取，不读 DB。"""

    return StreamingResponse(
        _stream_local_chat(
            body,
            settings,
        ),
        media_type="text/event-stream",
    )


@router.post("/chat/cancel")
async def cancel_chat(
    body: ChatCancelRequest,
) -> dict[str, bool]:
    """取消正在进行的 chat/stream 任务。"""

    event = _cancel_events.get(
        body.client_job_id
    )

    if event:
        event.set()

    return {
        "ok": True
    }


@router.post("/mcp/probe")
async def probe_mcp_server(
    body: McpProbeRequest,
) -> dict:
    """连接单个 MCP Server 并列出工具名（配置页「测试连接」，不走 LLM）。"""

    url = body.url.strip()

    if not url.startswith(
        (
            "http://",
            "https://",
        )
    ):
        return {
            "ok": False,
            "error": (
                "仅支持 http(s) MCP 端点"
            ),
        }

    try:
        tools = await probe_mcp_tools(
            url,
            transport=body.transport,
            headers=body.headers,
        )

        return {
            "ok": True,
            "tools": [
                t.name
                for t in tools
            ],
        }

    except Exception as exc:
        logger.info(
            "MCP probe 失败：%s (%s)",
            url,
            exc,
        )

        return {
            "ok": False,
            "error": str(exc),
        }