"""Backend-only spike for a framework-managed client-tool pause/resume.

Run with a separate environment containing LangChain 1.x and LangGraph 1.x:
    python experiments/langchain_agent_spike.py

This does not call YOLO or change the production Agent route. It checks whether
create_agent can suspend an auto_annotate tool call and consume an external
result on resume, which is the backend's existing client-tool boundary.
"""

from __future__ import annotations

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command, interrupt


class ScriptedModel(BaseChatModel):
    """Return one tool call, then summarize the externally supplied result."""

    @property
    def _llm_type(self) -> str:
        return "scripted-spike"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager=None,
        **kwargs,
    ) -> ChatResult:
        results = [message for message in messages if isinstance(message, ToolMessage)]
        if results:
            reply = AIMessage(content=f"标注结果：{results[-1].content}")
        else:
            reply = AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "spike-annotate-1",
                        "name": "auto_annotate",
                        "args": {"paths": ["sample.jpg"]},
                    }
                ],
            )
        return ChatResult(generations=[ChatGeneration(message=reply)])


@tool
def auto_annotate(paths: list[str]) -> str:
    """Request automatic annotation for selected image paths."""
    external_result = interrupt(
        {"type": "tool_pending", "tool": "auto_annotate", "paths": paths}
    )
    return str(external_result)


def main() -> None:
    agent = create_agent(
        model=ScriptedModel(),
        tools=[auto_annotate],
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": "annotation-spike-1"}}

    paused = agent.invoke(
        {"messages": [{"role": "user", "content": "标注 sample.jpg"}]},
        config=config,
    )
    pending = paused.get("__interrupt__", ())
    assert len(pending) == 1, paused
    assert pending[0].value == {
        "type": "tool_pending",
        "tool": "auto_annotate",
        "paths": ["sample.jpg"],
    }

    resumed = agent.invoke(
        Command(resume={"ok": True, "processed": 1, "proposal_id": "p-1"}),
        config=config,
    )
    assert "__interrupt__" not in resumed, resumed
    assert "processed" in resumed["messages"][-1].content
    print("PASS: client tool paused, external result resumed, model received result")


if __name__ == "__main__":
    main()
