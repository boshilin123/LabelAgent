"""Check whether after_model middleware can merge same-round annotation calls.

Run from vendor/local-agent with LangChain 1.x installed:
    python -m experiments.langchain_batch_spike

The experiment proves batch coalescing only. It does not reproduce the current
per-suppressed-call ToolMessage/SSE feedback or the full Agent stream.
"""

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool


class BatchCallModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return "batch-call-spike"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if any(isinstance(message, ToolMessage) for message in messages):
            reply = AIMessage(content="批量标注已完成")
        else:
            reply = AIMessage(
                id="batch-model-reply",
                content="",
                tool_calls=[
                    {
                        "id": "batch-1",
                        "name": "auto_annotate",
                        "args": {"paths": ["data/1.jpg"]},
                    },
                    {
                        "id": "batch-2",
                        "name": "auto_annotate",
                        "args": {"paths": ["data/2.jpg", "data/1.jpg"]},
                    },
                ],
            )
        return ChatResult(generations=[ChatGeneration(message=reply)])


class BatchCoalesceMiddleware(AgentMiddleware):
    def after_model(self, state, runtime):
        message = state["messages"][-1]
        calls = list(getattr(message, "tool_calls", []))
        annotation_calls = [call for call in calls if call["name"] == "auto_annotate"]
        if len(annotation_calls) <= 1:
            return None
        paths = list(
            dict.fromkeys(
                path
                for call in annotation_calls
                for path in call["args"].get("paths", [])
            )
        )
        first = annotation_calls[0]
        merged_call = {
            **first,
            "args": {**first["args"], "paths": paths},
        }
        kept = [call for call in calls if call["name"] != "auto_annotate"]
        kept.insert(0, merged_call)
        # Same message id asks LangGraph's message reducer to replace the model
        # output before routing to the tools node.
        return {"messages": [message.model_copy(update={"tool_calls": kept})]}


def main() -> None:
    calls: list[list[str]] = []

    @tool
    def auto_annotate(paths: list[str]) -> str:
        """Annotate a batch of image paths."""
        calls.append(paths)
        return "ok"

    agent = create_agent(
        model=BatchCallModel(),
        tools=[auto_annotate],
        middleware=[BatchCoalesceMiddleware()],
    )
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "标注两张图片"}]}
    )
    assert result["messages"][-1].content == "批量标注已完成"
    assert calls == [["data/1.jpg", "data/2.jpg"]], calls
    print("PASS: after_model middleware merged two annotation calls into one batch")


if __name__ == "__main__":
    main()
