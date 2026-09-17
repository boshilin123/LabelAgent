"""主循环预算耗尽的兜底总结：耗尽时强制一次无工具最终回答，正常结束不触发。"""

from langchain_core.messages import HumanMessage

from app.agent.assist_service import stream_assist
from app.schemas.agent import ClientContextInput


class MockChunk:
    """Mock AIMessageChunk（与 test_tool_loop 同款）。"""

    def __init__(self, content="", tool_call_chunks=None, tool_calls=None, additional_kwargs=None):
        self.content = content
        self.tool_call_chunks = tool_call_chunks or []
        self.tool_calls = tool_calls
        self.additional_kwargs = additional_kwargs or {}

    def __add__(self, other):
        merged_tool_calls = (self.tool_calls or []) + (other.tool_calls or [])
        return MockChunk(
            content=(self.content or "") + (other.content or ""),
            tool_call_chunks=self.tool_call_chunks + other.tool_call_chunks,
            tool_calls=merged_tool_calls,
            additional_kwargs={**self.additional_kwargs, **other.additional_kwargs},
        )


class CountingMockChat:
    """按轮次返回预设 chunk 序列，并记录 astream 被调用的次数。"""

    def __init__(self, rounds):
        self._rounds = list(rounds)
        self.astream_calls = 0

    def bind_tools(self, tools, tool_choice=None):
        return self

    async def astream(self, messages):
        self.astream_calls += 1
        chunks = self._rounds.pop(0) if self._rounds else []
        for chunk in chunks:
            yield chunk


async def _never_cancel() -> bool:
    return False


async def _collect(async_iter):
    return [e async for e in async_iter]


def _tool_round(call_id: str) -> list:
    return [
        MockChunk(
            tool_calls=[
                {
                    "id": call_id,
                    "name": "read_workspace_file",
                    "args": {"relative_path": "a.md"},
                }
            ]
        )
    ]


async def _run(llm, max_tool_rounds: int):
    return await _collect(
        stream_assist(
            llm,
            [HumanMessage(content="帮我整理工作区")],
            [],
            settings=None,  # type: ignore[arg-type]
            max_tool_rounds=max_tool_rounds,
            is_cancelled=_never_cancel,
            client_context=ClientContextInput(workspace_root="/w"),
            user_content="帮我整理工作区",
        )
    )


async def test_budget_exhaustion_forces_final_answer() -> None:
    """预算耗尽时：追加 HumanMessage 并强制一次无工具回答，产出 text_delta。"""
    llm = CountingMockChat(
        [
            _tool_round("call-1"),
            _tool_round("call-2"),
            # 兜底调用（无工具 bind）的输出
            [MockChunk(content="预算已用完。当前进展：已读取 a.md，尚未完成整理。")],
        ]
    )
    events = await _run(llm, max_tool_rounds=1)

    # 两次带工具的轮 + 一次兜底 = 3 次 astream
    assert llm.astream_calls == 3
    texts = [e.content or "" for e in events if e.type == "text_delta"]
    assert any("预算已用完" in t for t in texts)


async def test_normal_completion_skips_wrapup() -> None:
    """模型自己停止（无 tool call）时正常 break，不触发兜底调用。"""
    llm = CountingMockChat(
        [
            _tool_round("call-1"),
            [MockChunk(content="整理完成。")],
        ]
    )
    events = await _run(llm, max_tool_rounds=5)

    assert llm.astream_calls == 2
    texts = [e.content or "" for e in events if e.type == "text_delta"]
    assert any("整理完成" in t for t in texts)
    assert not any("预算已用完" in t for t in texts)
