# 学习导航：没有工作区/标注工具上下文时的普通聊天流程，直接请求模型，不经过 create_agent 工具图。
from collections.abc import AsyncIterator

from langchain_openai import ChatOpenAI

from app.core.streaming import closing_stream

from app.agent.stream_adapter import events_from_chunk
from app.schemas.agent import StreamEventPayload


# 先发送准备状态，再逐段读取模型输出并转换成项目事件；没有工具循环和客户端挂起。
async def stream_chat(
    llm: ChatOpenAI,
    lc_messages: list,
) -> AsyncIterator[StreamEventPayload]:
    yield StreamEventPayload(type="preparing", stage="streaming")
    async with closing_stream(llm.astream(lc_messages)) as _events_stream:
        async for chunk in _events_stream:
            for event in events_from_chunk(chunk, emit_tool_chunks=False):
                yield event
