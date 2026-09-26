"""阶段 5：视觉 middleware —— 兜底的「首轮无 tool call 加载附图」+ 主动调用的附图。

对应 ``docs/阶段5-MCP与子代理与视觉设计备忘.md`` §3,§5 与实施清单第 5/6 项。
两件 middleware：

- :class:`VisionFallbackMiddleware`（``after_model``）——旧「首轮无 tool call →
  自动加载附图」，机制由探针 2 实测确定（``experiments/probe_stage5_after_model_vision.py``
  + ``experiments/PROBE-STAGE5-FINDINGS.md``）；附图尾条由阶段 5b 探针补上
  （``experiments/probe_stage5b_multimodal.py``）。
- :class:`VisionToolResultMiddleware`（``wrap_tool_call``）——旧「模型主动调用
  ``read_image_for_vision`` → 工具结果之后追加附图」（``tool_loop.py:339-347``），
  阶段 5b 新增。

**旧语义（逐条对照）**

===================================  ==========================================
需求                                  旧实现
===================================  ==========================================
触发时机 = **第一轮且无 tool call**     ``app/agent/assist_service.py:158-167``
                                      （``round_idx == 0`` 且 ``had_tool_call`` 为假）
不是「进模型前」（无 ``try_bootstrap``） ``tests/test_vision_bootstrap.py:6-9``
触发前提                              ``vision_bootstrap.py:42-46``
                                      （非 resume / provider_is_vision /
                                      vision_fn 存在 / user_content 命中图片正则）
路径解析 + 存在性                      ``assist_vision.py:52-57``
                                      （``pick_vision_relative_path`` →
                                      ``vision_relative_from_user_text`` →
                                      ``can_bootstrap_vision``）
工具执行                              ``assist_vision.py:78-82``
                                      （``asyncio.to_thread(vision_fn, relative_path=...)``）
失败文本                              ``assist_vision.py:81-82``
                                      （``工具执行失败: {exc}``，**不新增 ``error`` 帧**）
事件顺序                              ``assist_vision.py:71-104``
                                      （``tool_start`` → ``tool_result`` → 附图消息）
===================================  ==========================================

**为什么必须放 ``after_model``**（规格 §3）：没有 checkpointer 时框架不把累积消息链
交回调用方（``langchain/agents/factory.py:1194-1220`` 的 ``_handle_model_output``
只返回 delta），调用侧无法对「同一条消息链」发起第二次 ``astream``。

**唯一可用的注入形状**（探针 2 Q2 六形态实测；阶段 5b 追加多模态尾条）：

.. code-block:: python

    {"messages": [
        AIMessage(content="", tool_calls=[{"name": <vision tool>, "args": {...},
                                           "id": "lr-vision-fallback-*",
                                           "type": "tool_call"}]),
        ToolMessage(content=display_result, tool_call_id=<同一个 id>, name=<tool>),
        # 旧路径同一步还会追加附图消息（``assist_vision.py:96-104``）；
        # 仅当读图成功且 provider 支持视觉时存在。
        HumanMessage(content=[{"type": "text", "text": ...},
                              {"type": "image_url",
                               "image_url": {"url": "data:image/jpeg;base64,..."}}]),
    ]}

``AI`` 在前、``ToolMessage`` 在后、``tool_call_id`` 一致。顺序颠倒 / id 不匹配 /
只注 ``AI`` 都会把伪调用 ``Send`` 给 ``tools`` 节点并得到
``not a valid tool`` 的错误结果；只注 ``ToolMessage`` **不会**回跳模型。
``ToolMessage.status`` 与 ``name`` **不参与**判定，只有 ``tool_call_id`` 参与。

**末尾的多模态 ``HumanMessage`` 不影响回跳**（阶段 5b 探针实测）：路由边
```_fetch_last_ai_and_tool_messages```（``factory.py:1914-1918``）是**从末尾往前找
最后一条 ``AIMessage``**，再收集它之后的 ``ToolMessage``；因此尾条 ``HumanMessage``
既不参与 pending 判定也不影响 ``model_calls``。实测：``[AI, Tool, Human(图)]`` →
``model_calls=2``、无 ``tools`` 节点、**第二次调用输入里 image_url 块数 = 1**；
对照现状 ``[AI, Tool]`` → image_url 块数 = 0（探针
``experiments/probe_stage5b_multimodal.py`` + ``.out.txt``）。
另两条候选通道实测：``wrap_model_call`` 追加（通道 2）同样可行但要多一个 hook；
``ExtendedModelResponse``（通道 3）**不可行**——它的 ``Command`` 由
``_build_commands``（``factory.py:258``）在**模型节点跑完之后**才落到 state，
第二次调用已经发完，输入里 image_url 块数仍为 0。

**框架侧回跳支点**：``langchain/agents/factory.py:1950-1957``（按 ``tool_call_id``
剔除 pending）+ ``:1970-1972``（「AIMessage 有 tool calls 但没有 pending tool calls
⇒ 注入的是人造工具消息，跳回 model 节点」）。

**轮次守卫必须无条件落盘**（探针 Q4d/Q4e，本模块最重要的一条）：
朴素实现「只在真正触发时置 ``vision_attempted``」在「第一轮调了真实工具、
第二轮无调用」时会**误触发**兜底（实测 ``model_calls=3``）。旧语义是
「**第一轮**无 tool call」。因此 :meth:`VisionFallbackMiddleware.after_model`
**每次**都返回 ``{"vision_rounds": n}``（n 单调自增），只有 ``n == 1`` 才允许触发。
修正后实测 ``model_calls=2``。

**必须放 ``extra=[...]`` 的末位**（规格 §5 风险 4）：``after_model`` 逆序执行
（``langchain/agents/factory.py:1789-1800``），列表末位 = **最先**执行；
``loop_exit_node`` 是列表里**第一个**带 ``after_model`` 的中间件
（``factory.py:1664-1665``），因此把本件放末位才能保住
``BusinessRoundMiddleware`` 的 ``loop_exit_node`` 地位与 ``jump_to`` 控制权。
本件**不声明** ``@hook_config(can_jump_to=...)``（实测不需要 ``jump_to``），
因此不参与/不干扰 jump 链。

**兄弟路径（本文件第二件 middleware）**：旧的
``tool_loop.py:339-347``「模型**主动**调用 ``read_image_for_vision`` → 工具结果之后
追加多模态 ``HumanMessage``」由 :class:`VisionToolResultMiddleware` 承担，
落点 ``wrap_tool_call``（返回 ``Command``）。它**不能**用 ``after_model`` 表达：
``after_model`` 在 ``tools`` 节点**之前**跑（``factory.py:1789`` 的
model → after_model 边），此时真实工具还没执行、拿不到结果。探针实测两条可用落点
（``wrap_tool_call`` / 下一轮 ``wrap_model_call``）均成立，本文件取前者以保住
「附图紧跟工具结果」的旧顺序。

**已知预算交互（报告，不修）**：兜底那次模型调用被
``ModelCallLimitMiddleware`` / ``BudgetWrapUpMiddleware`` 照常计数（探针 Q7）：
``max_tool_rounds=0``（``wrap_up_at=2``）时兜底轮正好撞上收尾轮，
call#2 的输入末尾会多出一条「预算已用完」的 ``HumanMessage``；
调用总数仍是 2（**占用**而非新增一轮）。``max_tool_rounds=1`` 不受影响。

**本文件的一处实现选择（不是语义偏差）**：``after_model`` 同时提供
**同步**版与 **async** 版（``aafter_model``）。框架的 ``RunnableCallable``
（``factory.py:1603-1615``）在 Sync/Async 两种执行下各取一个；``astream`` 走
``aafter_model``。两版共用同一个 :meth:`VisionFallbackMiddleware._compute`，
唯一差别是「如何驱动 async 的 ``stream_vision_tool_execution``」：
异步版直接 ``await``（保留 ``asyncio.to_thread`` 的线程池语义），
同步版用 ``asyncio.run`` 之外的自建循环驱动（``after_model`` 只被同步调用时用）。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, AgentState
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage
from langgraph.types import Command
from typing_extensions import NotRequired

from app.agent.assist.vision_bootstrap import VisionAutoLoader
from app.agent.assist_vision import (
    can_bootstrap_vision,
    pick_vision_relative_path,
    stream_vision_tool_execution,
    vision_relative_from_user_text,
)
from app.agent.chat_message_builder import build_multimodal_user_message
from app.agent.tools.tool_result import format_tool_result_for_display
from app.agent.tools.workspace_file_reader import (
    VISION_TOOL_NAME,
    extract_vision_path_from_tool_result,
)
from app.schemas.agent import ClientContextInput

__all__ = [
    "VISION_FALLBACK_ID_PREFIX",
    "VISION_FALLBACK_IMAGE_TEXT",
    "VisionFallbackMiddleware",
    "VisionFallbackState",
    "VisionToolResultMiddleware",
    "vision_event_payload",
]


VISION_FALLBACK_ID_PREFIX = "lr-vision-fallback-"
"""伪 ``tool_call_id`` 前缀，逐字复刻 ``app/agent/assist/vision_bootstrap.py:57``。

探针 2 用 ``lr-vision-fallback-1``；生产用 ``uuid4().hex[:10]``（与旧路径同）。
"""


VISION_FALLBACK_IMAGE_TEXT = "【附图】请根据上图回答用户关于该图片的问题。"
"""逐字复刻 ``app/agent/assist_vision.py:99``（``stream_vision_tool_execution`` 内使用）。"""


class VisionFallbackState(AgentState):
    """视觉兜底的 state 扩展（与 ``BusinessRoundState`` **无键冲突**，可共存）。

    - ``vision_rounds``：``after_model`` 被调用的轮次（1-based，**无条件**自增）；
    - ``vision_attempted``：本轮 run 是否已经触发过兜底（幂等守卫）。
    """

    vision_rounds: NotRequired[int]
    vision_attempted: NotRequired[bool]


def vision_event_payload(event: Any) -> dict[str, Any] | None:
    """``StreamEventPayload`` → custom 帧 dict（``None`` 字段不出现，同 ``to_sse_dict``）。"""
    etype = getattr(event, "type", None)
    if not isinstance(etype, str) or not etype:
        return None
    payload: dict[str, Any] = {"type": etype}
    for field in (
        "content",
        "status",
        "summary",
        "tool_call_id",
        "name",
        "arguments",
        "result",
    ):
        value = getattr(event, field, None)
        if value is not None:
            payload[field] = value
    return payload


async def _collect_vision_execution(
    *,
    tool_id: str,
    relative_path: str,
    vision_fn: Callable[..., str],
    provider_is_vision: bool,
    settings: Any,
) -> tuple[list[Any], list[AnyMessage], str]:
    """跑旧 ``stream_vision_tool_execution``，收集事件 + 消息 + 展示文本。

    返回 ``(events, messages, display_result)``。事件集合就是旧路径
    ``tool_start`` → ``tool_result``（``assist_vision.py:71-93``）；
    ``messages`` 侧仍是 ``ToolMessage`` → 附图 ``HumanMessage``
    （``assist_vision.py:94-104``）。

    **与旧代码的唯一差别**：旧实现的 ``messages.append`` 直接改父消息链；
    这里先在局部列表里收集，再由 ``after_model`` 的返回 dict 注入——
    因为没有 checkpointer 时 hook 拿不到「可写的累积链」引用（规格 §3）。
    """
    collected: list[AnyMessage] = []
    events: list[Any] = []
    async for event in stream_vision_tool_execution(
        tool_id=tool_id,
        relative_path=relative_path,
        vision_fn=vision_fn,
        provider_is_vision=provider_is_vision,
        settings=settings,
        messages=collected,
    ):
        events.append(event)

    display = ""
    for message in collected:
        if isinstance(message, ToolMessage):
            display = str(getattr(message, "content", "") or "")
            break
    if not display:
        for event in reversed(events):
            if getattr(event, "type", None) == "tool_result":
                display = format_tool_result_for_display(
                    str(getattr(event, "result", "") or "")
                )
                break
    return events, collected, display


def _drive_sync(coro: Any) -> Any:
    """在**同步** ``after_model`` 里驱动 async 协程。

    ``asyncio.to_thread`` 只要求「事件循环存在」，不要求当前帧是协程：
    自建循环 + ``run_until_complete`` 与 ``asyncio.run`` 等价，
    但不会在「当前线程已有运行中的 loop」时抛 ``RuntimeError``
    （那是 ``asyncio.run`` 的限制，而框架的 ``RunnableCallable`` 异步分支
    已由 ``aafter_model`` 覆盖，同步分支只会在没有 loop 的线程里跑）。
    """
    new_loop = asyncio.new_event_loop()
    try:
        return new_loop.run_until_complete(coro)
    finally:
        try:
            new_loop.run_until_complete(new_loop.shutdown_asyncgens())
        finally:
            new_loop.close()


class VisionFallbackMiddleware(AgentMiddleware):
    """复刻旧「首轮无 tool call → 自动加载附图」的 ``after_model`` 兜底。

    构造参数与旧 ``VisionAutoLoader`` **同源**（``vision_bootstrap.py:28-40``）：
    触发器判定直接复用 ``VisionAutoLoader.should_load(is_resume)``，
    路径解析复用 ``pick_vision_relative_path`` / ``vision_relative_from_user_text`` /
    ``can_bootstrap_vision``，工具执行复用 ``stream_vision_tool_execution``——
    本类**不重写**任何一段旧逻辑。

    **实例不保存 per-run 状态**（middleware 实例跨并发 run 共享）：
    轮次与幂等标记只走 state 通道。
    """

    state_schema = VisionFallbackState

    def __init__(
        self,
        *,
        vision_fn: Callable[..., str] | None,
        provider_is_vision: bool,
        settings: Any,
        client_context: ClientContextInput | None = None,
        user_content: str = "",
        is_resume: bool = False,
    ) -> None:
        super().__init__()
        self._loader = VisionAutoLoader(
            vision_fn=vision_fn,
            provider_is_vision=provider_is_vision,
            settings=settings,
            client_context=client_context,
            user_content=user_content,
        )
        self._settings = settings
        self._client_context = client_context
        self._user_content = user_content or ""
        self._is_resume = bool(is_resume)

    # ── 触发条件（= 旧 ``assist_service.py:158-167`` + ``vision_bootstrap.py:42-57``）──
    def should_load(self) -> bool:
        """``vision_fn`` 存在、provider 支持视觉、非 resume、且 user_content 命中图片正则。

        直接复用旧 ``VisionAutoLoader.should_load``（``vision_bootstrap.py:42-46``），
        与 ``tests/test_vision_bootstrap.py:12-53`` 的四个分支同源。
        """
        return bool(self._loader.should_load(self._is_resume))

    def resolve_relative_path(self) -> str:
        """解析候选相对路径（``vision_bootstrap.py:52-54``）。"""
        rel = pick_vision_relative_path(self._client_context)
        if not rel and self._user_content.strip():
            rel = vision_relative_from_user_text(self._user_content)
        return rel

    def resolve_vision_path(self) -> str:
        """解析并校验为存在的图片（``assist_vision.py:50-57``）；不合格返回空串。"""
        rel = self.resolve_relative_path()
        if not can_bootstrap_vision(self._client_context, rel):
            return ""
        return rel

    # ── hook：after_model（同步 + async 两版，逻辑同一份）────────────────
    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """同步版（``invoke`` / 同步图执行走这条）。"""
        return _drive_sync(self._compute(state, runtime))

    async def aafter_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """异步版（``astream`` 走这条；与同步版共用 :meth:`_compute`）。"""
        return await self._compute(state, runtime)

    # ── 核心：轮次守卫 + 触发 + 注入 ────────────────────────────────
    async def _compute(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """第一轮无 tool call 时注入「合成 AI 伪调用 + 匹配 ToolMessage」。

        **轮次计数无条件落盘**（见模块 docstring）：无论走哪个分支，
        本方法都至少返回 ``{"vision_rounds": n}``。
        """
        rounds = (
            int(state.get("vision_rounds") or 0) + 1 if isinstance(state, dict) else 1
        )
        # 无条件落盘的轮次计数——放这里而不是触发分支里：朴素实现会在
        # 「第一轮有真实工具」时 return None 丢计数，第二轮被当成首轮
        # （探针实测 model_calls=3）。
        update: dict[str, Any] = {"vision_rounds": rounds}

        messages = state["messages"] if isinstance(state, dict) else state.messages
        last = messages[-1] if messages else None

        # 旧语义 = **第一轮**无 tool call（``assist_service.py:158-167``）。
        if rounds > 1:
            return update
        if not isinstance(last, AIMessage):
            return update
        if list(getattr(last, "tool_calls", None) or []):
            return update
        if isinstance(state, dict) and state.get("vision_attempted"):
            return update
        if not self.should_load():
            return update

        rel = self.resolve_vision_path()
        if not rel:
            return update

        tool_id = f"{VISION_FALLBACK_ID_PREFIX}{uuid.uuid4().hex[:10]}"
        vision_fn = self._loader.vision_fn
        assert vision_fn is not None  # should_load() 已保证  # noqa: S101

        events, collected, display = await _collect_vision_execution(
            tool_id=tool_id,
            relative_path=rel,
            vision_fn=vision_fn,
            provider_is_vision=self._loader.provider_is_vision,
            settings=self._settings,
        )

        # 帧按到达顺序发出（旧顺序：tool_start → tool_result）。这些帧走
        # ``custom`` 流，不会与 ``messages`` 流里的合成 AI/ToolMessage 混在一起
        # （探针风险 1：那两个 BaseMessage 也会被回放到 ``messages``，适配器
        # 必须按 ``langgraph_node`` 后缀 ``.after_model`` 过滤）。
        writer = getattr(runtime, "stream_writer", None)
        if callable(writer):
            for event in events:
                payload = vision_event_payload(event)
                if payload is not None:
                    writer(payload)

        fake_ai = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": VISION_TOOL_NAME,
                    "args": {"relative_path": rel},
                    "id": tool_id,
                    "type": "tool_call",
                }
            ],
        )
        # 只注入 ToolMessage 的「工具结果」那一半：附图 ``HumanMessage`` 与它同批追加
        # （旧 ``assist_vision.py:94-104`` 的顺序：ToolMessage → 附图消息）。
        # 阶段 5b 起**不再丢弃**这条 HumanMessage —— 没有它，第二次模型调用看不到图，
        # 兜底就退化成「让文本模型看一串 JSON」。形状由阶段 5b 探针实测（见模块 docstring）。
        tool_message = ToolMessage(
            content=display,
            tool_call_id=tool_id,
            name=VISION_TOOL_NAME,
        )
        # ``_collect_vision_execution`` 依据旧 ``stream_vision_tool_execution`` 的语义
        # 决定是否追加附图（``if vision_path and provider_is_vision``）：读图失败、
        # 结果里没有 ``__vision_image_path__`` 标记、或 provider 不支持视觉时，
        # ``collected`` 里就只有 ToolMessage，这里自然退化为原来的两件批。
        image_messages = [m for m in collected if isinstance(m, HumanMessage)]
        update["messages"] = [fake_ai, tool_message, *image_messages]
        update["vision_attempted"] = True
        return update


class VisionToolResultMiddleware(AgentMiddleware):
    """复刻旧「模型**主动**调用 ``read_image_for_vision`` → 工具结果之后追加附图」。

    旧实现（``app/agent/assist/tool_loop.py:339-347``，同一段也在
    ``assist_vision.py:96-104`` 的兜底分支里）：

    .. code-block:: python

        if vision_path and provider_is_vision:
            messages.append(await build_multimodal_user_message(
                "【附图】请根据上图回答用户关于该图片的问题。",
                image_absolute_path=vision_path,
                max_edge=settings.agent_chat_vision_max_edge,
                jpeg_quality=settings.agent_chat_vision_jpeg_quality,
            ))

    这里放 ``wrap_tool_call``（``langchain/agents/middleware/types.py:677`` 允许返回
    ``Command``，见 ``factory.py:213-258`` 的 ``_build_commands``）：工具结果由框架的
    ``tools`` 节点产出，本条把 ``ToolMessage`` 与附图 ``HumanMessage`` **按旧顺序**
    一起作为 state 更新落盘（``add_messages`` reducer 追加），于是**下一次**模型调用
    就能看到图。

    阶段 5b 探针实测（``experiments/probe_stage5b_multimodal.py`` 的 ``toolD`` 组）：
    ``model_calls=2``、``tools`` 节点照常出现、真工具恰好执行 1 次、
    call#2 输入 = ``[..., AIMessage(真调用), ToolMessage(结果), HumanMessage(图)]``
    且 image_url 块数 = 1。同探针的 ``toolE`` 组（改用 ``wrap_model_call`` 在下一轮
    追加）也能达成同样效果，但消息不进 state；本类选 ``wrap_tool_call`` 以保持
    「附图紧跟在工具结果之后」这一旧顺序。

    **触发条件与旧路径逐条同源**：``provider_is_vision`` 为真、工具名是
    ``read_image_for_vision``、且结果里能解析出 ``__vision_image_path__``
    （``extract_vision_path_from_tool_result``，非视觉工具恒返回 ``None``）。
    图片编码复用 :func:`~app.agent.chat_message_builder.build_multimodal_user_message`
    ——本类**不重写**任何 base64 / JPEG 逻辑。

    **本类不产出 ``tool_start`` / ``tool_result`` 帧**：工具是**真实调用**，
    帧由工具的 ``ToolRuntime.stream_writer`` 路径负责（旧路径同：真实工具轮不发
    兜底帧）。
    """

    def __init__(self, *, provider_is_vision: bool, settings: Any) -> None:
        super().__init__()
        self._provider_is_vision = bool(provider_is_vision)
        self._settings = settings

    async def _image_message(self, vision_path: str) -> HumanMessage:
        """与旧路径逐字同参（``tool_loop.py:340-347``）。"""
        return await build_multimodal_user_message(
            VISION_FALLBACK_IMAGE_TEXT,
            image_absolute_path=vision_path,
            max_edge=self._settings.agent_chat_vision_max_edge,
            jpeg_quality=self._settings.agent_chat_vision_jpeg_quality,
        )

    def _vision_path_of(self, request: Any, result: Any) -> str:
        if not self._provider_is_vision or not isinstance(result, ToolMessage):
            return ""
        name = str(getattr(request, "tool_call", {}).get("name") or "")
        return extract_vision_path_from_tool_result(name, str(result.content)) or ""

    def wrap_tool_call(self, request: Any, handler: Any) -> Any:
        """同步版（``invoke`` / 同步图执行走这条）。"""
        return _drive_sync(self._awrap(request, handler, sync_handler=handler))

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        """异步版（``astream`` 走这条）。"""
        return await self._awrap(request, handler, sync_handler=None)

    async def _awrap(self, request: Any, handler: Any, *, sync_handler: Any) -> Any:
        if sync_handler is None:
            result = await handler(request)
        else:
            result = handler(request)
        vision_path = self._vision_path_of(request, result)
        if not vision_path:
            return result
        human = await self._image_message(vision_path)
        return Command(update={"messages": [result, human]})
