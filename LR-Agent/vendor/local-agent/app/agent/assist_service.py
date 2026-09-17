"""Assist 模式流式推理：编排 ToolLoopRunner + VisionAutoLoader + ProposalStreamInterceptor。"""

from collections.abc import AsyncIterator

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI

from app.agent.assist.proposal_streamer import ProposalStreamInterceptor
from app.agent.assist.task_phase import TaskPhase, TaskPhaseContext
from app.agent.assist.tool_loop import TOOL_CALLS_ALREADY_COMPLETED, ToolLoopRunner
from app.agent.assist.vision_bootstrap import VisionAutoLoader
from app.agent.context_service import append_client_tool_results_to_messages
from app.agent.stream_adapter import events_from_chunk
from app.agent.tools.registry import tool_fn_map
from app.agent.tools.workspace_file_reader import VISION_TOOL_NAME
from app.core.config import Settings
from app.schemas.agent import ClientContextInput, StreamEventPayload


async def stream_assist(
    llm: ChatOpenAI,
    lc_messages: list,
    tools: list[StructuredTool],
    *,
    settings: Settings,
    max_tool_rounds: int,
    is_cancelled,
    provider_is_vision: bool = False,
    client_context: ClientContextInput | None = None,
    user_content: str = "",
    client_tool_results: list | None = None,
    task_phase_ctx: TaskPhaseContext | None = None,
    aux_llm: ChatOpenAI | None = None,
) -> AsyncIterator[StreamEventPayload]:
    yield StreamEventPayload(type="preparing", stage="streaming")

    llm_with_tools = llm.bind_tools(tools)
    fn_map = tool_fn_map(tools)
    from app.agent.assist.explore_readonly import (
        EXPLORE_READONLY_TOOL_NAME,
        ExploreReadonlyRunner,
    )

    parent_fns = {
        name: fn
        for name, fn in fn_map.items()
        if name != EXPLORE_READONLY_TOOL_NAME
    }
    if any(tool.name == EXPLORE_READONLY_TOOL_NAME for tool in tools):
        fn_map[EXPLORE_READONLY_TOOL_NAME] = ExploreReadonlyRunner(
            llm=aux_llm or llm,
            settings=settings,
            is_cancelled=is_cancelled,
            parent_tools=tools,
            parent_fn_map=parent_fns,
            client_context=client_context,
        )
    messages = list(lc_messages)
    vision_fn = fn_map.get(VISION_TOOL_NAME)
    is_resume = bool(client_tool_results)

    # ── 子模块实例化 ─────────────────────────────────────────────────
    vision = VisionAutoLoader(
        vision_fn=vision_fn,
        provider_is_vision=provider_is_vision,
        settings=settings,
        client_context=client_context,
        user_content=user_content,
    )
    loop = ToolLoopRunner(
        llm=llm,
        tools=tools,
        fn_map=fn_map,
        settings=settings,
        is_cancelled=is_cancelled,
        user_content=user_content,
        provider_is_vision=provider_is_vision,
        task_phase_ctx=task_phase_ctx,
    )

    # ── resume：注入已完成的工具结果 ─────────────────────────────────
    if client_tool_results:
        completed_ids = {ctr.tool_call_id for ctr in client_tool_results}
        loop.mark_completed(completed_ids)
        append_client_tool_results_to_messages(
            messages,
            client_tool_results,
            user_content=user_content,
            proposals_applied=bool(
                task_phase_ctx and task_phase_ctx.phase == TaskPhase.VERIFY
            ),
        )

    # ── 主循环 ───────────────────────────────────────────────────────
    # 视觉图片由模型按需调用 read_image_for_vision 加载；
    # 仅在第一轮无 tool call 时由 VisionAutoLoader 兜底（见循环内 fallback 分支）。
    for round_idx in range(max_tool_rounds + 1):
        if await is_cancelled():
            return

        # 每轮使用全新拦截器：tool_call 的 tc_index 每轮都从 0 重新编号，
        # 复用实例会把上一轮 write 调用的 rel_path / content_sent_len 残留到
        # 本轮，导致提案 delta 错标归属路径并把别的文件内容追加进旧提案。
        interceptor = ProposalStreamInterceptor(client_context)

        gathered: AIMessage | None = None
        pending_text: list[str] = []

        # 单次 astream：同时收集 text/reasoning + 拦截 proposal + 累加 gathered
        async for chunk in llm_with_tools.astream(messages):
            if await is_cancelled():
                return

            for event in events_from_chunk(chunk, emit_tool_chunks=False):
                if event.type == "text_delta" and event.content:
                    pending_text.append(event.content)
                    yield event
                elif event.type == "reasoning_delta" and event.content:
                    yield event

            # 提案流式拦截
            for proposal_event in interceptor.on_chunk(chunk):
                yield proposal_event

            if gathered is None:
                gathered = chunk
            else:
                gathered = gathered + chunk

        if gathered is None:
            break

        full_text = "".join(pending_text)

        # 执行本轮 tool calls（由 ToolLoopRunner 统一解析 + 执行 + pending）
        had_tool_call = False
        async for event in loop.execute_round(
            gathered=gathered,
            full_text=full_text,
            messages=messages,
            interceptor=interceptor,
        ):
            if event.type == TOOL_CALLS_ALREADY_COMPLETED:
                had_tool_call = True
                continue
            had_tool_call = True
            if event.type == "tool_pending":
                yield event
                return
            yield event

        if had_tool_call:
            continue

        # 无 tool call 时的处理
        # 视觉 fallback（仅第一轮）
        if (
            round_idx == 0
            and not is_resume
            and vision.should_load(is_resume)
            and not loop.vision_bootstrapped
        ):
            async for event in vision.try_fallback(messages):
                yield event
            loop.vision_bootstrapped = True
            continue

        break
    else:
        # 工具轮预算耗尽兜底：照抄子代理的收尾模式，强制一次无工具的
        # 最终回答，避免回合在工具链中途无声结束、前端只剩半截输出。
        if await is_cancelled():
            return
        messages.append(
            HumanMessage(
                content=(
                    "工具调用预算已用完。请基于以上进展直接给出最终回答，"
                    "不要再调用工具。"
                )
            )
        )
        async for chunk in llm.astream(messages):
            if await is_cancelled():
                return
            for event in events_from_chunk(chunk, emit_tool_chunks=False):
                if event.type in ("text_delta", "reasoning_delta") and event.content:
                    yield event
