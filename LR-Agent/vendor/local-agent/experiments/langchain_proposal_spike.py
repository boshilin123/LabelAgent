"""Probe file-proposal tool-call chunks through framework Agent streaming.

Run from vendor/local-agent with the isolated upgraded environment:
    python -m experiments.langchain_proposal_spike
"""

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import tool

from app.agent.assist.proposal_streamer import ProposalStreamInterceptor


class StreamingWriteModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return "streaming-proposal-spike"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if any(isinstance(item, ToolMessage) for item in messages):
            reply = AIMessage(content="提案完成")
        else:
            reply = AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "write-1",
                        "name": "write_workspace_file",
                        "args": {"relative_path": "notes/report.md", "content": "hello"},
                    }
                ],
            )
        return ChatResult(generations=[ChatGeneration(message=reply)])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        if any(isinstance(item, ToolMessage) for item in messages):
            yield ChatGenerationChunk(message=AIMessageChunk(content="提案完成"))
            return
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": "write_workspace_file",
                        "id": "write-1",
                        "index": 0,
                        "args": '{"relative_path":"notes/report.md","content":"hel',
                    }
                ],
            )
        )
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {"name": None, "id": None, "index": 0, "args": 'lo"}'},
                ],
            )
        )


def main() -> None:
    @tool
    def write_workspace_file(relative_path: str, content: str) -> str:
        """Return a fake file-proposal result without writing a file."""
        return f"proposal:{relative_path}:{content}"

    agent = create_agent(
        model=StreamingWriteModel(), tools=[write_workspace_file]
    )
    interceptor = ProposalStreamInterceptor()
    proposal_events = []
    for part in agent.stream(
        {"messages": [{"role": "user", "content": "写报告"}]},
        stream_mode=["messages", "updates"],
        version="v2",
    ):
        if part["type"] != "messages":
            continue
        message, _metadata = part["data"]
        if isinstance(message, AIMessageChunk):
            proposal_events.extend(interceptor.on_chunk(message))
    assert [event.type for event in proposal_events] == [
        "file_proposal_start",
        "file_proposal_delta",
        "file_proposal_delta",
    ], proposal_events
    assert "".join(event.content or "" for event in proposal_events) == "hello"
    assert proposal_events[0].to_sse_dict()["suggestedRelativePath"] == (
        "notes/report.md"
    )
    print("PASS: framework exposes tool-call chunks for existing proposal SSE parser")


if __name__ == "__main__":
    main()
