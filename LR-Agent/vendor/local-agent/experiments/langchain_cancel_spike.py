"""Backend-only cancellation probe for a framework-managed model turn.

Run from vendor/local-agent with LangChain 1.x installed:
    python -m experiments.langchain_cancel_spike
"""

import asyncio

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool


class SlowToolCallModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return "slow-cancel-spike"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        raise AssertionError("async Agent must use _agenerate")

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        await asyncio.sleep(0.5)
        reply = AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "cancel-call-1",
                    "name": "auto_annotate",
                    "args": {"paths": ["sample.jpg"]},
                }
            ],
        )
        return ChatResult(generations=[ChatGeneration(message=reply)])


async def main() -> None:
    calls: list[list[str]] = []

    @tool
    async def auto_annotate(paths: list[str]) -> str:
        """Record a backend annotation dispatch for this cancellation probe."""
        calls.append(paths)
        return "ok"

    agent = create_agent(model=SlowToolCallModel(), tools=[auto_annotate])
    task = asyncio.create_task(
        agent.ainvoke({"messages": [{"role": "user", "content": "标注 sample.jpg"}]})
    )
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("agent task did not cancel")
    await asyncio.sleep(0.55)
    assert calls == [], calls
    print("PASS: cancelling a model turn before tool selection caused no tool call")


if __name__ == "__main__":
    asyncio.run(main())
