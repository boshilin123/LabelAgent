# 学习导航：解析单个模型输出分片的通用辅助器；完整图事件和轮末工具处理在 langchain_runtime/sse_adapter.py。
from langchain_core.messages import AIMessageChunk

from app.schemas.agent import StreamEventPayload


# 从 AIMessageChunk 中分别提取文字、推理内容和可选工具参数分片，返回业务事件列表。
# emit_tool_chunks=False 时只处理文字/推理，工具事件交给上层完整轮次逻辑处理。
def events_from_chunk(
    chunk: AIMessageChunk,
    *,
    emit_tool_chunks: bool = True,
) -> list[StreamEventPayload]:
    events: list[StreamEventPayload] = []
    content = chunk.content
    if isinstance(content, str) and content:
        events.append(StreamEventPayload(type="text_delta", content=content))
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text", "")
                if text:
                    events.append(StreamEventPayload(type="text_delta", content=text))

    # 部分兼容接口把推理内容放在 reasoning_content，而普通回答文字在 content 中。
    additional = getattr(chunk, "additional_kwargs", None) or {}
    reasoning = additional.get("reasoning_content")
    if reasoning:
        events.append(StreamEventPayload(type="reasoning_delta", content=str(reasoning)))

    if not emit_tool_chunks:
        return events

    tool_chunks = chunk.tool_call_chunks or []
    for tool_chunk in tool_chunks:
        tool_id = tool_chunk.get("id") or tool_chunk.get("index")
        name = tool_chunk.get("name") or "tool"
        args = tool_chunk.get("args") or ""
        if isinstance(args, dict):
            import json

            args = json.dumps(args, ensure_ascii=False)
        events.append(
            StreamEventPayload(
                type="tool_start",
                tool_call_id=str(tool_id) if tool_id is not None else "tool-pending",
                name=str(name),
                arguments=str(args),
            ),
        )

    return events
