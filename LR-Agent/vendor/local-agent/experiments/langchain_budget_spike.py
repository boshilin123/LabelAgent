"""Check framework tool-round termination against the backend's budget policy.

Run from vendor/local-agent with LangChain 1.x installed:
    python -m experiments.langchain_budget_spike
"""

from langchain.agents import create_agent
from langchain.agents.middleware import ModelCallLimitMiddleware
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool


class AlwaysCallModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return "always-tool-spike"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        prior_calls = sum(isinstance(item, ToolMessage) for item in messages)
        reply = AIMessage(
            content="",
            tool_calls=[
                {
                    "id": f"budget-call-{prior_calls + 1}",
                    "name": "read_status",
                    "args": {},
                }
            ],
        )
        return ChatResult(generations=[ChatGeneration(message=reply)])


def main() -> None:
    calls: list[str] = []

    @tool
    def read_status() -> str:
        """Return a harmless status for the round-budget probe."""
        calls.append("read")
        return "ok"

    agent = create_agent(
        model=AlwaysCallModel(),
        tools=[read_status],
        middleware=[ModelCallLimitMiddleware(run_limit=2, exit_behavior="end")],
    )
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "检查状态"}]}
    )
    assert len(calls) == 2, calls
    assert not result["messages"][-1].tool_calls
    print("PASS: model-call limit ended an otherwise unbounded tool loop")
    print("FINAL:", repr(result["messages"][-1].content))


if __name__ == "__main__":
    main()
