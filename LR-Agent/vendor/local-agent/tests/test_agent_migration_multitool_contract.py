"""Legacy multi-tool SSE snapshots required of a replacement Agent backend."""

import json

from langchain_core.messages import AIMessage

from app.agent.assist.proposal_streamer import ProposalStreamInterceptor
from app.agent.assist.tool_loop import ToolLoopRunner


async def _never_cancel():
    return False


async def _run_calls(calls):
    loop = ToolLoopRunner(
        llm=None,
        tools=[],
        fn_map={},
        settings=None,
        is_cancelled=_never_cancel,
        user_content="执行标注",
    )
    messages = []
    gathered = AIMessage(content="", tool_calls=calls)
    events = [
        event
        async for event in loop.execute_round(
            gathered=gathered,
            full_text="",
            messages=messages,
            interceptor=ProposalStreamInterceptor(),
        )
    ]
    return [event.to_sse_dict() for event in events]


async def test_duplicate_annotation_calls_emit_coalesced_then_one_pending_batch():
    events = await _run_calls(
        [
            {"id": "a1", "name": "auto_annotate", "args": {"paths": ["1.jpg"]}},
            {"id": "a2", "name": "auto_annotate", "args": {"paths": ["2.jpg"]}},
        ]
    )
    assert [event["type"] for event in events] == [
        "tool_start", "tool_result", "tool_start", "tool_pending"
    ]
    assert events[0]["toolCallId"] == "a2"
    assert json.loads(events[1]["result"])["status"] == "coalesced"
    assert events[-1]["clientToolCalls"] == [
        {
            "toolCallId": "a1",
            "name": "auto_annotate",
            "arguments": {
                "paths": ["1.jpg", "2.jpg"],
                "all_files": False,
                "write_mode": "append",
            },
        }
    ]


async def test_annotation_and_report_same_round_blocks_report_before_pending():
    events = await _run_calls(
        [
            {"id": "b1", "name": "auto_annotate", "args": {"paths": ["1.jpg"]}},
            {
                "id": "b2",
                "name": "write_workspace_file",
                "args": {"relative_path": "report.md", "content": "report"},
            },
        ]
    )
    assert [event["type"] for event in events] == [
        "tool_start", "tool_result", "tool_start", "tool_pending"
    ]
    assert events[0]["toolCallId"] == "b2"
    assert json.loads(events[1]["result"])["status"] == "phase_blocked"
    assert events[-1]["clientToolCalls"][0]["toolCallId"] == "b1"
