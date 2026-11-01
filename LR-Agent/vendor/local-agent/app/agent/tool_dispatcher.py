# 学习导航：工具调用的分类与规范化入口；这里只分组，不实际运行工具。
"""统一工具调度：按 registry runner 拆分 API 调用结果。"""

from __future__ import annotations

from dataclasses import dataclass

from app.agent.tool_invocation import ResolvedToolCall, normalize_api_tool_calls
from app.agent.tools.tool_registry_meta import ToolRunner, get_tool_runner


# 保存本轮后端立即处理的调用和需要交给客户端的调用两组结果。
@dataclass(frozen=True)
class SplitToolCalls:
    immediate: list[ResolvedToolCall]
    async_pending: list[ResolvedToolCall]


# 根据工具元数据拆分调用；PROPOSAL 与普通 SYNC 都先由后端处理，ASYNC 留给客户端。
def split_resolved_calls(calls: list[ResolvedToolCall]) -> SplitToolCalls:
    immediate: list[ResolvedToolCall] = []
    async_pending: list[ResolvedToolCall] = []
    for call in calls:
        if get_tool_runner(call.name) is ToolRunner.ASYNC:
            async_pending.append(call)
        else:
            immediate.append(call)
    return SplitToolCalls(immediate=immediate, async_pending=async_pending)


# 仅解析模型接口的正式 tool_calls，不把回答正文里的伪代码当作可执行调用。
def resolve_round_tool_calls(
    *,
    api_tool_calls: list,
    completed_tools: frozenset[str] | None = None,
) -> list[ResolvedToolCall]:
    """仅使用 LLM API tool_calls 解析，不再回退伪代码。"""
    return normalize_api_tool_calls(
        api_tool_calls,
        completed_tools=completed_tools,
    )
