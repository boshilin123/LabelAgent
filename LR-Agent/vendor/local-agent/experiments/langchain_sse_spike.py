"""Minimal backend SSE adapter probe for one pending annotation tool.

Run from vendor/local-agent with LangChain 1.x installed:
    python -m experiments.langchain_sse_spike

This intentionally covers only one client tool. It is not a replacement for
the production stream adapter or a proof of full event-contract parity.
"""

import json

from langchain.agents import create_agent
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from app.schemas.agent import ClientToolCallPayload, StreamEventPayload
from experiments.langchain_agent_spike import ScriptedModel, auto_annotate


def _event_adapter(parts):
    """Map the minimal model/tool-interrupt sequence to the existing SSE schema."""
    yield StreamEventPayload(type="preparing", stage="streaming")
    pending_calls: list[ClientToolCallPayload] = []
    for part in parts:
        if part["type"] == "messages":
            message, _metadata = part["data"]
            if isinstance(message, AIMessage) and message.content:
                yield StreamEventPayload(type="text_delta", content=message.content)
            continue
        if part["type"] != "updates":
            continue
        data = part["data"]
        model_update = data.get("model", {})
        for message in model_update.get("messages", []):
            for call in getattr(message, "tool_calls", []):
                pending_calls.append(
                    ClientToolCallPayload(
                        tool_call_id=call["id"],
                        name=call["name"],
                        arguments=call["args"],
                    )
                )
                yield StreamEventPayload(
                    type="tool_start",
                    tool_call_id=call["id"],
                    name=call["name"],
                    arguments=json.dumps(call["args"], ensure_ascii=False, indent=2),
                )
        if data.get("__interrupt__"):
            yield StreamEventPayload(
                type="tool_pending", client_tool_calls=pending_calls
            )


def main() -> None:
    agent = create_agent(
        model=ScriptedModel(),
        tools=[auto_annotate],
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": "sse-spike-1"}}
    first = list(
        _event_adapter(
            agent.stream(
                {"messages": [{"role": "user", "content": "标注 sample.jpg"}]},
                config=config,
                stream_mode=["updates", "messages"],
                version="v2",
            )
        )
    )
    assert [event.type for event in first] == [
        "preparing", "tool_start", "tool_pending"
    ], first
    assert first[-1].to_sse_dict()["clientToolCalls"] == [
        {
            "toolCallId": "spike-annotate-1",
            "name": "auto_annotate",
            "arguments": {"paths": ["sample.jpg"]},
        }
    ]

    second = list(
        _event_adapter(
            agent.stream(
                Command(resume={"ok": True, "processed": 1}),
                config=config,
                stream_mode=["updates", "messages"],
                version="v2",
            )
        )
    )
    assert [event.type for event in second] == ["preparing", "text_delta"], second
    assert "processed" in second[-1].content
    print("PASS: one-tool framework pause/resume maps to the existing SSE shape")


if __name__ == "__main__":
    main()
