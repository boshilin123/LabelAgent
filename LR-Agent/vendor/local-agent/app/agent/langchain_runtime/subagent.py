"""阶段 5：只读子代理的**单工具包装**（``explore_readonly``）+ 带内 ``custom`` 通道。

对应 ``docs/阶段5-MCP与子代理与视觉设计备忘.md`` §2 与实施清单第 4 项，
以及阶段 5 探针 1（``experiments/probe_stage5_stream_writer.py`` / ``PROBE-STAGE5-FINDINGS.md``）。

**为什么不嵌套 ``create_agent``**（规格 §2 已定，不要重开）：

1. 嵌套 Agent 的 token 会混进父图同一条 flat ``stream_mode="messages"`` 流，
   污染父会话的 ``text_delta``；
2. 官方唯一的子代理设施 ``SubagentTransformer`` 只在 ``astream_events`` 里注册
   （``langchain/agents/factory.py:33,1852``），而阶段 4 备忘 §7 已判定不得改用
   ``astream_events``（``_messages.py:268-272``：直接 ``astream`` 拿到的是 v1 形状）。

**做法**：``explore_readonly`` 仍是**一个普通工具**，工具体内跑既有
:class:`~app.agent.assist.explore_readonly.ExploreReadonlyRunner`，把 runner 产出的
``StreamEventPayload`` **原样**转成 ``runtime.stream_writer`` 的 ``custom`` 帧。

**硬前提（探针 1 实测）**：``stream_mode`` 必须包含 ``"custom"``。
不含时 ``langgraph`` 注入的 writer 是一个本地 ``pass`` 函数
（``langgraph/pregel/main.py:3300-3303``），``custom`` 帧**静默丢弃**、零异常、零帧。
本模块因此在调用 ``stream_writer`` 前**显式断言** writer 可用（见
:func:`_require_writer`），让"模式清单漏配"以显式异常暴露，而不是静默丢帧。

**``ns`` 不可用于来源判定**：``custom`` 分片的 ``ns`` 恒为 ``()``
（``main.py:4234-4235`` + 探针原始输出），与 ``messages``/``updates`` 的 ``ns`` 相同。
适配器只能靠 payload 字段与到达顺序判定来源。

**旧行为逐条对照**（``app/agent/assist/``）：

============================  ==================================================
需求                            旧实现
============================  ==================================================
拿不到写入工具                   ``resolve_explore_inner_names`` 白名单减法 +
                                ``filter_explore_inner_tools``/``_fn_map`` 双过滤
                                （``explore_readonly.py:68-72,87-114``）
自带预算                         ``settings.agent_subagent_max_tool_rounds``
                                （``explore_readonly.py:259-261``）
可取消                          ``explore_readonly.py:268-270,278,358-362``
轨迹不入父消息链                 只有 ``subagent_done.summary`` 变成父的
                                ``ToolMessage``（``tool_loop.py:190,250-261``）
父 ``subagent_*`` 事件不变        ``tool_loop.py:191-215,241-262``
============================  ==================================================

**本模块刻意不重实现任何一项**：白名单、预算、取消、摘要截断全部仍由
``ExploreReadonlyRunner`` 负责；本模块只负责「工具外壳 + 带内通道」。
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from langchain.tools import ToolRuntime
from langchain_core.tools import StructuredTool

from app.agent.assist.explore_readonly import (
    EXPLORE_READONLY_TOOL_NAME,
    ExploreReadonlyRunner,
)
from app.agent.tools.registry import ExploreReadonlyArgs
from app.agent.tools.tool_result import format_tool_result_for_display
from app.schemas.agent import ClientContextInput

__all__ = [
    "EXPLORE_READONLY_DESCRIPTION",
    "SUBAGENT_EVENT_TYPES",
    "SubagentEventCollector",
    "build_explore_readonly_agent_tool",
    "subagent_event_payload",
]


SUBAGENT_EVENT_TYPES: tuple[str, ...] = (
    "subagent_start",
    "subagent_text_delta",
    "subagent_tool_start",
    "subagent_tool_result",
    "subagent_done",
)
"""父会话可见的子代理事件名（**逐字**来自旧路径，不得改名）。

依据：``app/agent/assist/explore_readonly.py:212-217``（``subagent_start``）、
``:287-291`` / ``:415-419``（``subagent_text_delta``）、``:333-339`` /
``:363-369``（``subagent_tool_start``）、``:346-352`` / ``:381-387``
（``subagent_tool_result``）、``:431-436``（``subagent_done``）；
聚合顺序与并发合并见 ``app/agent/assist/tool_loop.py:191-215,664-700``。
"""


EXPLORE_READONLY_DESCRIPTION = (
    "只读查阅子代理：在工作区内搜索/阅读代码与文档"
    "（标注任务还可读已有标注），返回中文摘要。"
    "大范围摸底时使用。query 描述要查什么；focus_path 可选，缩小范围。"
    "本工具不会改文件或写标注；标注与写文件必须由你直接调用对应工具。"
)
"""逐字复刻 ``app/agent/tools/registry.py:539-544`` 的工具描述（父模型可见文本不变）。"""


def subagent_event_payload(event: Any) -> dict[str, Any]:
    """把 runner 的 ``StreamEventPayload`` 转成 ``custom`` 帧 payload（**逐字段**）。

    只保留旧 SSE 载荷里**非 None** 的字段——与
    ``app/schemas/agent.py:171-199`` 的 ``StreamEventPayload.to_sse_dict()``
    同一语义（``None`` 字段不出现），因此适配器可以把这个 dict 直通为 SSE data。

    字段名（``type`` / ``tool_call_id`` / ``content`` / ``name`` / ``arguments`` /
    ``result`` / ``status`` / ``query`` / ``focus_path`` / ``inner_tool_call_id`` /
    ``summary``）与旧载荷一一对应，**不新增、不改名**；
    ``tool_call_id`` 始终是**父**工具的调用 id，``inner_tool_call_id`` 才是内层调用 id
    （``explore_readonly.py:333-339``）。
    """
    payload: dict[str, Any] = {"type": str(event.type)}
    for field in (
        "content",
        "status",
        "summary",
        "tool_call_id",
        "name",
        "arguments",
        "result",
        "query",
        "focus_path",
        "inner_tool_call_id",
    ):
        value = getattr(event, field, None)
        if value is not None:
            payload[field] = value
    return payload


def _require_writer(runtime: Any) -> Callable[[Any], None]:
    """取 ``runtime.stream_writer`` 并断言它**存在且可调用**。

    **为什么断言**：``runtime.stream_writer`` 是唯一的带内通道；拿不到它时
    「子代理事件」会彻底消失而不报错，因此这里把「没有 writer」升级为显式
    ``RuntimeError``。

    **但这一断言挡不住「``stream_mode`` 漏配 ``custom``」**（2026-09-23 S5a 实测，
    **修正探针 1 B 组的结论**）：``Runtime.merge`` 的
    ``stream_writer=other.stream_writer if other.stream_writer is not _no_op_stream_writer
    else self.stream_writer``（``langgraph/runtime.py:248-250``）会在**有父流**时
    用外层 writer 覆盖内层的 no-op。也就是说：

    - 探针 1 B 组在「无父流」的图里测到的是 no-op（结论仍然成立）；
    - 但通过 ``agent.astream(...)`` 驱动时，工具拿到的是**外层 astream 的真 writer**
      （``Pregel.astream.<locals>.stream_writer``），``stream_mode`` 不含
      ``"custom"`` 时帧在外层被**过滤掉** —— 依然是「零帧、零异常」的静默丢弃；
    - 因此**工具侧无法自检**「模式清单是否含 custom」，该断言只能由阶段 4
      适配器/调用方在 ``stream_mode`` 装配处做（规格 §2 的原话）。
      实测证据：``stream_mode=["messages","updates"]`` → 工具执行 1 次、
      ``writer`` 不是 no-op、外层 0 个 custom 帧。
    """
    writer = getattr(runtime, "stream_writer", None)
    if not callable(writer):
        raise RuntimeError(
            "explore_readonly 需要 ToolRuntime.stream_writer："
            "请把 \"custom\" 加入 stream_mode（缺了会静默丢帧，"
            "langgraph/pregel/main.py:3300-3303 与 langgraph/runtime.py:248-250）"
        )
    return writer


class SubagentEventCollector:
    """把 runner 事件转自定义帧的**可替换 sink**（便于直接对工具函数做单元测试）。

    生产路径用 ``runtime.stream_writer``；测试可以传一个 list.append。
    """

    def __init__(self, writer: Callable[[Any], None]) -> None:
        self._writer = writer
        self.frames: list[dict[str, Any]] = []

    def emit(self, event: Any) -> None:
        payload = subagent_event_payload(event)
        self.frames.append(payload)
        self._writer(payload)


async def _run_subagent_stream(
    *,
    runner: Any,
    query: str,
    focus_path: str | None,
    parent_tool_id: str,
    emit: Callable[[Any], None],
) -> tuple[str, str]:
    """跑 runner 并把每个事件交给 ``emit``，返回 ``(summary, status)``。

    异常路径逐字复刻 ``app/agent/assist/tool_loop.py:682-690`` 的兜底
    （``查阅失败：{exc}`` + ``subagent_done(status="error")``），
    保证父会话在 runner 抛错时仍能拿到一条 ``subagent_done`` 与一个工具结果，
    而不是一个裸异常。
    """
    summary = ""
    status = "error"
    try:
        async for event in runner.stream(
            query=query,
            focus_path=focus_path,
            parent_tool_id=parent_tool_id,
        ):
            if getattr(event, "type", None) == "subagent_done":
                summary = getattr(event, "summary", "") or ""
                status = getattr(event, "status", "") or "done"
            emit(event)
    except Exception as exc:  # noqa: BLE001 - 复刻旧路径的兜底文本
        summary = f"查阅失败：{exc}"
        status = "error"
        emit(_done_payload(parent_tool_id=parent_tool_id, summary=summary, status="error"))
    return summary, status


def _done_payload(*, parent_tool_id: str, summary: str, status: str) -> Any:
    from app.schemas.agent import StreamEventPayload

    return StreamEventPayload(
        type="subagent_done",
        tool_call_id=parent_tool_id,
        summary=summary,
        status=status,
    )


def build_explore_readonly_agent_tool(
    *,
    llm: Any,
    settings: Any,
    is_cancelled: Callable[[], Any],
    parent_tools: Sequence[StructuredTool],
    parent_fn_map: dict[str, object],
    client_context: ClientContextInput | None = None,
) -> StructuredTool:
    """构造候选侧的 ``explore_readonly`` 工具（带 ``ToolRuntime`` 带内通道）。

    返回的 ``StructuredTool``：

    - 入参 schema 复用 ``app/agent/tools/registry.py`` 的 :class:`ExploreReadonlyArgs`
      （``query`` 必填 / ``focus_path`` 可选），与旧注册表**同一份**，
      模型可见的 schema 不变（``tests/test_agent_baseline_contract.py`` 的
      ``TestReadOnlyTools`` 依赖工具名与顺序，不依赖实现）；
    - 工具函数声明 ``runtime: ToolRuntime``；实测该形参**不进** tool schema
      （``convert_to_openai_tool`` 走 ``tool_call_schema``，
      见 ``experiments/PROBE-STAGE5-FINDINGS.md`` §新风险 5），
      由 ``langgraph/prebuilt/tool_node.py:2020-2022,841-851`` 注入；
    - 工具**返回值**只有摘要（``build_tool_result`` JSON），= 旧路径
      「父仅得到 ``subagent_done.summary`` → 一条 ``ToolMessage``」；
      完整轨迹从不进入父 ``messages``（``tool_loop.py:190`` docstring 明写）。

    内部仍由 :class:`ExploreReadonlyRunner` 负责白名单减法 / 预算 / 取消，
    本函数**不重复实现**这些保证。
    """
    runner = ExploreReadonlyRunner(
        llm=llm,
        settings=settings,
        is_cancelled=is_cancelled,
        parent_tools=list(parent_tools),
        parent_fn_map=dict(parent_fn_map),
        client_context=client_context,
    )

    async def explore_readonly(
        query: str,
        focus_path: str | None = None,
        runtime: ToolRuntime = None,  # type: ignore[assignment]
    ) -> str:
        if runtime is None:  # pragma: no cover - 只有脱离图直接调用才会走到
            raise RuntimeError(
                "explore_readonly 必须在 langgraph 的 tools 节点内执行"
                "（ToolRuntime 由 tool_node 注入，langgraph/prebuilt/tool_node.py:2020-2022）"
            )
        parent_tool_id = str(getattr(runtime, "tool_call_id", "") or "")
        writer = _require_writer(runtime)
        collector = SubagentEventCollector(writer)
        summary, status = await _run_subagent_stream(
            runner=runner,
            query=(query or "").strip(),
            focus_path=(focus_path or "").strip() or None,
            parent_tool_id=parent_tool_id,
            emit=collector.emit,
        )
        # 旧路径的父侧 tool_result 文本（``tool_loop.py:140-146,253-260``）：
        # ok = status == "done"，tool 固定为 explore_readonly，summary 为空时给占位。
        from app.agent.assist.tool_loop import _explore_result_text

        return format_tool_result_for_display(_explore_result_text(summary, status))

    explore_readonly.__name__ = EXPLORE_READONLY_TOOL_NAME
    explore_readonly.__doc__ = EXPLORE_READONLY_DESCRIPTION

    return StructuredTool.from_function(
        coroutine=explore_readonly,
        name=EXPLORE_READONLY_TOOL_NAME,
        description=EXPLORE_READONLY_DESCRIPTION,
        args_schema=ExploreReadonlyArgs,
    )
