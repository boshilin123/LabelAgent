"""探针 4：同一请求内**重复投递**同一 ``tool_call_id`` 的结果，两侧各自补几条 ``ToolMessage``。

只观测。运行：``PYTHONPATH=. python experiments/probe_stage8_dup_results.py``
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool

from app.agent.context_service import append_client_tool_results_to_messages
from app.agent.langchain_runtime import entry
from app.agent.langchain_runtime.resume import prepare_resume_messages
from app.api.v1 import agent as agent_module
from app.core.config import Settings
from app.schemas.agent import ClientToolResult, ClientContextInput, LocalChatStreamRequest

RESULT = json.dumps(
    {"ok": True, "status": "completed", "file_written": True}, ensure_ascii=False
)


def base_messages(with_tool_message: bool) -> list[Any]:
    messages: list[Any] = [
        HumanMessage(content="写一个文件"),
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "w1",
                    "name": "write_workspace_file",
                    "args": {"relative_path": "a.md"},
                }
            ],
        ),
    ]
    if with_tool_message:
        messages.append(ToolMessage(content=RESULT, tool_call_id="w1"))
    return messages


def counted(with_tool_message: bool, duplicates: int) -> list[tuple[str, str]]:
    messages = base_messages(with_tool_message)
    ctrs = [
        ClientToolResult(tool_call_id="w1", name="write_workspace_file", result=RESULT)
    ] * duplicates
    append_client_tool_results_to_messages(
        messages, ctrs, user_content="写一个文件", proposals_applied=False
    )
    return [(type(m).__name__, str(getattr(m, "tool_call_id", "") or "")) for m in messages]


def resume_turn(with_tool_message: bool, duplicates: int) -> list[tuple[str, str]]:
    ctrs = [
        ClientToolResult(tool_call_id="w1", name="write_workspace_file", result=RESULT)
    ] * duplicates
    out = prepare_resume_messages(
        base_messages(with_tool_message), ctrs, user_content="写一个文件"
    )
    return [(type(m).__name__, str(getattr(m, "tool_call_id", "") or "")) for m in out]


def main() -> None:
    print("append_client_tool_results_to_messages（旧路径直接调用）")
    for with_tm in (False, True):
        for n in (1, 2, 3):
            print(f"  with_tool_message={with_tm} duplicates={n} -> {counted(with_tm, n)}")
    print("prepare_resume_messages（候选路径）")
    for with_tm in (False, True):
        for n in (1, 2, 3):
            print(f"  with_tool_message={with_tm} duplicates={n} -> {resume_turn(with_tm, n)}")


if __name__ == "__main__":
    main()
