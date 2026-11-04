"""Offline observations for the 2026-10-28 backend Agent analysis.

Run from vendor/local-agent with the langchain-main interpreter.
No model/network calls. These are observations, not regression expectations.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from langchain_core.messages import AIMessage, ToolMessage
from app.agent import chat_service
from app.agent.langchain_runtime import entry
from app.agent.langchain_runtime.resume import prepare_resume_messages
from app.agent.langchain_runtime.round_plan import plan_round
from app.schemas.agent import ClientToolResult, LocalChatStreamRequest, StreamEventPayload


def observe_resume_and_round_plan() -> None:
    call = {"id": "old-call", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}}
    result = ClientToolResult(tool_call_id="old-call", name="auto_annotate", result='{"ok":true}')
    messages = prepare_resume_messages([AIMessage(content="", tool_calls=[call])], [result, result])
    tools = [m for m in messages if isinstance(m, ToolMessage)]
    print("same_batch_duplicate_result:", json.dumps({
        "input_results": 2, "tool_messages": len(tools),
        "matching_ids": [m.tool_call_id for m in tools],
    }))
    again = prepare_resume_messages(messages, [result])
    print("already_answered_redelivery_added_messages:", len(again) - len(messages))
    new_call = {"id": "new-call", "name": "auto_annotate", "args": {"paths": ["b.jpg"]}}
    plan = plan_round(AIMessage(content="", tool_calls=[call, new_call]), completed_tool_ids={"old-call"})
    print("mixed_completed_and_new_plan:", json.dumps({
        "calls": len(plan.calls), "suppressed": len(plan.suppressed),
        "execute_now": len(plan.execute_now), "deferred": len(plan.deferred),
    }))


async def observe_cancellation() -> None:
    job_id = "analysis-" + uuid4().hex
    release = asyncio.Event()
    waiting = asyncio.Event()
    closed = asyncio.Event()
    original_pair = entry.build_llm_pair
    original_chat = chat_service.stream_chat

    async def slow_chat(*_args, **_kwargs):
        try:
            yield StreamEventPayload(type="text_delta", content="first")
            waiting.set()
            await release.wait()
            yield StreamEventPayload(type="text_delta", content="second")
        finally:
            await asyncio.sleep(0)
            closed.set()

    entry.build_llm_pair = lambda _body: (None, None)
    chat_service.stream_chat = slow_chat
    stream = entry.stream_candidate_engine_sse(LocalChatStreamRequest(
        model="offline", api_key="offline-placeholder", base_url="http://invalid.local/v1",
        client_job_id=job_id, messages=[], user_content="offline",
    ), settings=None)
    pending = None
    try:
        await anext(stream)
        pending = asyncio.create_task(anext(stream))
        await asyncio.wait_for(waiting.wait(), timeout=1)
        pending.cancel()
        result = await asyncio.wait_for(asyncio.gather(pending, return_exceptions=True), timeout=1)
        print("cancel_while_source_waits_propagates:", isinstance(result[0], asyncio.CancelledError))
        print("source_cleanup_finished:", closed.is_set())
    finally:
        release.set()
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await stream.aclose()
        entry.build_llm_pair = original_pair
        chat_service.stream_chat = original_chat


if __name__ == "__main__":
    observe_resume_and_round_plan()
    asyncio.run(observe_cancellation())
