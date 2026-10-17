"""Multi-tool backend migration probe; no production route or YOLO call.

Run from vendor/local-agent with the isolated LangChain environment:
    python -m experiments.langchain_multitool_spike
"""

import json

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command, interrupt

from app.agent.assist.task_phase import (
    ANNOTATION_WRITE_TOOLS,
    WORKSPACE_WRITE_TOOLS,
    TaskPhaseContext,
    check_call_allowed,
)
from app.agent.tools.tool_result import build_tool_result


class MultiCallModel(BaseChatModel):
    calls: list[dict]

    @property
    def _llm_type(self) -> str:
        return "multi-tool-parity"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if any(isinstance(message, ToolMessage) for message in messages):
            reply = AIMessage(content="工具处理完成")
        else:
            reply = AIMessage(id="scripted-multi", content="", tool_calls=self.calls)
        return ChatResult(generations=[ChatGeneration(message=reply)])


class BusinessPolicy(AgentMiddleware):
    """Candidate mapping of current same-round rules to framework hooks."""

    def __init__(self, phase_context: TaskPhaseContext | None = None):
        self.phase_context = phase_context

    def after_model(self, state, runtime):
        message = state["messages"][-1]
        calls = list(getattr(message, "tool_calls", []))
        annotation_calls = [call for call in calls if call["name"] == "auto_annotate"]
        if len(annotation_calls) < 2:
            return None
        merged_paths = list(
            dict.fromkeys(
                path
                for call in annotation_calls
                for path in call["args"].get("paths", [])
            )
        )
        merged_all_files = any(
            call["args"].get("all_files") is True for call in annotation_calls
        )
        merged_write_mode = (
            "replace_matching"
            if any(
                call["args"].get("write_mode") == "replace_matching"
                for call in annotation_calls
            )
            else "append"
        )
        first_id = annotation_calls[0]["id"]
        updated = [
            {
                **call,
                "args": {
                    **call["args"],
                    "paths": merged_paths,
                    "all_files": merged_all_files,
                    "write_mode": merged_write_mode,
                },
            }
            if call["id"] == first_id
            else call
            for call in calls
        ]
        # Keep secondary call ids so they can receive coalesced ToolMessages.
        return {"messages": [message.model_copy(update={"tool_calls": updated})]}

    def wrap_tool_call(self, request, handler):
        call = request.tool_call
        name = call["name"]
        all_calls = request.state["messages"][-1].tool_calls
        annotation_calls = [
            item for item in all_calls if item["name"] == "auto_annotate"
        ]
        if name == "auto_annotate" and len(annotation_calls) > 1:
            if call["id"] != annotation_calls[0]["id"]:
                merged_paths = annotation_calls[0]["args"]["paths"]
                return self._blocked(
                    call,
                    "coalesced",
                    (
                        f"本次调用已并入第一个 auto_annotate（paths 合并为 {merged_paths}），"
                        "请勿重复发起。"
                    ),
                )
        if name in WORKSPACE_WRITE_TOOLS and any(
            item["name"] in ANNOTATION_WRITE_TOOLS for item in all_calls
        ):
            return self._blocked(
                call,
                "phase_blocked",
                (
                    "本轮已包含标注写入（auto_annotate / mutate_annotation）。"
                    "请先完成标注并等待用户 Keep All，再写报告或修改文件。"
                ),
            )
        reason = check_call_allowed(name, call.get("args") or {}, self.phase_context)
        if reason:
            return self._blocked(call, "phase_blocked", reason)
        return handler(request)

    @staticmethod
    def _blocked(call, status, summary):
        return ToolMessage(
            content=build_tool_result(
                ok=False,
                tool=call["name"],
                status=status,
                summary=summary,
            ),
            name=call["name"],
            tool_call_id=call["id"],
            status="error",
        )


def _make_agent(calls, *, phase_context=None):
    actual_annotations: list[list[str]] = []
    actual_writes: list[str] = []

    @tool
    def auto_annotate(paths: list[str]) -> str:
        """Ask the external runtime to annotate a batch of image paths."""
        result = interrupt(
            {"type": "tool_pending", "name": "auto_annotate", "paths": paths}
        )
        # Interrupted nodes replay on resume; effects belong after interrupt.
        actual_annotations.append(paths)
        return json.dumps(result, ensure_ascii=False)

    @tool
    def write_workspace_file(relative_path: str, content: str) -> str:
        """Write a workspace report."""
        actual_writes.append(relative_path)
        return "written"

    agent = create_agent(
        model=MultiCallModel(calls=calls),
        tools=[auto_annotate, write_workspace_file],
        middleware=[BusinessPolicy(phase_context)],
        checkpointer=InMemorySaver(),
    )
    return agent, actual_annotations, actual_writes


def main() -> None:
    duplicate_calls = [
        {"id": "a1", "name": "auto_annotate", "args": {"paths": ["1.jpg"]}},
        {
            "id": "a2",
            "name": "auto_annotate",
            "args": {"paths": ["2.jpg", "1.jpg"]},
        },
    ]
    agent, annotations, writes = _make_agent(duplicate_calls)
    config = {"configurable": {"thread_id": "multi-duplicate"}}
    paused = agent.invoke(
        {"messages": [{"role": "user", "content": "标注两张图片"}]}, config=config
    )
    assert len(paused.get("__interrupt__", ())) == 1, paused
    assert paused["__interrupt__"][0].value["paths"] == ["1.jpg", "2.jpg"]
    assert not annotations and not writes
    resumed = agent.invoke(Command(resume={"processed": 2}), config=config)
    tool_messages = [
        item for item in resumed["messages"] if isinstance(item, ToolMessage)
    ]
    assert {item.tool_call_id for item in tool_messages} == {"a1", "a2"}
    assert any("coalesced" in item.content for item in tool_messages)
    assert annotations == [["1.jpg", "2.jpg"]]
    print("PASS: duplicate calls merged, secondary id received coalesced feedback")

    mixed_calls = [
        {"id": "b1", "name": "auto_annotate", "args": {"paths": ["1.jpg"]}},
        {
            "id": "b2",
            "name": "write_workspace_file",
            "args": {"relative_path": "report.md", "content": "report"},
        },
    ]
    agent, annotations, writes = _make_agent(mixed_calls)
    config = {"configurable": {"thread_id": "multi-mixed"}}
    paused = agent.invoke(
        {"messages": [{"role": "user", "content": "标注并写报告"}]}, config=config
    )
    assert len(paused.get("__interrupt__", ())) == 1, paused
    assert not writes
    resumed = agent.invoke(Command(resume={"processed": 1}), config=config)
    tool_messages = [
        item for item in resumed["messages"] if isinstance(item, ToolMessage)
    ]
    assert any("phase_blocked" in item.content for item in tool_messages)
    assert not writes
    print("PASS: same-round report write blocked while annotation waits")


if __name__ == "__main__":
    main()
