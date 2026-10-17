"""阶段 5b 探针（step 1）：把**多模态 HumanMessage** 送进兜底后第二次模型调用。

## 缺口

阶段 5a 的 ``app/agent/langchain_runtime/vision.py`` 只注入
``[AIMessage(伪 tool_call), ToolMessage(结果)]``，第二次模型调用**看不到图**；
旧路径在同一步还追加一条多模态 ``HumanMessage``（``assist_vision.py:96-104`` →
``chat_message_builder.py:53-80``），让纯文本模型真正「看一眼」图。
没有这一条，兜底功能上是**退化**的。

## 本探针要 settle 的问题

对 ``create_agent(model, [至少一个真实工具], middleware=[...])`` 构建的图，
**哪条通道能把多模态 ``HumanMessage`` 放进第二次模型调用的输入**？

通道（按优先级）:

1. 延长 ``after_model`` 注入批：
   ``[AI(伪 tool_call), ToolMessage(结果), HumanMessage([text, image_url])]``
   —— 路由边 ``_make_model_to_tools_edge`` 只从**末尾往前找最后一条 AIMessage**
   （``factory.py:1914-1918``），因此末尾多一条 ``HumanMessage`` 理论上不影响
   回跳；但必须实测。
2. ``wrap_model_call`` 中间件：仅在**兜底轮**把多模态 ``HumanMessage`` 追加进
   ``request.messages``。
3. ``ExtendedModelResponse``（``middleware/types.py:290-311``）：
   ``wrap_model_call`` 返回 ``Command(update={"messages": [...]})``。

**附**：sibling 路径（旧 ``tool_loop.py:339-347``「模型主动调用了
``read_image_for_vision`` → 工具结果之后追加多模态 HumanMessage」）也一并探。
候选落点：``wrap_tool_call`` 返回 ``Command``（``types.py:677`` 允许）、
或下一次 ``wrap_model_call`` 追加。

## 运行

工作目录 ``LR-Agent\\vendor\\local-agent``::

    ..\\..\\..\\.venvs\\langchain-migration\\Scripts\\python.exe experiments\\probe_stage5b_multimodal.py

离线、确定性：假模型（``ScriptedChat``）、假 vision 函数、2x2 PNG 写盘到临时目录。
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
import tempfile
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, AgentState
from langchain.agents.middleware.types import (
    ExtendedModelResponse,
    ModelResponse,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from langgraph.types import Command
from pydantic import Field
from typing_extensions import NotRequired

from app.agent.assist_vision import stream_vision_tool_execution
from app.agent.langchain_runtime.middleware import build_business_middleware
from app.agent.langchain_runtime.runtime import AgentContext
from app.agent.langchain_runtime.vision import VISION_FALLBACK_ID_PREFIX
from app.agent.tools.workspace_file_reader import (
    VISION_PATH_MARKER,
    VISION_TOOL_NAME,
    extract_vision_path_from_tool_result,
)
from app.schemas.agent import ClientContextInput

# 2x2 RGB PNG（75 字节，离线常量，可被 PIL 识别）。
#
# **注意**：``tests/test_langchain_runtime_stage5a.py`` 里原先的 ``PNG_1X1`` 常量
# 是**损坏的**——``PIL.Image.open`` 直接抛 ``UnidentifiedImageError``，
# 于是 ``_encode_image_data_url`` 返回 ``None``、``build_multimodal_user_message``
# 退化成纯文本 ``HumanMessage``，阶段 5a 那条「第二次调用没有 image_url」的断言
# 是**空过**的（不管图好坏都成立）。本探针用真 PNG，否则通道判定会建立在假前提上。
PNG_VALID = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a73"
    "0000001249444154789c633c21a7c1c0c0c0c40006000d720112415a2335000000"
    "0049454e44ae426082"
)

STREAM_MODES = ["messages", "updates", "custom"]


# ── 假模型 ─────────────────────────────────────────────────────────────


class ScriptedChat(BaseChatModel):
    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)

    @property
    def _llm_type(self) -> str:
        return "probe-stage5b-scripted-chat"

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [getattr(t, "name", str(t)) for t in tools]
        return self

    def _round(self) -> list[AIMessageChunk]:
        index = int(self.counters.get("calls", 0))
        self.counters["calls"] = index + 1
        if index < len(self.rounds):
            return self.rounds[index]
        return [AIMessageChunk(content="")]

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        merged: AIMessageChunk | None = None
        for chunk in self._round():
            merged = chunk if merged is None else merged + chunk
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content=merged.content if merged else "",
                        tool_calls=list(merged.tool_calls) if merged else [],
                    )
                )
            ]
        )

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return self._generate(messages)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.counters.setdefault("inputs", []).append(list(messages))
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


def tc_chunk(name: str, args: dict, call_id: str) -> AIMessageChunk:
    return AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "name": name,
                "args": json.dumps(args, ensure_ascii=False),
                "id": call_id,
                "index": 0,
                "type": "tool_call_chunk",
            }
        ],
    )


# ── 工具 / settings / 图片 ─────────────────────────────────────────────


class SimpleSettings:
    def __init__(self, **kwargs: Any) -> None:
        self.agent_chat_vision_max_edge = kwargs.pop("agent_chat_vision_max_edge", 1280)
        self.agent_chat_vision_jpeg_quality = kwargs.pop(
            "agent_chat_vision_jpeg_quality", 85
        )
        for key, value in kwargs.items():
            setattr(self, key, value)


class VisionState(AgentState):
    vision_rounds: NotRequired[int]
    vision_attempted: NotRequired[bool]


def noop_tool(counter: dict[str, int]) -> StructuredTool:
    def _noop(message: str = "") -> str:
        counter["noop"] = counter.get("noop", 0) + 1
        return json.dumps({"ok": True, "message": message}, ensure_ascii=False)

    return StructuredTool.from_function(func=_noop, name="noop", description="noop")


def vision_tool(counter: dict[str, int], image_abs: str) -> StructuredTool:
    """真实 ``read_image_for_vision`` 存根：返回带 VISION_PATH_MARKER 的 JSON。"""

    def _read(relative_path: str = "") -> str:
        counter[VISION_TOOL_NAME] = counter.get(VISION_TOOL_NAME, 0) + 1
        return json.dumps(
            {
                "ok": True,
                "path": image_abs,
                "name": relative_path,
                "width": 2,
                "height": 2,
                "format": "PNG",
                VISION_PATH_MARKER: image_abs,
                "message": f"已加载图片 {relative_path}（2x2 PNG）。",
            },
            ensure_ascii=False,
        )

    return StructuredTool.from_function(
        func=_read, name=VISION_TOOL_NAME, description="读图"
    )


def make_vision_fn(image_abs: str):
    def _fn(relative_path: str = "") -> str:
        return json.dumps(
            {
                "ok": True,
                "path": image_abs,
                "name": relative_path,
                "width": 2,
                "height": 2,
                "format": "PNG",
                VISION_PATH_MARKER: image_abs,
                "message": f"已加载图片 {relative_path}（2x2 PNG）。",
            },
            ensure_ascii=False,
        )

    return _fn


async def collect_vision_messages(
    *,
    tool_id: str,
    relative_path: str,
    vision_fn: Any,
    settings: Any,
) -> tuple[list[Any], list[Any]]:
    """**复用生产 helper** ``stream_vision_tool_execution`` 收集事件与消息。"""
    collected: list[Any] = []
    events: list[Any] = []
    async for event in stream_vision_tool_execution(
        tool_id=tool_id,
        relative_path=relative_path,
        vision_fn=vision_fn,
        provider_is_vision=True,
        settings=settings,
        messages=collected,
    ):
        events.append(event)
    return events, collected


# ── 中间件：兜底路径三条通道 ───────────────────────────────────────────


class FallbackBase(AgentMiddleware):
    """兜底注入（AI 伪调用 + ToolMessage），``extra`` 为空时 = 现状(5a)。"""

    state_schema = VisionState

    def __init__(self, *, rel: str, image_abs: str, settings: Any, extra: str = "none"):
        super().__init__()
        self._rel = rel
        self._image_abs = image_abs
        self._settings = settings
        self._extra = extra
        self.counters: dict[str, int] = {}

    async def _build_batch(self, tool_id: str) -> tuple[list[Any], list[Any]]:
        events, collected = await collect_vision_messages(
            tool_id=tool_id,
            relative_path=self._rel,
            vision_fn=make_vision_fn(self._image_abs),
            settings=self._settings,
        )
        display = ""
        for message in collected:
            if isinstance(message, ToolMessage):
                display = str(getattr(message, "content", "") or "")
                break
        fake_ai = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": VISION_TOOL_NAME,
                    "args": {"relative_path": self._rel},
                    "id": tool_id,
                    "type": "tool_call",
                }
            ],
        )
        batch: list[Any] = [
            fake_ai,
            ToolMessage(content=display, tool_call_id=tool_id, name=VISION_TOOL_NAME),
        ]
        if self._extra == "human":
            batch.extend(m for m in collected if isinstance(m, HumanMessage))
        return batch, events

    async def _compute(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        rounds = (
            int(state.get("vision_rounds") or 0) + 1 if isinstance(state, dict) else 1
        )
        update: dict[str, Any] = {"vision_rounds": rounds}
        messages = state["messages"] if isinstance(state, dict) else state.messages
        last = messages[-1] if messages else None
        if rounds > 1 or not isinstance(last, AIMessage):
            return update
        if list(getattr(last, "tool_calls", None) or []):
            return update
        if isinstance(state, dict) and state.get("vision_attempted"):
            return update

        tool_id = f"{VISION_FALLBACK_ID_PREFIX}{len(self.counters):04d}"
        self.counters["triggered"] = self.counters.get("triggered", 0) + 1
        batch, events = await self._build_batch(tool_id)
        writer = getattr(runtime, "stream_writer", None)
        if callable(writer):
            for event in events:
                writer({"type": getattr(event, "type", "?"), "tool_call_id": tool_id})
        update["messages"] = batch
        update["vision_attempted"] = True
        return update

    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(self._compute(state, runtime))
        finally:
            loop.close()

    async def aafter_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return await self._compute(state, runtime)


class AppendImageInWrapModelCall(AgentMiddleware):
    """通道 2：兜底轮在 ``wrap_model_call`` 里追加多模态消息到 ``request.messages``。"""

    state_schema = VisionState

    def __init__(self, *, rel: str, image_abs: str, settings: Any) -> None:
        super().__init__()
        self._rel = rel
        self._image_abs = image_abs
        self._settings = settings
        self.observed: list[str] = []

    @staticmethod
    def _has_image(messages: list[Any]) -> bool:
        for message in messages:
            content = getattr(message, "content", None)
            if isinstance(content, list) and any(
                isinstance(block, dict) and block.get("type") == "image_url"
                for block in content
            ):
                return True
        return False

    async def _human(self) -> HumanMessage:
        _events, collected = await collect_vision_messages(
            tool_id="probe-wrap-image",
            relative_path=self._rel,
            vision_fn=make_vision_fn(self._image_abs),
            settings=self._settings,
        )
        for message in collected:
            if isinstance(message, HumanMessage):
                return message
        raise AssertionError("生产 helper 未产出多模态 HumanMessage")

    async def awrap_model_call(self, request, handler):
        state = getattr(request, "state", None) or {}
        flag = bool(state.get("vision_attempted")) if isinstance(state, dict) else False
        self.observed.append(f"flag={flag} has_image={self._has_image(request.messages)}")
        if flag and not self._has_image(request.messages):
            human = await self._human()
            request = request.override(messages=[*request.messages, human])
        return await handler(request)


class ExtendCommandInWrapModelCall(AgentMiddleware):
    """通道 3：``ExtendedModelResponse`` + ``Command(update={"messages":[...]})``。"""

    state_schema = VisionState

    def __init__(self, *, rel: str, image_abs: str, settings: Any) -> None:
        super().__init__()
        self._rel = rel
        self._image_abs = image_abs
        self._settings = settings
        self.observed: list[str] = []

    async def _human(self) -> HumanMessage:
        _events, collected = await collect_vision_messages(
            tool_id="probe-ext-image",
            relative_path=self._rel,
            vision_fn=make_vision_fn(self._image_abs),
            settings=self._settings,
        )
        for message in collected:
            if isinstance(message, HumanMessage):
                return message
        raise AssertionError("生产 helper 未产出多模态 HumanMessage")

    async def awrap_model_call(self, request, handler):
        state = getattr(request, "state", None) or {}
        flag = bool(state.get("vision_attempted")) if isinstance(state, dict) else False
        self.observed.append(f"flag={flag}")
        response = await handler(request)
        if flag:
            human = await self._human()
            if isinstance(response, ModelResponse):
                return ExtendedModelResponse(
                    model_response=response,
                    command=Command(update={"messages": [human]}),
                )
        return response


# ── 中间件：sibling 路径（模型主动调用视觉工具）────────────────────────


class AppendImageAfterVisionToolCall(AgentMiddleware):
    """sibling-通道 D：``wrap_tool_call`` 返回 ``Command``（ToolMessage + 图）。"""

    def __init__(self, *, image_abs: str, settings: Any) -> None:
        super().__init__()
        self._image_abs = image_abs
        self._settings = settings
        self.observed: list[str] = []

    async def _human(self) -> HumanMessage:
        _events, collected = await collect_vision_messages(
            tool_id="probe-tool-image",
            relative_path="demo.png",
            vision_fn=make_vision_fn(self._image_abs),
            settings=self._settings,
        )
        for message in collected:
            if isinstance(message, HumanMessage):
                return message
        raise AssertionError("生产 helper 未产出多模态 HumanMessage")

    async def awrap_tool_call(self, request, handler):
        result = await handler(request)
        name = str(request.tool_call.get("name") or "")
        self.observed.append(f"tool={name} result={type(result).__name__}")
        if name == VISION_TOOL_NAME and isinstance(result, ToolMessage):
            path = extract_vision_path_from_tool_result(name, str(result.content))
            if path:
                human = await self._human()
                return Command(update={"messages": [result, human]})
        return result


class AppendImageAfterVisionToolResultInWrapModelCall(AgentMiddleware):
    """sibling-通道 E：下一轮 ``wrap_model_call`` 里追加（判定同通道 2）。"""

    def __init__(self, *, image_abs: str, settings: Any) -> None:
        super().__init__()
        self._image_abs = image_abs
        self._settings = settings
        self.observed: list[str] = []

    async def _human(self) -> HumanMessage:
        _events, collected = await collect_vision_messages(
            tool_id="probe-wrap2-image",
            relative_path="demo.png",
            vision_fn=make_vision_fn(self._image_abs),
            settings=self._settings,
        )
        for message in collected:
            if isinstance(message, HumanMessage):
                return message
        raise AssertionError("生产 helper 未产出多模态 HumanMessage")

    async def awrap_model_call(self, request, handler):
        messages = request.messages
        last = messages[-1] if messages else None
        tool_name = ""
        if isinstance(last, ToolMessage):
            tool_name = str(getattr(last, "name", "") or "")
        pending_image = (
            extract_vision_path_from_tool_result(tool_name, str(last.content))
            if isinstance(last, ToolMessage)
            else None
        )
        self.observed.append(f"tool={tool_name} pending_image={bool(pending_image)}")
        has_image = any(
            isinstance(getattr(m, "content", None), list)
            and any(
                isinstance(b, dict) and b.get("type") == "image_url" for b in m.content
            )
            for m in messages
        )
        if pending_image and not has_image:
            human = await self._human()
            request = request.override(messages=[*request.messages, human])
        return await handler(request)


# ── 驱动 / 观测 ────────────────────────────────────────────────────────


async def drive(agent: Any) -> list[Any]:
    raw: list[Any] = []
    async for event in agent.astream(
        {"messages": [HumanMessage(content="看看 demo.png")]},
        context=AgentContext(),
        stream_mode=STREAM_MODES,
        version="v2",
    ):
        raw.append(event)
    return raw


def update_node_keys(raw: list[Any]) -> list[list[str]]:
    return [
        sorted(event["data"])
        for event in raw
        if isinstance(event, dict) and event.get("type") == "updates"
    ]


def describe(message: Any) -> str:
    """把一条消息压成可读摘要（base64 截断）。"""
    role = getattr(message, "type", type(message).__name__)
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return f"{role}(str): {content[:60]!r}"
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                parts.append(f"<{type(block).__name__}>")
                continue
            kind = block.get("type")
            if kind == "image_url":
                url = str((block.get("image_url") or {}).get("url") or "")
                prefix = url.split(",", 1)[0]
                parts.append(f"image_url[{prefix}, b64len={len(url)}]")
            else:
                parts.append(f"{kind}={str(block.get('text'))[:40]!r}")
        return f"{role}(list): [{', '.join(parts)}]"
    return f"{role}: {content!r}"


def count_images(messages: list[Any]) -> int:
    total = 0
    for message in messages:
        content = getattr(message, "content", None)
        if isinstance(content, list):
            total += sum(
                1
                for block in content
                if isinstance(block, dict) and block.get("type") == "image_url"
            )
    return total


def report_case(title: str, raw: list[Any], model: ScriptedChat) -> None:
    print(f"\n===== {title} =====")
    calls = int(model.counters.get("calls", 0))
    nodes = update_node_keys(raw)
    print(f"model_calls = {calls}")
    print(f"tools_node_seen = {any('tools' in keys for keys in nodes)}")
    print(f"update_node_keys = {nodes}")
    inputs = model.counters.get("inputs", [])
    for index, messages in enumerate(inputs, start=1):
        print(
            f"--- model call #{index} input ({len(messages)} messages, "
            f"image_url_blocks={count_images(messages)}) ---"
        )
        for position, message in enumerate(messages):
            print(f"  [{position}] {describe(message)}")


# ── 场景 ───────────────────────────────────────────────────────────────


async def scenario_fallback(tmp: pathlib.Path, mode: str) -> None:
    (tmp / "demo.png").write_bytes(PNG_VALID)
    image_abs = str(tmp / "demo.png")
    settings = SimpleSettings()
    ctx = ClientContextInput(workspace_root=str(tmp))
    counter: dict[str, int] = {}

    base = FallbackBase(
        rel="demo.png",
        image_abs=image_abs,
        settings=settings,
        extra="none" if mode != "channel1" else "human",
    )
    middleware: list[Any] = [base]
    wrap = None
    extended = None
    if mode == "channel2":
        wrap = AppendImageInWrapModelCall(
            rel="demo.png", image_abs=image_abs, settings=settings
        )
        middleware = [base, wrap]
    elif mode == "channel3":
        extended = ExtendCommandInWrapModelCall(
            rel="demo.png", image_abs=image_abs, settings=settings
        )
        middleware = [base, extended]

    model = ScriptedChat(
        rounds=[[AIMessageChunk(content="直接回答")], [AIMessageChunk(content="补充")]]
    )
    agent = create_agent(
        model,
        [noop_tool(counter)],
        context_schema=AgentContext,
        middleware=middleware,
        name=f"s5b_{mode}",
    )
    raw = await drive(agent)
    report_case(f"兜底路径 / {mode}", raw, model)
    print(f"vision_triggers = {base.counters.get('triggered', 0)}")
    print(f"real_tool_executions = {counter}")
    print(f"workspace_root_present = {bool(ctx.workspace_root)}")
    if wrap is not None:
        print(f"wrap_model_call observations = {wrap.observed}")
    if extended is not None:
        print(f"wrap_model_call(ext) observations = {extended.observed}")


async def scenario_fallback_with_business(tmp: pathlib.Path) -> None:
    """通道 1 + 真实阶段 2 栈（含 ``build_business_middleware``）的回归。"""
    (tmp / "demo.png").write_bytes(PNG_VALID)
    image_abs = str(tmp / "demo.png")
    settings = SimpleSettings()
    base = FallbackBase(
        rel="demo.png", image_abs=image_abs, settings=settings, extra="human"
    )
    counter: dict[str, int] = {}
    model = ScriptedChat(
        rounds=[[AIMessageChunk(content="直接回答")], [AIMessageChunk(content="补充")]]
    )
    stack = build_business_middleware(max_tool_rounds=2, extra=[base])
    agent = create_agent(
        model,
        [noop_tool(counter)],
        context_schema=AgentContext,
        middleware=stack,
        name="s5b_channel1_business",
    )
    raw = await drive(agent)
    report_case("兜底路径 / channel1 + build_business_middleware", raw, model)
    print(f"real_tool_executions = {counter}")


async def scenario_sibling(tmp: pathlib.Path, mode: str) -> None:
    """模型**主动**调用 ``read_image_for_vision`` 后的附图。"""
    (tmp / "demo.png").write_bytes(PNG_VALID)
    image_abs = str(tmp / "demo.png")
    settings = SimpleSettings()
    counter: dict[str, int] = {}

    if mode == "toolD":
        middleware = [
            AppendImageAfterVisionToolCall(image_abs=image_abs, settings=settings)
        ]
    else:
        middleware = [
            AppendImageAfterVisionToolResultInWrapModelCall(
                image_abs=image_abs, settings=settings
            )
        ]

    model = ScriptedChat(
        rounds=[
            [tc_chunk(VISION_TOOL_NAME, {"relative_path": "demo.png"}, "real-vision-1")],
            [AIMessageChunk(content="看到了")],
        ]
    )
    agent = create_agent(
        model,
        [vision_tool(counter, image_abs), noop_tool(counter)],
        context_schema=AgentContext,
        middleware=middleware,
        name=f"s5b_{mode}",
    )
    raw = await drive(agent)
    report_case(f"sibling（模型主动调用视觉工具）/ {mode}", raw, model)
    print(f"real_tool_executions = {counter}")
    print(f"observations = {middleware[0].observed}")


async def main() -> None:
    print("=" * 78)
    print("阶段 5b 探针：多模态 HumanMessage 进入第二次模型调用的通道")
    print("=" * 78)

    with tempfile.TemporaryDirectory() as name:
        await scenario_fallback(pathlib.Path(name), "statusquo")

    for mode in ("channel1", "channel2", "channel3"):
        with tempfile.TemporaryDirectory() as name:
            try:
                await scenario_fallback(pathlib.Path(name), mode)
            except Exception as exc:  # noqa: BLE001 - 探针要把失败原样打出来
                print(f"\n===== 兜底路径 / {mode} =====")
                print(f"EXCEPTION {type(exc).__name__}: {exc}")

    with tempfile.TemporaryDirectory() as name:
        try:
            await scenario_fallback_with_business(pathlib.Path(name))
        except Exception as exc:  # noqa: BLE001
            print("\n===== 兜底路径 / channel1 + business =====")
            print(f"EXCEPTION {type(exc).__name__}: {exc}")

    for mode in ("toolD", "toolE"):
        with tempfile.TemporaryDirectory() as name:
            try:
                await scenario_sibling(pathlib.Path(name), mode)
            except Exception as exc:  # noqa: BLE001
                print(f"\n===== sibling / {mode} =====")
                print(f"EXCEPTION {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    asyncio.run(main())
