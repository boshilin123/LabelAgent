"""工具调用解析：归一化 LLM API 返回的 tool_calls。"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class ResolvedToolCall:
    tool_call_id: str
    name: str
    arguments: dict
    source: str  # api


def client_tool_mentioned_in_text(text: str) -> str | None:
    from app.agent.tools.tool_registry_meta import ASYNC_TOOL_NAMES

    for name in sorted(ASYNC_TOOL_NAMES, key=len, reverse=True):
        if re.search(rf"{re.escape(name)}\s*\(", text, re.IGNORECASE):
            return name
    return None


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
