# 学习导航：统一工具返回值，供 ToolMessage、运行时规则和展示层读取同一套结果字段。
"""统一 ToolMessage JSON 结构。"""

from __future__ import annotations

import json
from typing import Any

from langchain_core.messages import ToolMessage


# 生成包含成功标记、工具名、状态和摘要的 JSON 字符串，可通过 extra 扩充业务字段。
def build_tool_result(
    *,
    ok: bool,
    tool: str,
    status: str,
    summary: str,
    **extra: Any,
) -> str:
    # file_written 与 proposal_pending 默认都是 False，只有业务执行结果明确说明时才改变。
    payload: dict[str, Any] = {
        "ok": ok,
        "tool": tool,
        "status": status,
        "summary": summary,
        "file_written": extra.pop("file_written", False),
        "proposal_pending": extra.pop("proposal_pending", False),
    }
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False)


# 兼容 ToolMessage、内容与附属数据元组、文本块列表等工具返回值，收成可写入消息的字符串。
def stringify_tool_output(result: Any) -> str:
    """把 StructuredTool / MCP ainvoke 的返回值收成 ToolMessage 字符串。"""
    if isinstance(result, ToolMessage):
        result = result.content
    if isinstance(result, tuple) and result:
        result = result[0]
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, list):
        texts: list[str] = []
        for item in result:
            if isinstance(item, str):
                texts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                texts.append(str(item.get("text") or ""))
            else:
                texts.append(str(item))
        return "\n".join(part for part in texts if part)
    return str(result)


# 优先提取 JSON 结果中的 summary/message 作为可读文字；不是 JSON 就保留原文。
def format_tool_result_for_display(result_text: str) -> str:
    """将 ToolMessage JSON 格式化为 UI/模型可读摘要。"""
    try:
        data = json.loads(result_text)
    except json.JSONDecodeError:
        return result_text
    if not isinstance(data, dict):
        return result_text
    if data.get("summary"):
        return str(data["summary"])
    if data.get("message"):
        return str(data["message"])
    return result_text


# 尝试解析结果 JSON，只有字典才返回；解析失败或数组等类型返回 None。
def parse_tool_result(result_text: str) -> dict[str, Any] | None:
    try:
        data = json.loads(result_text)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None
