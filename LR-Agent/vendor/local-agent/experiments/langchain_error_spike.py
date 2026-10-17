"""Compare default and adapted tool-error handling in LangChain Agent.

Run from vendor/local-agent with LangChain 1.x installed:
    python -m experiments.langchain_error_spike
"""

import json

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from experiments.langchain_policy_spike import OneToolModel


class ToolErrorMiddleware(AgentMiddleware):
    def wrap_tool_call(self, request, handler):
        try:
            return handler(request)
        except Exception as exc:
            return ToolMessage(
                content=json.dumps(
                    {
                        "ok": False,
                        "status": "error",
                        "summary": f"工具执行失败: {exc}",
                    },
                    ensure_ascii=False,
                ),
                name=request.tool_call["name"],
                tool_call_id=request.tool_call["id"],
                status="error",
            )


def main() -> None:
    @tool
    def failing_tool() -> str:
        """Fail intentionally to test Agent recovery behavior."""
        raise RuntimeError("expected probe failure")

    model = OneToolModel(tool_name="failing_tool", tool_args={})
    default_agent = create_agent(model=model, tools=[failing_tool])
    try:
        default_agent.invoke(
            {"messages": [{"role": "user", "content": "测试失败工具"}]}
        )
    except RuntimeError as exc:
        assert "expected probe failure" in str(exc)
    else:
        raise AssertionError("default framework unexpectedly converted tool error")
    print("GAP: default tool exception aborts the Agent invocation")

    adapted_agent = create_agent(
        model=model,
        tools=[failing_tool],
        middleware=[ToolErrorMiddleware()],
    )
    result = adapted_agent.invoke(
        {"messages": [{"role": "user", "content": "测试失败工具"}]}
    )
    errors = [
        message
        for message in result["messages"]
        if isinstance(message, ToolMessage) and message.status == "error"
    ]
    assert len(errors) == 1 and "expected probe failure" in errors[0].content
    assert result["messages"][-1].content == "已收到工具结果"
    print("PASS: middleware converts tool error to a ToolMessage for model recovery")


if __name__ == "__main__":
    main()
