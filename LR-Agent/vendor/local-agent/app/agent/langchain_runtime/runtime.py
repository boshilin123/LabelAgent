"""当前默认 Agent 内核：官方 ``create_agent`` 的轻量封装（后端专用）。

学习入口（2026-10-17）：``Settings.agent_engine`` 默认是 ``candidate``，
HTTP 路由经 ``entry.py`` 调用本模块；``candidate`` 是迁移期保留的配置名称。
入口会装配业务 middleware，原始流事件再由 SSE 适配器转换。下述阶段说明
保留迁移背景，不能将阶段 1 的限制当成当前生产行为。

设计边界（对应迁移计划 §5-阶段 1）：

- **依赖方向**：本包不导入 ``app.api.*``；HTTP 层通过 ``entry.py`` 装配内核。
- **模型实例注入**：调用方传入已构造好的 ``BaseChatModel`` 实例（项目里是
  ``ChatOpenAI``），本模块**不实例化任何模型**、不读取任何密钥。
- **工具清单复用**：直接消费 ``app.agent.tools.registry`` 产出的
  ``list[StructuredTool]``，不做任何新的工具抽象、不改 schema。
- **上下文**：模式 / 客户端快照 / 任务阶段 / 客户端工具名集合属于**单次调用内的
  静态上下文**，通过 ``create_agent(context_schema=...)`` + ``astream(context=...)``
  传入，工具侧经 ``langchain.tools.ToolRuntime.context`` 读取。
  不使用 Store，不使用 checkpointer。
- **middleware 注入**：工厂默认空列表；当前业务入口会传入阶段门禁 / 合批去重 /
  预算收尾等 middleware。
- **SSE 映射在外层**：本模块产出官方 v2 原始事件，由适配器负责映射。

阶段 3 对早停的处置（**重要，见 :func:`stream_agent_raw_events` 的
``early_stop_on_client_tools``）：阶段 1 的早停「只要模型消息里出现客户端工具名就
在 tools 节点之前断流」会**静默吞掉同一轮里的合法 SYNC 工具**
（``docs/阶段3-跨请求续跑设计备忘.md`` §2 的实测）。阶段 3 把它降级为
**阶段 1 兼容路径专用**：Agent 一旦挂了 ``after_model`` 业务 middleware
（``BusinessRoundMiddleware`` 等），早停自动禁用，挂起 / 抑制 / 回合终止
完全由 middleware 表达；``app.agent.langchain_runtime.resume`` 另显式传
``early_stop_on_client_tools=False``。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterable, Sequence
from typing import Any

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "AgentContext",
    "AgentEvent",
    "PendingToolCall",
    "STREAM_MODES",
    "STREAM_VERSION",
    "assistant_text",
    "build_langchain_agent",
    "stream_agent_raw_events",
]


STREAM_MODES: tuple[str, str] = ("messages", "updates")
"""阶段 4 适配器需要的两种官方流模式：逐 token 消息 + 节点级状态更新。"""

STREAM_VERSION = "v2"
"""``CompiledStateGraph.astream`` 的 v2 事件格式（事件为 ``{"type","ns","data"}`` 字典）。"""


class AgentContext(BaseModel):
    """单次调用内的静态运行上下文（**不是**长期记忆，也不进 checkpointer）。

    字段语义：

    - ``mode``：交互模式（assist / editor / …），供工具与阶段 2 门禁读取。
    - ``client_context``：客户端界面/项目快照（``ClientContextInput`` 或等价对象）。
    - ``task_phase_context``：任务阶段门禁上下文（``TaskPhaseContext`` 或等价对象）。
    - ``client_tool_names``：**由客户端执行**的工具名集合。这些工具只对模型可见，
      生产候选内核不应在后端执行它们（阶段 1 用早停表达该约束）。
    - ``completed_tool_ids``：**本请求体里已回传结果的客户端 ``tool_call_id``**
      （阶段 3 跨请求播种；= 旧 ``assist_service.py:84-85`` 的 ``completed_ids``）。
      ``BusinessRoundMiddleware`` 读它做 ``already_completed`` 短路，
      使「模型复读上一轮已挂起的调用」不会二次执行 / 二次写盘。
      这是**单次调用内的静态上下文**，随请求体进出，服务端不持久化。
    - ``workspace_root`` / ``extra``：可选的轻量标量，避免为取值再引入新抽象。

    重型业务对象标记为 ``exclude=True``：``Runtime`` 内部的序列化只应处理标量；
    模型实例、Settings 等**不入上下文**，它们通过闭包进入工具。
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    mode: str = Field(default="assist", description="交互模式")
    client_tool_names: frozenset[str] = Field(
        default_factory=frozenset, description="由客户端执行的工具名"
    )
    completed_tool_ids: frozenset[str] = Field(
        default_factory=frozenset,
        description="本请求已回传结果的客户端 tool_call_id（阶段 3 跨请求播种）",
    )
    workspace_root: str | None = Field(default=None, description="工作区根目录")

    client_context: Any = Field(default=None, exclude=True, repr=False)
    task_phase_context: Any = Field(default=None, exclude=True, repr=False)
    extra: dict[str, Any] = Field(default_factory=dict, exclude=True, repr=False)

    def is_client_tool(self, name: str) -> bool:
        """该工具是否由客户端执行（后端不得执行）。"""
        return name in self.client_tool_names


# v2 事件：``{"type": mode, "ns": namespace, "data": payload}``。
# 保留 tuple 形态以兼容旧格式 / 自定义 transformer 输出，本模块不改写事件形状。
AgentEvent = dict[str, Any] | tuple[Any, ...]


def build_langchain_agent(
    model: BaseChatModel,
    tools: Sequence[BaseTool],
    *,
    system_prompt: str | None = None,
    context_schema: type[BaseModel] = AgentContext,
    name: str | None = "lr_agent_candidate",
    middleware: Sequence[AgentMiddleware] = (),
) -> Any:
    """用官方 ``create_agent`` 构建候选 Agent（无 checkpointer）。

    参数：

    - ``model``：**已构造好的**聊天模型实例（项目注入的是 ``ChatOpenAI``）。
      本函数不实例化模型、不读环境变量、不发网络请求。
    - ``tools``：交给 Agent 的工具清单。约定传入
      ``app.agent.tools.registry`` 的输出（或去掉客户端工具后的子集）。
      本函数原样透传，不包装、不改 schema、不重排。
    - ``system_prompt``：可选系统提示。
    - ``context_schema``：运行上下文类型，默认 :class:`AgentContext`。
    - ``name``：图名称，仅用于标识。
    - ``middleware``：阶段 2 起接入的官方/自写 middleware，按**列表顺序**透传给
      ``create_agent``。默认空 = 阶段 1 行为（本参数的加入不改动其余代码路径，
      阶段 1 的 10 个测试因此保持通过）。
      业务件由 ``app.agent.langchain_runtime.middleware.build_business_middleware``
      按规格规定的顺序构造。

    **必须知道的妥协（对阶段 3/4 重要）**：``create_agent`` 只有一份工具清单，
    模型绑定与 ``tools`` 节点执行使用同一份。因此「客户端工具对模型可见、后端零执行」
    现在由 ``BusinessRoundMiddleware.after_model`` 注入 ``ToolMessage`` 表达
    （按 ``tool_call_id`` 把调用从 ``pending_tool_calls`` 中剔除，
    ``langchain/agents/factory.py:1953-1957``）。阶段 3 已让
    :func:`stream_agent_raw_events` 的 messages 流早停**在挂了 after_model 业务件时
    自动失效**（它会在 tools 节点前掐断混合同轮、静默吞掉 SYNC 工具），
    业务路径另显式传 ``early_stop_on_client_tools=False``，见该函数的文档。

    返回官方 ``CompiledStateGraph``（``create_agent`` 的返回值），可直接
    ``astream`` / ``ainvoke``。
    """
    return create_agent(
        model,
        list(tools),
        system_prompt=system_prompt,
        context_schema=context_schema,
        name=name,
        middleware=list(middleware),
    )


class PendingToolCall(dict):
    """客户端工具待执行调用（阶段 4 适配为 ``tool_pending`` 的原始素材）。

    以 ``dict`` 子类承载，方便阶段 4 直接 ``json`` 化；键固定为
    ``tool_call_id`` / ``name`` / ``arguments`` / ``type``。
    """

    def __init__(self, tool_call_id: str, name: str, arguments: dict[str, Any]) -> None:
        super().__init__(
            type="client_tool_pending",
            tool_call_id=tool_call_id,
            name=name,
            arguments=arguments,
        )


def _call_arguments(call: Any) -> dict[str, Any]:
    """从 ``tool_call`` / ``tool_call_chunk`` 归一化出参数字典。

    流式分片里 ``args`` 是**未完成**的 JSON 字符串；此处只做尽力解析，
    解析失败时保留 ``{"__raw__": <片段>}``，绝不抛错、绝不猜测完整参数。
    """
    raw = call.get("args") if isinstance(call, dict) else getattr(call, "args", None)
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return {"__raw__": raw}
        return parsed if isinstance(parsed, dict) else {"__raw__": raw}
    return {}


def _tool_calls_of(message: Any) -> list[Any]:
    calls = getattr(message, "tool_calls", None)
    return list(calls) if calls else []


def _call_name(call: Any) -> str:
    return str(
        (call.get("name") if isinstance(call, dict) else getattr(call, "name", "")) or ""
    )


def _call_id(call: Any) -> str:
    return str(
        (call.get("id") if isinstance(call, dict) else getattr(call, "id", "")) or ""
    )


def _client_calls_in(
    message: Any,
    context: AgentContext,
    *,
    exclude_ids: frozenset[str] | set[str] = frozenset(),
) -> list[PendingToolCall]:
    """从一条模型消息里取出**客户端工具**调用（阶段 4 ``tool_pending`` 的结构素材）。

    ``exclude_ids``：已经有 ``ToolMessage`` 的 ``tool_call_id``（= 本请求体里
    已回传结果的 resume id）。已回传的调用不再作为「待执行」暴露。
    """
    return [
        PendingToolCall(
            tool_call_id=_call_id(call),
            name=_call_name(call),
            arguments=_call_arguments(call),
        )
        for call in _tool_calls_of(message)
        if context.is_client_tool(_call_name(call))
        and _call_id(call) not in exclude_ids
    ]


def _has_after_model_hook(agent: Any) -> bool:
    """Agent 上是否挂了 ``after_model`` middleware hook（= 有业务件表达挂起 / 抑制）。

    ``create_agent`` 为每个带 ``after_model`` 的 middleware 建一个名为
    ``f"{m.name}.after_model"`` 的图节点（``langchain/agents/factory.py:1560-1600``），
    因此这是个稳定的结构判定。用途：**有业务件时早停必须让位**——
    挂起 / 抑制由 ``after_model`` 注入的合成 ``ToolMessage`` + 两段式终止表达，
    早停若同时生效会在 ``tools`` 节点前掐断混合同轮，静默吞掉 SYNC 工具。
    """
    nodes = getattr(agent, "nodes", None)
    if isinstance(nodes, dict):
        return any(str(name).endswith(".after_model") for name in nodes)
    return False


async def stream_agent_raw_events(
    agent: Any,
    messages: Sequence[Any],
    *,
    context: AgentContext | None = None,
    stream_modes: Iterable[str] = STREAM_MODES,
    version: str = STREAM_VERSION,
    pending_calls_out: list[PendingToolCall] | None = None,
    early_stop_on_client_tools: bool | None = None,
) -> AsyncIterator[AgentEvent]:
    """驱动官方 Agent 并**原样**产出流事件，供阶段 4 的 SSE 适配器消费。

    **命名约定**：阶段 4 的 SSE 适配器公开 `stream_agent_events(...)`
    （见 `docs/阶段4-SSE适配设计备忘.md:114`，产出 `StreamEventPayload`）。
    本函数是它下面那层，因此刻意叫 `stream_agent_raw_events`，
    以免阶段 4 落地时与本模块同名冲突——阶段 4 应直接调用本函数，
    不要复制它的 task+queue 骨架。

    产出形状（未做任何改写，``version="v2"``）：

    - ``{"type": "messages", "ns": (...), "data": (message, metadata)}``
      —— v1 回调形状的 ``AIMessageChunk`` / 工具产生的 ``ToolMessage``；
      注意：直接 ``astream`` 时 `data[0]` **不会**变成 `astream_events` 的协议事件 dict
      （`langgraph/pregel/_messages.py:268-272`、`main.py:2813-2820`）；
    - ``{"type": "updates", "ns": (...), "data": {node: {"messages": [...]}}}``
      —— 节点级更新（``model`` / ``tools``）。

    **本模块不做的事件处理**（留给阶段 4）：文本/reasoning 的 delta 抽取、
    ``tool_start`` / ``tool_result`` / ``file_proposal*`` 映射、``preparing`` 与 ``done``。

    **阶段 3 对早停的处置**（``early_stop_on_client_tools``）：

    - ``None``（默认）**自动判定**：Agent 上存在 ``after_model`` middleware hook
      （即挂了 ``BusinessRoundMiddleware`` 之类的业务件）时**禁用**早停；
      否则保持阶段 1 行为（``context.client_tool_names`` 非空即启用）。
    - ``True`` / ``False``：显式启用 / 禁用（``True`` 仅供阶段 1 兼容路径与测试）。

    为什么有业务件时必须禁用：阶段 1 的早停判据是「模型消息里出现客户端工具名即
    ``break``」，它在 ``tools`` 节点**之前**掐断，会静默吞掉同一轮里的合法 SYNC 调用
    （``docs/阶段3-跨请求续跑设计备忘.md`` §2 实测：``[SYNC, ASYNC]`` 混合轮 SYNC 零执行），
    而且会让 ``after_model`` 连计划都算不出来（阶段 4 因此看不到计划帧）。
    挂了业务件后，挂起 / 抑制 / 回合终止全部由 ``after_model`` 注入的合成
    ``ToolMessage`` + 两段式终止表达（阶段 2），早停的角色被完全取代；
    ASYNC 工具的「后端零执行」另由 ``awrap_tool_call`` 无条件硬拦保证。

    ``pending_calls_out``（**已弃用，见下**）语义（跨轮累加、按 ``tool_call_id`` 去重）：
    本次运行中模型发起的客户端工具调用（按 ``context.client_tool_names`` 判定，
    即**结构防线**），**排除**输入 ``messages`` 里已有 ``ToolMessage`` 的 id
    （resume 已回传的调用不再当作待执行）。

    ⚠️ **弃用声明（阶段 8 收尾 F3，2026-09-23）**：``pending_calls_out`` 是
    **按工具名的近似**，它**不是**权威的「本轮挂起集合」，也没有任何生产消费者：

    - 候选入口 ``app/agent/langchain_runtime/entry.py`` **不传**该参数；
      适配器 ``sse_adapter.stream_agent_events`` 也不读它（它自己从 ``updates`` 里
      取 ``round_plan``，见 ``sse_adapter.py::_resolve_round_plan``）。全仓唯一
      传参者是测试，而测试是在**钉住本近似**，不是在消费它。
    - 它与权威集合**在构成上就不同**（阶段 3 实测 + ``round_plan.py``）：

      1. ``round_plan.deferred`` 只含**合并后存活**的 ASYNC 调用，被
         ``already_completed`` / ``phase_blocked`` / ``coalesced`` / ``duplicate_call``
         抑制的调用在 ``round_plan.suppressed`` 里，而本参数会把它们一并记入；
      2. 本参数**也**记录**被真正执行**的客户端工具名（阶段 3 用例
         ``pending`` 含 ``p1`` 即「已执行」的存根工具），权威集合只含挂起项；
      3. 无 ``round_plan`` 的配置（阶段 1 兼容路径：Figure 上没有 ``after_model``
         业务件）根本**没有**权威集合，本参数此时仍有值。
    - **权威来源**：``BusinessRoundMiddleware.after_model`` 写进 state 的
      ``round_plan.deferred``（:class:`~app.agent.langchain_runtime.round_plan.RoundPlan`），
      适配器经 ``_resolve_round_plan(updates)`` 读取；``tool_pending`` 帧由
      ``emit_tool_pending(deferred_calls)`` 发出（``sse_adapter.py::_round_tail``）。

    为什么不「接线」成权威集合：本参数在 ``finally`` 里**流结束后**才回填，
    而 ``tool_pending`` 帧是**流中**发出的（适配器在自己的轮末发出），
    因此把它改成权威集合也无法被任何真实消费者使用；反之会**改变**
    阶段 1/阶段 3 既有断言（被禁改的 ``tests/test_langchain_runtime_stage{1,3}.py``
    分别钉住「无计划路径仍有值」与「含已执行调用」两种近似语义）。
    语义钉子测试：``tests/test_langchain_runtime_pending_calls_deprecation.py``。

    ``messages`` 直接作为图输入 ``{"messages": [...]}``；不追加/修改调用方消息。
    取消：调用方 ``aclose()`` 本生成器（或 ``break``）时，``finally`` 会
    ``cancel()`` 并 ``await`` 掉包装 ``astream`` 的后台 task
    （阶段 4 备忘 §7 要求）。
    """
    ctx = context if context is not None else AgentContext()
    pending: list[PendingToolCall] = []
    seen_pending_ids: set[str] = set()
    if pending_calls_out is None:
        pending_calls_out = []

    if early_stop_on_client_tools is None:
        early_stop = bool(ctx.client_tool_names) and not _has_after_model_hook(agent)
    else:
        early_stop = bool(early_stop_on_client_tools)
    answered_ids = {
        str(getattr(message, "tool_call_id", "") or "")
        for message in messages
        if getattr(message, "type", None) == "tool"
    }
    answered_ids.discard("")

    if "messages" not in tuple(stream_modes):
        msg = (
            "stream_agent_raw_events 需要 stream_modes 含 'messages'"
            "（否则不会产出逐 token 消息事件）"
        )
        raise ValueError(msg)

    agen = agent.astream(
        {"messages": list(messages)},
        context=ctx,
        stream_mode=list(stream_modes),
        version=version,
    )
    queue: asyncio.Queue[Any] = asyncio.Queue()
    _DONE = object()

    async def _pump() -> None:
        try:
            async for event in agen:
                queue.put_nowait(event)
        except asyncio.CancelledError:  # 早停时的正常路径
            raise
        except BaseException as exc:  # noqa: BLE001 - 异常透传给调用方
            queue.put_nowait(exc)
        finally:
            queue.put_nowait(_DONE)

    task = asyncio.create_task(_pump())
    try:
        while True:
            item = await queue.get()
            if item is _DONE:
                break
            if isinstance(item, BaseException):
                raise item

            stop_after_this = False
            if isinstance(item, dict) and item.get("type") == "messages":
                data = item.get("data")
                if isinstance(data, tuple) and data:
                    found = _client_calls_in(data[0], ctx, exclude_ids=answered_ids)
                    if found:
                        for call in found:
                            call_id = str(call["tool_call_id"])
                            if call_id in seen_pending_ids:
                                continue
                            seen_pending_ids.add(call_id)
                            pending.append(call)
                        # 早停（阶段 1 兼容路径）：命中客户端工具名即在本事件后断流。
                        # 业务路径不会走到这里（自动判定见上文；resume 驱动显式传 False）。
                        stop_after_this = early_stop

            yield item

            if stop_after_this:
                break
    finally:
        if not task.done():
            task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        # 显式闭合底层 astream：即使 task 已自行结束，也保证生成器的 finally 跑过
        await agen.aclose()

    pending_calls_out.extend(pending)


def assistant_text(messages: Sequence[Any]) -> str:
    """从 Agent 最终状态取出最后一条 AI 消息的文本（供阶段 4 / 调试使用）。

    这是**便利函数**，不参与事件流；不存在 AI 消息时返回空串。
    """
    for message in reversed(list(messages)):
        if getattr(message, "type", None) == "ai":
            content = getattr(message, "content", "")
            return content if isinstance(content, str) else str(content)
    return ""
