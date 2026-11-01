# 学习导航：把需要客户端执行的调用打包为 tool_pending 事件，供兼容路径通知客户端接手。
"""发出 tool_pending SSE 并结束当前 HTTP 轮次。"""

import json
from collections.abc import AsyncIterator

from app.agent.tool_invocation import ResolvedToolCall
from app.schemas.agent import ClientToolCallPayload, StreamEventPayload


# 把多条已解析调用转成客户端载荷并发出事件；实际客户端执行结果会在下一请求回传。
async def emit_tool_pending(
    calls: list[ResolvedToolCall],
) -> AsyncIterator[StreamEventPayload]:
    """发出 tool_pending SSE 并结束当前 HTTP 轮次。"""
    pending_calls = [
        ClientToolCallPayload(
            tool_call_id=c.tool_call_id,
            name=c.name,
            arguments=c.arguments,
        )
        for c in calls
    ]
    for c in calls:
        yield StreamEventPayload(
            type="tool_start",
            tool_call_id=c.tool_call_id,
            name=c.name,
            arguments=json.dumps(c.arguments, ensure_ascii=False, indent=2),
        )
    yield StreamEventPayload(
        type="tool_pending",
        client_tool_calls=pending_calls,
    )
