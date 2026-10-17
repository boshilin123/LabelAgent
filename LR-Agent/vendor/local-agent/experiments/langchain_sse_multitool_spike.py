"""Map two multi-tool framework scenarios to the current backend SSE contract.

Run from vendor/local-agent with the isolated upgraded environment:
    python -m experiments.langchain_sse_multitool_spike

This tests scripted tool calls, not a real model provider or YOLO runtime.
"""

import json

from langchain_core.messages import ToolMessage

from app.schemas.agent import ClientToolCallPayload, StreamEventPayload
from experiments.langchain_multitool_spike import _make_agent


def _adapt_first_turn(parts):
    yield StreamEventPayload(type="preparing", stage="streaming")
    calls = []
    suppressed: dict[str, ToolMessage] = {}
    interrupted = False
    for part in parts:
        if part["type"] == "messages":
            message, _metadata = part["data"]
            if isinstance(message, ToolMessage):
                suppressed[message.tool_call_id] = message
            continue
        if part["type"] != "updates":
            continue
        data = part["data"]
        for key, update in data.items():
            if (key == "model" or key.endswith(".after_model")) and update:
                for message in update.get("messages", []):
                    calls = list(getattr(message, "tool_calls", []))
        if "__interrupt__" in data:
            interrupted = True
    if not interrupted:
        return
    # ToolMessages can arrive after the interrupt update. Buffer through the
    # end of this HTTP turn before reproducing the old pending-event order.
    for call in calls:
        error = suppressed.get(call["id"])
        if error is None:
            continue
        yield StreamEventPayload(
            type="tool_start",
            tool_call_id=call["id"],
            name=call["name"],
            arguments=json.dumps(call["args"], ensure_ascii=False, indent=2),
        )
        yield StreamEventPayload(
            type="tool_result",
            tool_call_id=call["id"],
            result=error.content,
        )
    pending = [call for call in calls if call["id"] not in suppressed]
    for call in pending:
        yield StreamEventPayload(
            type="tool_start",
            tool_call_id=call["id"],
            name=call["name"],
            arguments=json.dumps(call["args"], ensure_ascii=False, indent=2),
        )
    yield StreamEventPayload(
        type="tool_pending",
        client_tool_calls=[
            ClientToolCallPayload(
                tool_call_id=call["id"],
                name=call["name"],
                arguments=call["args"],
            )
            for call in pending
        ],
    )


def _run_scenario(calls, thread_id):
    agent, annotations, writes = _make_agent(calls)
    events = list(
        _adapt_first_turn(
            agent.stream(
                {"messages": [{"role": "user", "content": "执行标注"}]},
                config={"configurable": {"thread_id": thread_id}},
                stream_mode=["messages", "updates"],
                version="v2",
            )
        )
    )
    assert not annotations and not writes
    return events


def main() -> None:
    duplicate = _run_scenario(
        [
            {"id": "a1", "name": "auto_annotate", "args": {"paths": ["1.jpg"]}},
            {"id": "a2", "name": "auto_annotate", "args": {"paths": ["2.jpg"]}},
        ],
        "sse-duplicate",
    )
    assert [event.type for event in duplicate] == [
        "preparing", "tool_start", "tool_result", "tool_start", "tool_pending"
    ], duplicate
    assert "coalesced" in duplicate[2].result
    assert duplicate[-1].to_sse_dict()["clientToolCalls"] == [
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
    print("PASS: coalesced-call feedback and merged pending batch map to SSE")

    mixed = _run_scenario(
        [
            {"id": "b1", "name": "auto_annotate", "args": {"paths": ["1.jpg"]}},
            {
                "id": "b2",
                "name": "write_workspace_file",
                "args": {"relative_path": "report.md", "content": "report"},
            },
        ],
        "sse-mixed",
    )
    assert [event.type for event in mixed] == [
        "preparing", "tool_start", "tool_result", "tool_start", "tool_pending"
    ], mixed
    assert "phase_blocked" in mixed[2].result
    assert mixed[-1].to_sse_dict()["clientToolCalls"][0]["toolCallId"] == "b1"
    print("PASS: same-round write rejection and annotation pending map to SSE")


if __name__ == "__main__":
    main()
