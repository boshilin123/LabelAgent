"""只读查阅子代理：嵌套短循环，产出 subagent_* SSE，最终回中文摘要。"""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI

from app.agent.stream_adapter import events_from_chunk
from app.agent.tool_dispatcher import resolve_round_tool_calls
from app.agent.tools.tool_result import (
    build_tool_result,
    format_tool_result_for_display,
    stringify_tool_output,
)
from app.core.config import Settings
from app.schemas.agent import ClientContextInput, StreamEventPayload

EXPLORE_READONLY_TOOL_NAME = "explore_readonly"

EXPLORE_READONLY_BASE_INNER: frozenset[str] = frozenset(
    {
        "grep_workspace",
        "glob_workspace",
        "list_workspace_directory",
        "read_workspace_file",
        "read_document_file",
        "describe_client_context",
        "get_lr_agent_help",
    }
)

EXPLORE_READONLY_ANNOTATION_INNER: frozenset[str] = frozenset(
    {
        "read_file_annotation",
        "describe_annotation_project",
    }
)

EXPLORE_READONLY_FORBIDDEN_INNER: frozenset[str] = frozenset(
    {
        EXPLORE_READONLY_TOOL_NAME,
        "auto_annotate",
        "mutate_annotation",
        "write_workspace_file",
        "str_replace_workspace_file",
        "delete_workspace_file",
        "memory_write",
        "memory_create",
        "read_image_for_vision",
    }
)

_SUBAGENT_SYSTEM = """你是只读查阅子代理。只用只读工具查看代码、文档或已有标注，然后用简洁中文写一份摘要。
禁止改文件、写标注、调用 explore_readonly，也禁止声称已经改过文件或完成标注。
调用工具前先用一两句中文说明正在查什么。
查到足够信息后直接给出结论，不要输出工具伪代码。"""

_INNER_RESULT_LIMIT = 4000


def resolve_explore_inner_names(*, include_annotation_reads: bool) -> frozenset[str]:
    names = set(EXPLORE_READONLY_BASE_INNER)
    if include_annotation_reads:
        names |= EXPLORE_READONLY_ANNOTATION_INNER
    return frozenset(names - EXPLORE_READONLY_FORBIDDEN_INNER)


def should_include_annotation_reads(
    client_context: ClientContextInput | None,
    parent_tools: list[StructuredTool] | None = None,
) -> bool:
    if client_context is not None and client_context.work_mode == "editor":
        return False
    if parent_tools is None:
        return True
    parent_names = {tool.name for tool in parent_tools}
    return bool(parent_names & EXPLORE_READONLY_ANNOTATION_INNER)


def filter_explore_inner_tools(
    parent_tools: list[StructuredTool],
    *,
    include_annotation_reads: bool,
) -> list[StructuredTool]:
    allowed = resolve_explore_inner_names(
        include_annotation_reads=include_annotation_reads
    )
    return [
        tool
        for tool in parent_tools
        if tool.name in allowed and tool.name not in EXPLORE_READONLY_FORBIDDEN_INNER
    ]


def filter_explore_inner_fn_map(
    parent_fn_map: dict[str, object],
    *,
    include_annotation_reads: bool,
) -> dict[str, object]:
    allowed = resolve_explore_inner_names(
        include_annotation_reads=include_annotation_reads
    )
    return {
        name: fn
        for name, fn in parent_fn_map.items()
        if name in allowed and name not in EXPLORE_READONLY_FORBIDDEN_INNER
    }


def _truncate_result(text: str, limit: int = _INNER_RESULT_LIMIT) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}…\n[已截断，共 {len(text)} 字符]"


async def _invoke_inner(name: str, args: dict, fn_map: dict[str, object]) -> str:
    fn = fn_map.get(name)
    try:
        if fn is None:
            return build_tool_result(
                ok=False,
                tool=name,
                status="error",
                summary=f"未知工具: {name}",
            )
        if asyncio.iscoroutinefunction(fn):
            raw = await fn(**args)
        else:
            # 同主循环 _invoke_tool_fn：同步内层工具走线程池，
            # 否则子代理里的 grep / 读文件同样会卡住事件循环。
            raw = await asyncio.to_thread(fn, **args)
            if inspect.isawaitable(raw):
                raw = await raw
        return stringify_tool_output(raw)
    except Exception as exc:
        return build_tool_result(
            ok=False,
            tool=name,
            status="error",
            summary=f"工具执行失败: {exc}",
        )


def _tool_calls_as_dicts(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for call in raw or []:
        if isinstance(call, dict):
            out.append(call)
            continue
        out.append(
            {
                "id": str(getattr(call, "id", "") or ""),
                "name": str(getattr(call, "name", "") or ""),
                "args": getattr(call, "args", None) or {},
            }
        )
    return out


def _ai_message_from_resolved(text: str, calls: list) -> AIMessage:
    return AIMessage(
        content=text,
        tool_calls=[
            {
                "id": call.tool_call_id,
                "name": call.name,
                "args": call.arguments,
                "type": "tool_call",
            }
            for call in calls
        ],
    )


class ExploreReadonlyRunner:
    """复用父 LLM / 取消信号，跑一轮独立的只读查阅循环。"""

    def __init__(
        self,
        *,
        llm: ChatOpenAI,
        settings: Settings,
        is_cancelled,
        parent_tools: list[StructuredTool],
        parent_fn_map: dict[str, object],
        client_context: ClientContextInput | None = None,
    ) -> None:
        self.llm = llm
        self.settings = settings
        self.is_cancelled = is_cancelled
        self.parent_tools = parent_tools
        self.parent_fn_map = parent_fn_map
        self.client_context = client_context

    async def stream(
        self,
        *,
        query: str,
        focus_path: str | None,
        parent_tool_id: str,
    ) -> AsyncIterator[StreamEventPayload]:
        query = (query or "").strip()
        focus = (focus_path or "").strip() or None

        yield StreamEventPayload(
            type="subagent_start",
            tool_call_id=parent_tool_id,
            query=query,
            focus_path=focus,
        )

        if not query:
            yield StreamEventPayload(
                type="subagent_done",
                tool_call_id=parent_tool_id,
                summary="查阅任务缺少 query。",
                status="error",
            )
            return

        include_annotation = should_include_annotation_reads(
            self.client_context,
            self.parent_tools,
        )
        inner_tools = filter_explore_inner_tools(
            self.parent_tools,
            include_annotation_reads=include_annotation,
        )
        inner_fn_map = filter_explore_inner_fn_map(
            self.parent_fn_map,
            include_annotation_reads=include_annotation,
        )

        if not inner_tools:
            yield StreamEventPayload(
                type="subagent_done",
                tool_call_id=parent_tool_id,
                summary="没有可用的只读查阅工具。",
                status="error",
            )
            return

        user_text = f"查阅任务：{query}"
        if focus:
            user_text = f"{user_text}\n优先关注路径：{focus}"
        messages: list = [
            SystemMessage(content=_SUBAGENT_SYSTEM),
            HumanMessage(content=user_text),
        ]

        llm_bound = self.llm.bind_tools(inner_tools)
        max_rounds = max(
            1, int(getattr(self.settings, "agent_subagent_max_tool_rounds", 8) or 8)
        )
        summary = ""
        status = "done"
        stopped = False
        last_had_tools = False

        for _round_idx in range(max_rounds):
            if await self.is_cancelled():
                status = "error"
                summary = summary or "已停止"
                stopped = True
                break

            gathered = None
            pending_text: list[str] = []
            try:
                async for chunk in llm_bound.astream(messages):
                    if await self.is_cancelled():
                        status = "error"
                        summary = summary or "已停止"
                        stopped = True
                        gathered = None
                        break
                    for event in events_from_chunk(chunk, emit_tool_chunks=False):
                        if event.type == "text_delta" and event.content:
                            pending_text.append(event.content)
                            yield StreamEventPayload(
                                type="subagent_text_delta",
                                tool_call_id=parent_tool_id,
                                content=event.content,
                            )
                    if gathered is None:
                        gathered = chunk
                    else:
                        gathered = gathered + chunk
            except Exception as exc:
                status = "error"
                summary = f"查阅失败：{exc}"
                break

            if stopped:
                break
            if gathered is None:
                break

            resolved = resolve_round_tool_calls(
                api_tool_calls=_tool_calls_as_dicts(
                    getattr(gathered, "tool_calls", None)
                )
            )
            allowed: list = []
            blocked: list = []
            for call in resolved:
                if (
                    call.name not in inner_fn_map
                    or call.name in EXPLORE_READONLY_FORBIDDEN_INNER
                ):
                    blocked.append(call)
                else:
                    allowed.append(call)

            if not allowed and not blocked:
                summary = "".join(pending_text).strip()
                last_had_tools = False
                break

            messages.append(
                _ai_message_from_resolved("".join(pending_text), [*blocked, *allowed])
            )
            last_had_tools = True

            for call in blocked:
                yield StreamEventPayload(
                    type="subagent_tool_start",
                    tool_call_id=parent_tool_id,
                    inner_tool_call_id=call.tool_call_id,
                    name=call.name,
                    arguments=json.dumps(call.arguments, ensure_ascii=False, indent=2),
                )
                blocked_text = build_tool_result(
                    ok=False,
                    tool=call.name,
                    status="error",
                    summary="此工具不可用于只读查阅。",
                )
                yield StreamEventPayload(
                    type="subagent_tool_result",
                    tool_call_id=parent_tool_id,
                    inner_tool_call_id=call.tool_call_id,
                    result=format_tool_result_for_display(blocked_text),
                    status="error",
                )
                messages.append(
                    ToolMessage(content=blocked_text, tool_call_id=call.tool_call_id)
                )

            for call in allowed:
                if await self.is_cancelled():
                    status = "error"
                    summary = summary or "已停止"
                    stopped = True
                    break
                yield StreamEventPayload(
                    type="subagent_tool_start",
                    tool_call_id=parent_tool_id,
                    inner_tool_call_id=call.tool_call_id,
                    name=call.name,
                    arguments=json.dumps(call.arguments, ensure_ascii=False, indent=2),
                )
                result_text = await _invoke_inner(
                    call.name, call.arguments, inner_fn_map
                )
                display = _truncate_result(format_tool_result_for_display(result_text))
                step_status = "done"
                try:
                    parsed = json.loads(result_text)
                    if isinstance(parsed, dict) and parsed.get("ok") is False:
                        step_status = "error"
                except json.JSONDecodeError:
                    pass
                yield StreamEventPayload(
                    type="subagent_tool_result",
                    tool_call_id=parent_tool_id,
                    inner_tool_call_id=call.tool_call_id,
                    result=display,
                    status=step_status,
                )
                messages.append(
                    ToolMessage(content=result_text, tool_call_id=call.tool_call_id)
                )
            if stopped:
                break
        else:
            last_had_tools = True

        if last_had_tools and status == "done" and not summary:
            try:
                if await self.is_cancelled():
                    status = "error"
                    summary = "已停止"
                else:
                    pending: list[str] = []
                    messages.append(
                        HumanMessage(content="请用中文给出查阅摘要，不要再调用工具。")
                    )
                    async for chunk in self.llm.astream(messages):
                        if await self.is_cancelled():
                            status = "error"
                            summary = "已停止"
                            pending = []
                            break
                        for event in events_from_chunk(chunk, emit_tool_chunks=False):
                            if event.type == "text_delta" and event.content:
                                pending.append(event.content)
                                yield StreamEventPayload(
                                    type="subagent_text_delta",
                                    tool_call_id=parent_tool_id,
                                    content=event.content,
                                )
                    if status == "done":
                        summary = "".join(pending).strip()
            except Exception as exc:
                summary = summary or f"已达查阅轮次上限：{exc}"

        if not summary:
            if status == "error":
                summary = "查阅失败"
            else:
                summary = "未找到可用结论。"

        yield StreamEventPayload(
            type="subagent_done",
            tool_call_id=parent_tool_id,
            summary=summary,
            status=status,
        )
