# 学习导航：把模型 API 返回的工具调用规范化为统一数据对象；正文中提到工具名字不等于真正发起调用。
"""工具调用解析：归一化 LLM API 返回的 tool_calls。"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass


# 一条已解析的调用，包含调用 ID、工具名、参数字典和来源标记。
@dataclass(frozen=True)
class ResolvedToolCall:
    tool_call_id: str
    name: str
    arguments: dict
    source: str  # api


# 仅识别正文是否提到客户端工具，供兼容流程提醒模型重新发起正式调用；这里不执行正文。
def client_tool_mentioned_in_text(text: str) -> str | None:
    from app.agent.tools.tool_registry_meta import ASYNC_TOOL_NAMES

    for name in sorted(ASYNC_TOOL_NAMES, key=len, reverse=True):
        if re.search(rf"{re.escape(name)}\s*\(", text, re.IGNORECASE):
            return name
    return None


# 规范模型 API 的调用字典：解析 JSON 参数、补缺失 ID，并过滤无工具名或已完成的调用。
def normalize_api_tool_calls(
    api_tool_calls: list,
    *,
    completed_tools: frozenset[str] | None = None,
) -> list[ResolvedToolCall]:
    completed = completed_tools or frozenset()
    calls: list[ResolvedToolCall] = []
    for call in api_tool_calls or []:
        name = str(call.get("name") or "").strip()
        if not name:
            continue
        tool_id = str(call.get("id") or "").strip()
        if tool_id and tool_id in completed:
            continue
        if not tool_id:
            tool_id = f"tool-{uuid.uuid4().hex[:12]}"
        args = call.get("args") or {}
        if not isinstance(args, dict):
            try:
                import json

                args = json.loads(args) if args else {}
            except Exception:
                args = {}
        calls.append(
            ResolvedToolCall(
                tool_call_id=tool_id,
                name=name,
                arguments=args if isinstance(args, dict) else {},
                source="api",
            )
        )
    return calls
