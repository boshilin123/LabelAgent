"""Backend-only parity probes for the default LangChain Agent behavior.

Run in the isolated LangChain 1.x spike environment:
    python experiments/langchain_parity_probe.py
"""

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool


class DuplicateCallModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return "duplicate-probe"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if any(isinstance(message, ToolMessage) for message in messages):
            reply = AIMessage(content="完成")
        else:
            reply = AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": f"duplicate-{index}",
                        "name": "count_annotation",
                        "args": {"paths": ["sample.jpg"]},
                    }
                    for index in range(2)
                ],
            )
        return ChatResult(generations=[ChatGeneration(message=reply)])


def main() -> None:
    calls: list[list[str]] = []

    @tool
    def count_annotation(paths: list[str]) -> str:
        """Count actual annotation tool invocations."""
        calls.append(paths)
        return "ok"

    agent = create_agent(model=DuplicateCallModel(), tools=[count_annotation])
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "标注 sample.jpg"}]}
    )
    assert result["messages"][-1].content == "完成"
    assert calls == [["sample.jpg"], ["sample.jpg"]], calls
    print("GAP: default create_agent executes duplicate same-scope tool calls twice")

    parts = list(
        agent.stream(
            {"messages": [{"role": "user", "content": "标注 sample.jpg"}]},
            stream_mode="updates",
            version="v2",
        )
    )
    assert parts and all(part["type"] == "updates" for part in parts), parts
    print("PASS: framework emits updates; existing SSE event mapping remains untested")


if __name__ == "__main__":
    main()
