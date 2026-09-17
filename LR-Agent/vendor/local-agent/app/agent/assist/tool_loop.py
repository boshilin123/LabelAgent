"""多轮 LLM ↔ 工具循环：stream_chunks → execute_round → 追加 ToolMessage。

拆分为两个阶段：
  1. stream_chunks: 流式产出 text/reasoning + 拦截 proposal chunks
  2. execute_round: 解析 tool_calls → 执行 SYNC / 发射 ASYNC pending
"""

import asyncio
import inspect
import json
from collections.abc import AsyncIterator

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI

from app.agent.assist.explore_readonly import (
    EXPLORE_READONLY_TOOL_NAME,
    ExploreReadonlyRunner,
)
from app.agent.assist.proposal_streamer import ProposalStreamInterceptor
from app.agent.assist.task_phase import (
    TaskPhaseContext,
    check_call_allowed,
    extract_call_paths,
)
from app.agent.chat_message_builder import build_multimodal_user_message
from app.agent.stream_adapter import events_from_chunk
from app.agent.tool_dispatcher import (
    SplitToolCalls,
    resolve_round_tool_calls,
    split_resolved_calls,
)
from app.agent.tool_invocation import ResolvedToolCall, client_tool_mentioned_in_text
from app.agent.tools.workspace_path import is_lr_agent_relative
from app.agent.tools.tool_result import (
    build_tool_result,
    format_tool_result_for_display,
    stringify_tool_output,
)
from app.agent.tools.workspace_file_reader import (
    FILE_PROPOSAL_TOOLS,
    STR_REPLACE_TOOL_NAME,
    VISION_TOOL_NAME,
    extract_vision_path_from_tool_result,
    extract_doc_proposal_from_tool_result,
    format_vision_tool_result_for_display,
    format_write_tool_result_for_display,
)
from app.core.config import Settings
from app.schemas.agent import StreamEventPayload


def _api_call_name_and_id(call: object) -> tuple[str, str]:
    if isinstance(call, dict):
        name = str(call.get("name") or "").strip()
        tool_id = str(call.get("id") or "").strip()
        return name, tool_id
    name = str(getattr(call, "name", "") or "").strip()
    tool_id = str(getattr(call, "id", "") or "").strip()
    return name, tool_id


TOOL_CALLS_ALREADY_COMPLETED = "tool_calls_already_completed"
ALREADY_COMPLETED_SUMMARY = (
    "该工具本轮已执行，请勿重复调用。请总结，勿重跑标注工具。"
)

PARALLEL_SYNC_TOOLS = frozenset(
    {
        "get_lr_agent_help",
        "describe_annotation_project",
        "read_file_annotation",
        "read_workspace_file",
        "grep_workspace",
        "glob_workspace",
        "list_workspace_directory",
        "read_document_file",
    }
)


async def _invoke_tool_fn(name: str, args: dict, fn_map: dict[str, object]) -> str:
    fn = fn_map.get(name)
    try:
        if fn is None:
            return json.dumps(
                {"ok": False, "tool": name, "status": "error", "summary": f"未知工具: {name}"},
                ensure_ascii=False,
            )
        if asyncio.iscoroutinefunction(fn):
            raw = await fn(**args)
        else:
            # 同步工具丢线程池：既不阻塞事件循环（大范围 grep 会卡住整个服务的
            # SSE / 健康检查），又让并行白名单里的多个只读工具真正重叠执行。
            raw = await asyncio.to_thread(fn, **args)
            if inspect.isawaitable(raw):
                raw = await raw
        return stringify_tool_output(raw)
    except Exception as exc:
        return json.dumps(
            {"ok": False, "tool": name, "status": "error", "summary": f"工具执行失败: {exc}"},
            ensure_ascii=False,
        )


async def _force_tool_call_once(
    llm: ChatOpenAI,
    tools: list[StructuredTool],
    messages: list,
    full_text: str,
) -> tuple[AIMessage, list[ResolvedToolCall]] | None:
    """tool_choice="any" 强制 LLM 发起真实 tool call（正文伪代码兜底）。

    返回 (携带 tool_calls 的 AIMessage, 解析后的调用)；失败返回 None。
    AIMessage 保留已流式输出的原文本，确保后续 ToolMessage 的 tool_call_id 有归属。
    """
    try:
        llm_forced = llm.bind_tools(tools, tool_choice="any")
        response = await llm_forced.ainvoke(messages)
    except Exception:
        return None
    api_calls = getattr(response, "tool_calls", None) or []
    resolved = resolve_round_tool_calls(api_tool_calls=api_calls)
    if not resolved:
        return None
    tool_calls = [
        {"id": call.tool_call_id, "name": call.name, "args": call.arguments}
        for call in resolved
    ]
    return AIMessage(content=full_text, tool_calls=tool_calls), resolved


def _is_explore_runner(runner: object) -> bool:
    return isinstance(runner, ExploreReadonlyRunner) or callable(
        getattr(runner, "stream", None)
    )


def _explore_result_text(summary: str, status: str) -> str:
    return build_tool_result(
        ok=status == "done",
        tool=EXPLORE_READONLY_TOOL_NAME,
        status="ok" if status == "done" else "error",
        summary=summary or "（无摘要）",
    )


async def _merge_async_iterators(
    streams: list[AsyncIterator[StreamEventPayload]],
) -> AsyncIterator[StreamEventPayload]:
    if not streams:
        return
    if len(streams) == 1:
        async for event in streams[0]:
            yield event
        return

    queue: asyncio.Queue[StreamEventPayload | None] = asyncio.Queue()

    async def _pump(gen: AsyncIterator[StreamEventPayload]) -> None:
        try:
            async for event in gen:
                await queue.put(event)
        finally:
            await queue.put(None)

    tasks = [asyncio.create_task(_pump(stream)) for stream in streams]
    remaining = len(tasks)
    try:
        while remaining > 0:
            item = await queue.get()
            if item is None:
                remaining -= 1
            else:
                yield item
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _stream_explore_events(
    *,
    tool_id: str,
    args: dict,
    fn_map: dict[str, object],
) -> AsyncIterator[StreamEventPayload]:
    """产出 tool_start + subagent_*，不写父 messages、不发 tool_result。"""
    yield StreamEventPayload(
        type="tool_start",
        tool_call_id=tool_id,
        name=EXPLORE_READONLY_TOOL_NAME,
        arguments=json.dumps(args, ensure_ascii=False, indent=2),
    )
    runner = fn_map.get(EXPLORE_READONLY_TOOL_NAME)
    query = str(args.get("query") or "").strip()
    focus_raw = args.get("focus_path")
    focus_path = str(focus_raw).strip() if focus_raw else None
    stream_fn = getattr(runner, "stream", None)
    if _is_explore_runner(runner) and callable(stream_fn):
        async for event in stream_fn(
            query=query,
            focus_path=focus_path,
            parent_tool_id=tool_id,
        ):
            yield event
        return
    yield StreamEventPayload(
        type="subagent_done",
        tool_call_id=tool_id,
        summary="查阅子代理未就绪",
        status="error",
    )


async def _stream_tool_execution(
    *,
    tool_id: str,
    name: str,
    args: dict,
    fn_map: dict[str, object],
    provider_is_vision: bool,
    settings: Settings,
    messages: list,
    omit_file_proposal_start_delta: set[str] | None = None,
    streamed_paths_by_call_id: dict[str, str] | None = None,
    result_text: str | None = None,
) -> AsyncIterator[StreamEventPayload]:
    """执行单个同步工具，产出 tool_start / tool_result / file_proposal* 事件。"""
    if omit_file_proposal_start_delta is None:
        omit_file_proposal_start_delta = set()
    yield StreamEventPayload(
        type="tool_start",
        tool_call_id=tool_id,
        name=name,
        arguments=json.dumps(args, ensure_ascii=False, indent=2),
    )

    if name == EXPLORE_READONLY_TOOL_NAME:
        summary = ""
        status = "error"
        async for event in _stream_explore_events(
            tool_id=tool_id,
            args=args,
            fn_map=fn_map,
        ):
            yield event
            if event.type == "subagent_done":
                summary = event.summary or ""
                status = event.status or "done"
        display_result = format_tool_result_for_display(
            _explore_result_text(summary, status)
        )
        yield StreamEventPayload(
            type="tool_result",
            tool_call_id=tool_id,
            result=display_result,
        )
        messages.append(ToolMessage(content=display_result, tool_call_id=tool_id))
        return

    if result_text is None:
        result_text = await _invoke_tool_fn(name, args, fn_map)

    display_result = result_text
    vision_path: str | None = None
    doc_proposal: dict | None = None

    if name == VISION_TOOL_NAME:
        vision_path = extract_vision_path_from_tool_result(name, result_text)
        if vision_path:
            display_result = format_vision_tool_result_for_display(result_text)
    elif name in FILE_PROPOSAL_TOOLS:
        doc_proposal = extract_doc_proposal_from_tool_result(name, result_text)
        if doc_proposal:
            display_result = format_write_tool_result_for_display(result_text)
    else:
        display_result = format_tool_result_for_display(result_text)

    yield StreamEventPayload(
        type="tool_result",
        tool_call_id=tool_id,
        result=display_result,
    )
    messages.append(ToolMessage(content=display_result, tool_call_id=tool_id))

    if doc_proposal is None and name in FILE_PROPOSAL_TOOLS and streamed_paths_by_call_id:
        # 工具执行失败（如 old_string 未命中）：拦截器流式期间已为该路径出卡
        # （pending 块 content 为空/不完整）。补发 dismissed 终态让前端收掉
        # 悬挂卡片，否则 Keep All 会把空内容写盘。
        streamed_path = streamed_paths_by_call_id.get(tool_id)
        if streamed_path:
            yield StreamEventPayload(
                type="file_proposal",
                summary=str(args.get("relative_path") or streamed_path),
                content="",
                image_path=streamed_path,
                mode="edit" if name == STR_REPLACE_TOOL_NAME else "write",
                status="dismissed",
            )

    if doc_proposal:
        full_content = doc_proposal["content"]
        rel_path = doc_proposal["relative_path"]
        if not is_lr_agent_relative(rel_path):
            operation = str(doc_proposal.get("operation") or "write")
            omit_for_path = rel_path in omit_file_proposal_start_delta if omit_file_proposal_start_delta else False
            if operation != "delete" and not omit_for_path:
                yield StreamEventPayload(
                    type="file_proposal_start",
                    summary=doc_proposal["title"],
                    image_path=rel_path,
                    detail=str(len(full_content)),
                    mode=operation,
                )
                chunk_size = 200
                offset = 0
                while offset < len(full_content):
                    end = min(offset + chunk_size, len(full_content))
                    chunk = full_content[offset:end]
                    yield StreamEventPayload(
                        type="file_proposal_delta",
                        content=chunk,
                        image_path=rel_path,
                        mode=operation,
                    )
                    offset = end
            yield StreamEventPayload(
                type="file_proposal",
                summary=doc_proposal["title"],
                content=full_content,
                image_path=rel_path,
                mode=operation,
                old_path=str(doc_proposal.get("old_path") or "") or None,
            )

    if vision_path and provider_is_vision:
        messages.append(
            await build_multimodal_user_message(
                "【附图】请根据上图回答用户关于该图片的问题。",
                image_absolute_path=vision_path,
                max_edge=settings.agent_chat_vision_max_edge,
                jpeg_quality=settings.agent_chat_vision_jpeg_quality,
            ),
        )


class ToolLoopRunner:
    """多轮 LLM ↔ 工具循环执行器。"""

    def __init__(
        self,
        llm: ChatOpenAI,
        tools: list[StructuredTool],
        fn_map: dict[str, object],
        settings: Settings,
        is_cancelled,
        user_content: str,
        provider_is_vision: bool = False,
        task_phase_ctx: TaskPhaseContext | None = None,
    ) -> None:
        self.llm = llm
        self.tools = tools
        self.fn_map = fn_map
        self.settings = settings
        self.is_cancelled = is_cancelled
        self.user_content = user_content
        self.provider_is_vision = provider_is_vision
        self.phase_ctx = task_phase_ctx
        self.vision_bootstrapped = False
        self.completed_tools: set[str] = set()
        self.tool_choice_retries = 0

    def mark_completed(self, tool_call_ids: set[str]) -> None:
        """标记已 resume 的 tool_call_id（允许同名新调用）。"""
        self.completed_tools |= tool_call_ids

    async def _maybe_force_tool_call(
        self,
        full_text: str,
        messages: list,
    ) -> tuple[AIMessage, list[ResolvedToolCall]] | None:
        """正文提到客户端工具却未发起真实 tool_call 时，强制重试一次。

        仅触发一次；被阶段门禁禁止的工具不强制（让模型收到门禁反馈而非硬调）。
        """
        if self.tool_choice_retries >= 1:
            return None
        mentioned = client_tool_mentioned_in_text(full_text)
        if not mentioned:
            return None
        if mentioned not in {t.name for t in self.tools}:
            return None
        if check_call_allowed(mentioned, {}, self.phase_ctx) is not None:
            return None
        self.tool_choice_retries += 1
        return await _force_tool_call_once(self.llm, self.tools, messages, full_text)

    async def _yield_blocked_call(
        self,
        call: ResolvedToolCall,
        *,
        status: str,
        reason: str,
        messages: list,
    ) -> AsyncIterator[StreamEventPayload]:
        """被门禁/去重拦截的调用：产出 tool_start/tool_result 事件并补 ToolMessage。"""
        result_text = build_tool_result(
            ok=False,
            tool=call.name,
            status=status,
            summary=reason,
        )
        yield StreamEventPayload(
            type="tool_start",
            tool_call_id=call.tool_call_id,
            name=call.name,
            arguments=json.dumps(call.arguments, ensure_ascii=False, indent=2),
        )
        yield StreamEventPayload(
            type="tool_result",
            tool_call_id=call.tool_call_id,
            result=result_text,
        )
        messages.append(ToolMessage(content=result_text, tool_call_id=call.tool_call_id))

    async def stream_chunks(
        self,
        messages: list,
        interceptor: ProposalStreamInterceptor,
    ) -> AsyncIterator[StreamEventPayload]:
        """流式产出 text_delta / reasoning_delta + 拦截 proposal chunks。"""
        llm_with_tools = self.llm.bind_tools(self.tools)

        async for chunk in llm_with_tools.astream(messages):
            if await self.is_cancelled():
                return

            for event in events_from_chunk(chunk, emit_tool_chunks=False):
                if event.type in ("text_delta", "reasoning_delta") and event.content:
                    yield event

            for proposal_event in interceptor.on_chunk(chunk):
                yield proposal_event

    async def execute_round(
        self,
        gathered: AIMessage,
        full_text: str,
        messages: list,
        interceptor: ProposalStreamInterceptor,
    ) -> AsyncIterator[StreamEventPayload]:
        """解析 tool_calls → 阶段门禁 → 执行 SYNC / 发射 ASYNC pending → 产出事件。"""
        api_tool_calls = gathered.tool_calls or []

        resolved = resolve_round_tool_calls(
            api_tool_calls=api_tool_calls,
            completed_tools=frozenset(self.completed_tools),
        )

        if not resolved and not api_tool_calls:
            # 伪代码兜底：正文写了 auto_annotate(...) 等客户端工具却未发起真实 tool_call
            forced = await self._maybe_force_tool_call(full_text, messages)
            if forced is not None:
                gathered, resolved = forced

        if not resolved:
            if not api_tool_calls:
                return
            messages.append(gathered)
            for call in api_tool_calls:
                name, tool_id = _api_call_name_and_id(call)
                if not name or not tool_id:
                    continue
                result_text = build_tool_result(
                    ok=False,
                    tool=name,
                    status="already_completed",
                    summary=ALREADY_COMPLETED_SUMMARY,
                )
                messages.append(
                    ToolMessage(content=result_text, tool_call_id=tool_id)
                )
            yield StreamEventPayload(type=TOOL_CALLS_ALREADY_COMPLETED)
            return

        messages.append(gathered)

        # ── 同轮顺序不变量：标注写入与工作区写入不能同轮 ──
        # 否则 write_workspace_file（SYNC）会先执行，auto_annotate（ASYNC）后挂起，
        # 出现「先写报告、后标注」的本末倒置。此处拦截工作区写入，标注照常。
        from app.agent.assist.task_phase import (
            ANNOTATION_WRITE_TOOLS,
            WORKSPACE_WRITE_TOOLS,
        )

        has_annotation_write = any(
            call.name in ANNOTATION_WRITE_TOOLS for call in resolved
        )
        if has_annotation_write:
            kept: list[ResolvedToolCall] = []
            for call in resolved:
                if call.name in WORKSPACE_WRITE_TOOLS:
                    async for event in self._yield_blocked_call(
                        call,
                        status="phase_blocked",
                        reason=(
                            "本轮已包含标注写入（auto_annotate / mutate_annotation）。"
                            "请先完成标注并等待用户 Keep All，再写报告或修改文件。"
                        ),
                        messages=messages,
                    ):
                        yield event
                    continue
                kept.append(call)
            resolved = kept
            if not resolved:
                return

        # ── 阶段门禁：被禁调用转为错误反馈（loop 继续，模型收到反馈自行调整）──
        if self.phase_ctx is not None and self.phase_ctx.gating_enabled:
            allowed_calls: list[ResolvedToolCall] = []
            for call in resolved:
                reason = check_call_allowed(call.name, call.arguments, self.phase_ctx)
                if reason is None:
                    allowed_calls.append(call)
                    continue
                async for event in self._yield_blocked_call(
                    call,
                    status="phase_blocked",
                    reason=reason,
                    messages=messages,
                ):
                    yield event
            resolved = allowed_calls
            if not resolved:
                return

        split = split_resolved_calls(resolved)

        # ── 同轮多个 auto_annotate 合并为一次批量 ──
        # 5 次单文件 auto_annotate 会产出 5 份提案且单张更易过检；合并 paths 后
        # 前端只跑一次批量标注，只生成一份提案。
        auto_calls = [c for c in split.async_pending if c.name == "auto_annotate"]
        if len(auto_calls) > 1:
            merged_paths: list[str] = []
            seen_paths: set[str] = set()
            merged_all_files = False
            merged_write_mode = "append"
            for call in auto_calls:
                for p in extract_call_paths(call.arguments):
                    if p not in seen_paths:
                        seen_paths.add(p)
                        merged_paths.append(p)
                if call.arguments.get("all_files") is True:
                    merged_all_files = True
                wm = call.arguments.get("write_mode")
                if wm == "replace_matching":
                    merged_write_mode = "replace_matching"

            first = auto_calls[0]
            first_args = dict(first.arguments)
            first_args["paths"] = merged_paths
            first_args["all_files"] = merged_all_files
            first_args["write_mode"] = merged_write_mode
            merged_first = ResolvedToolCall(
                tool_call_id=first.tool_call_id,
                name=first.name,
                arguments=first_args,
                source=first.source,
            )
            async_pending = [merged_first]
            for call in auto_calls[1:]:
                async for event in self._yield_blocked_call(
                    call,
                    status="coalesced",
                    reason=(
                        f"本次调用已并入第一个 auto_annotate（paths 合并为 {merged_paths}），"
                        "请勿重复发起。"
                    ),
                    messages=messages,
                ):
                    yield event
            # 保留非 auto_annotate 的异步调用（mutate_annotation 不合并）
            async_pending.extend(
                c for c in split.async_pending if c.name != "auto_annotate"
            )
            split = SplitToolCalls(
                immediate=split.immediate,
                async_pending=async_pending,
            )

        # ── 同批异步调用去重：同工具同范围只保留第一个 ──
        if split.async_pending:
            seen_scopes: set[tuple[str, frozenset[str]]] = set()
            deduped_pending: list[ResolvedToolCall] = []
            for call in split.async_pending:
                scope_key = (call.name, extract_call_paths(call.arguments))
                if scope_key in seen_scopes:
                    async for event in self._yield_blocked_call(
                        call,
                        status="duplicate_call",
                        reason="同一轮内相同范围的重复标注调用已忽略，请勿重复发起。",
                        messages=messages,
                    ):
                        yield event
                    continue
                seen_scopes.add(scope_key)
                deduped_pending.append(call)
            split = SplitToolCalls(
                immediate=split.immediate,
                async_pending=deduped_pending,
            )
            if not split.immediate and not split.async_pending:
                return

        streamed_paths_by_call_id = interceptor.streamed_paths_by_call_id()
        streamed_paths = set(streamed_paths_by_call_id.values())

        explore_calls = [
            call
            for call in split.immediate
            if call.name == EXPLORE_READONLY_TOOL_NAME
        ]
        other_immediate = [
            call
            for call in split.immediate
            if call.name != EXPLORE_READONLY_TOOL_NAME
        ]

        parallel_calls = [
            call for call in other_immediate if call.name in PARALLEL_SYNC_TOOLS
        ]
        precomputed: dict[str, str] = {}
        if parallel_calls:
            async def _run_parallel(call: ResolvedToolCall) -> tuple[str, str]:
                text = await _invoke_tool_fn(call.name, call.arguments, self.fn_map)
                return call.tool_call_id, text

            pairs = await asyncio.gather(*[_run_parallel(call) for call in parallel_calls])
            precomputed = dict(pairs)

        for call in other_immediate:
            if await self.is_cancelled():
                return
            async for event in _stream_tool_execution(
                tool_id=call.tool_call_id,
                name=call.name,
                args=call.arguments,
                fn_map=self.fn_map,
                provider_is_vision=self.provider_is_vision,
                settings=self.settings,
                messages=messages,
                omit_file_proposal_start_delta=streamed_paths,
                streamed_paths_by_call_id=streamed_paths_by_call_id,
                result_text=precomputed.get(call.tool_call_id),
            ):
                yield event
            if call.name == VISION_TOOL_NAME:
                self.vision_bootstrapped = True

        if explore_calls:
            finals: dict[str, tuple[str, str]] = {}

            async def _tracked_explore(
                call: ResolvedToolCall,
            ) -> AsyncIterator[StreamEventPayload]:
                summary = ""
                status = "error"
                try:
                    async for event in _stream_explore_events(
                        tool_id=call.tool_call_id,
                        args=call.arguments,
                        fn_map=self.fn_map,
                    ):
                        if event.type == "subagent_done":
                            summary = event.summary or ""
                            status = event.status or "done"
                        yield event
                except Exception as exc:
                    summary = f"查阅失败：{exc}"
                    status = "error"
                    yield StreamEventPayload(
                        type="subagent_done",
                        tool_call_id=call.tool_call_id,
                        summary=summary,
                        status="error",
                    )
                finals[call.tool_call_id] = (summary, status)

            async for event in _merge_async_iterators(
                [_tracked_explore(call) for call in explore_calls]
            ):
                yield event

            for call in explore_calls:
                summary, status = finals.get(
                    call.tool_call_id, ("查阅失败", "error")
                )
                display_result = format_tool_result_for_display(
                    _explore_result_text(summary, status)
                )
                yield StreamEventPayload(
                    type="tool_result",
                    tool_call_id=call.tool_call_id,
                    result=display_result,
                )
                messages.append(
                    ToolMessage(
                        content=display_result, tool_call_id=call.tool_call_id
                    )
                )

        if split.async_pending:
            from app.agent.assist.pending_emitter import emit_tool_pending

            async for event in emit_tool_pending(split.async_pending):
                yield event
