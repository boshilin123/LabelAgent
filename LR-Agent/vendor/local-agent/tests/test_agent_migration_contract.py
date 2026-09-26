"""Stable backend contract to preserve before replacing the Agent loop.

These tests do not require a browser, YOLO, or a model API. They cover the
backend-owned boundary: emit a pending client tool, accept its result in a
subsequent request, and keep the SSE payload shape stable.
"""

import json

from langchain_core.messages import HumanMessage, ToolMessage

from app.agent.assist_service import stream_assist
from app.schemas.agent import ClientToolResult


class FakeChunk:
    def __init__(self, *, content="", tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.tool_call_chunks = []
        self.additional_kwargs = {}


class ClientToolModel:
    def bind_tools(self, _tools):
        return self

    async def astream(self, messages):
        if any(isinstance(message, ToolMessage) for message in messages):
            yield FakeChunk(content="已收到标注结果，等待用户确认提案。")
            return
        yield FakeChunk(
            tool_calls=[
                {
                    "id": "contract-call-1",
                    "name": "auto_annotate",
                    "args": {"paths": ["data/1.jpg"], "all_files": False},
                }
            ]
        )


async def _not_cancelled():
    return False


async def test_pending_resume_preserves_backend_sse_contract():
    model = ClientToolModel()
    first = [
        event
        async for event in stream_assist(
            model,
            [HumanMessage(content="标注 data/1.jpg")],
            [],
            settings=None,
            max_tool_rounds=3,
            is_cancelled=_not_cancelled,
            user_content="标注 data/1.jpg",
        )
    ]
    assert [event.type for event in first] == [
        "preparing",
        "tool_start",
        "tool_pending",
    ]
    pending = first[-1].to_sse_dict()
    assert pending["clientToolCalls"] == pending["toolCalls"] == [
        {
            "toolCallId": "contract-call-1",
            "name": "auto_annotate",
            "arguments": {"paths": ["data/1.jpg"], "all_files": False},
        }
    ]
    assert first[1].to_sse_dict()["toolCallId"] == "contract-call-1"

    result = ClientToolResult(
        tool_call_id="contract-call-1",
        name="auto_annotate",
        result=json.dumps(
            {
                "status": "completed",
                "proposal_pending": True,
                "file_written": False,
            }
        ),
    )
    second = [
        event
        async for event in stream_assist(
            model,
            [HumanMessage(content="标注 data/1.jpg")],
            [],
            settings=None,
            max_tool_rounds=3,
            is_cancelled=_not_cancelled,
            user_content="标注 data/1.jpg",
            client_tool_results=[result],
        )
    ]
    assert [event.type for event in second] == ["preparing", "text_delta"]
    assert "等待用户确认" in second[-1].to_sse_dict()["content"]


async def test_cancellation_before_first_model_round_emits_no_client_tool():
    async def cancelled():
        return True

    events = [
        event
        async for event in stream_assist(
            ClientToolModel(),
            [HumanMessage(content="标注 data/1.jpg")],
            [],
            settings=None,
            max_tool_rounds=3,
            is_cancelled=cancelled,
            user_content="标注 data/1.jpg",
        )
    ]
    assert [event.type for event in events] == ["preparing"]
