"""Probe reuse of the existing backend phase gate in LangChain middleware.

Run from vendor/local-agent with the isolated LangChain 1.x environment:
    python experiments/langchain_policy_spike.py

This remains an experiment and is not wired into the production Agent route.
"""

import json

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool

from app.agent.assist.task_phase import (
    TaskPhase,
    TaskPhaseContext,
    check_call_allowed,
)


class OneToolModel(BaseChatModel):
    tool_name: str
    tool_args: dict

    @property
    def _llm_type(self) -> str:
        return "one-tool-policy-probe"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if any(isinstance(message, ToolMessage) for message in messages):
            reply = AIMessage(content="已收到工具结果")
        else:
            reply = AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "policy-call-1",
                        "name": self.tool_name,
                        "args": self.tool_args,
                    }
                ],
            )
        return ChatResult(generations=[ChatGeneration(message=reply)])


class PhaseGateMiddleware(AgentMiddleware):
    def __init__(self, phase_context: TaskPhaseContext):
        self.phase_context = phase_context

    def wrap_tool_call(self, request, handler):
        call = request.tool_call
        reason = check_call_allowed(
            call["name"], call.get("args") or {}, self.phase_context
        )
        if reason is None:
            return handler(request)
        return ToolMessage(
            content=json.dumps(
                {"status": "phase_blocked", "summary": reason},
                ensure_ascii=False,
            ),
            tool_call_id=call["id"],
            name=call["name"],
            status="error",
        )


def main() -> None:
    executed: list[str] = []

    @tool
    def write_workspace_file(relative_path: str, content: str) -> str:
        """Write a file in the workspace."""
        executed.append(relative_path)
        return "written"

    @tool
    def auto_annotate(paths: list[str]) -> str:
        """Annotate a selected image batch."""
        executed.extend(paths)
        return "annotated"

    pending_context = TaskPhaseContext(
        phase=TaskPhase.AWAIT_CONFIRM,
        pending_annotation_paths=frozenset({"data/1.jpg"}),
        applied_annotation_paths=frozenset(),
    )
    pending_agent = create_agent(
        model=OneToolModel(
            tool_name="write_workspace_file",
            tool_args={"relative_path": "report.md", "content": "report"},
        ),
        tools=[write_workspace_file],
        middleware=[PhaseGateMiddleware(pending_context)],
    )
    pending_result = pending_agent.invoke(
        {"messages": [{"role": "user", "content": "写报告"}]}
    )
    blocked = [
        message
        for message in pending_result["messages"]
        if isinstance(message, ToolMessage)
    ]
    assert len(blocked) == 1 and "phase_blocked" in blocked[0].content
    assert executed == []
    print("PASS: existing await-confirm gate blocks write in middleware")

    applied_context = TaskPhaseContext(
        phase=TaskPhase.VERIFY,
        pending_annotation_paths=frozenset(),
        applied_annotation_paths=frozenset({"data/1.jpg"}),
    )
    verify_agent = create_agent(
        model=OneToolModel(
            tool_name="auto_annotate", tool_args={"paths": ["data/1.jpg"]}
        ),
        tools=[auto_annotate],
        middleware=[PhaseGateMiddleware(applied_context)],
    )
    verify_result = verify_agent.invoke(
        {"messages": [{"role": "user", "content": "重新标注 data/1.jpg"}]}
    )
    blocked = [
        message
        for message in verify_result["messages"]
        if isinstance(message, ToolMessage)
    ]
    assert len(blocked) == 1 and "phase_blocked" in blocked[0].content
    assert executed == []
    print("PASS: existing verify gate blocks re-annotation in middleware")


if __name__ == "__main__":
    main()
