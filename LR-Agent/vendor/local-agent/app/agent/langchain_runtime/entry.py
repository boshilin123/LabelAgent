"""阶段 7：候选引擎的 **SSE 入口**（FastAPI 层可切换的那一条路径）。

本模块是「旧 HTTP 层前置段 + 候选内核」的粘合层，按迁移计划 §5-阶段 7 的要求：

1. **旧 ``/chat/stream`` 保持默认**：``app/api/v1/agent.py::local_chat_stream`` 在
   **engine 判定为 ``candidate`` 之后**才 import 本模块；``legacy``（默认）时
   ``_stream_local_chat`` 直连，本模块**连被 import 都不会发生**。
   ⚠️ 判定必须先于 import：本包 ``__init__`` 会导入 ``middleware``（需要 ``langchain``
   包），而原生产环境只有 ``langchain-core``。行为级回归见
   ``tests/test_engine_switch_import_safety.py``。
2. **复用旧前置段而不是重写**：模型构造、辅助模型、``has_tools`` 判定、阶段上下文、
   系统提示、工具清单、MCP 发现（含 ``preparing(stage="mcp")`` 与失败兜底）、
   ``sorted(key=name)`` 稳定化、取消事件注册表，全部逐条从
   ``app/api/v1/agent.py::_stream_local_chat``（:133-503）搬来；
   本模块因此**不新增任何业务判定**。
3. **装配期硬断言**（阶段 5 §5-1 / §6-1、阶段 5 §5-2 / §6-3）：

   - ``"custom"`` 必须在本次 ``stream_mode`` 里（工具侧无法自检：``Runtime.merge``
     会让工具拿到外层真 writer，写帧只会在外层被 ``stream_mode`` 过滤掉，
     表现为「零帧零异常」）；
   - 图里必须**至少有一个工具**（无工具时 ``factory.py:1731-1743`` 让 ``after_model``
     直连 ``END``，视觉兜底的合成 ``AIMessage`` 不会回跳模型）。

4. **本模块发 ``done``**：适配器永不发 ``done``（阶段 4 备忘 §3 硬约束 1），
   HTTP 层在 ``app/api/v1/agent.py:498`` 发；候选入口必须在自己的生成器里补上，
   否则前端收不到收尾帧。

**只加不改**：本文件不修改 ``stream_assist`` / ``register`` 的任何既有语义；
候选路径与旧路径的唯一差异就是「谁来跑模型—工具循环」。
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.agent.tools.tool_registry_meta import CANONICAL_CAPABILITIES
from app.schemas.agent import ClientContextInput, LocalChatStreamRequest, StreamEventPayload

logger = logging.getLogger(__name__)

__all__ = [
    "CANDIDATE_STREAM_MODES",
    "AgentRunPlan",
    "SSE_DONE_FRAME",
    "assemble_stream_modes",
    "build_agent_run_plan",
    "build_engine_agent",
    "sse_frame",
    "stream_candidate_engine_sse",
    "stream_engine_sse",
]


# ── 常量 ───────────────────────────────────────────────────────────────

SSE_DONE_FRAME = 'data: {"type": "done"}\n\n'
"""``done`` 帧的**逐字节**字面量（= ``app/api/v1/agent.py:498``）。

刻意不使用 ``json.dumps``：旧路径就是这一个字符串常量，字节相等性由本模块保证。
"""


CANDIDATE_STREAM_MODES: tuple[str, ...] = ("messages", "updates", "custom")
"""候选入口装配的 ``stream_mode``（**装配期不变量**，见 :func:`assemble_stream_modes`）。

``"custom"`` 不可省：阶段 5 的只读子代理事件经 ``runtime.stream_writer`` 带内转发，
缺该模式时 ``Runtime.merge`` 会让工具拿到外层真 writer、写帧被静默过滤
（阶段 5 §5-1）。
"""


def sse_frame(payload: StreamEventPayload) -> str:
    """把项目事件载荷编码为旧路径同格式的 SSE 帧（= ``agent.py:489-496``）。"""
    return "data: " + json.dumps(payload.to_sse_dict(), ensure_ascii=False) + "\n\n"


# ── 装配期决策（phase 1 / phase 2 分支的判据）──────────────────────────


class AgentRunPlan(BaseModel):
    """一次候选运行的装配决策（**只读**，供日志与本阶段测试观测）。

    字段即「装配期硬断言」的落点：

    - ``tool_names``：真正进图的工具名（已 ``sorted``），**非空**；
    - ``stream_modes``：本次 ``stream_mode``，**必须含 ``"custom"``**；
    - ``is_resume``：本请求是否携带 ``client_tool_results``（决定走
      ``prepare_resume_turn`` 还是首轮 ``AgentContext``）。
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    tool_names: tuple[str, ...] = Field(default_factory=tuple)
    stream_modes: tuple[str, ...] = Field(default_factory=tuple)
    is_resume: bool = False
    has_tools: bool = False
    client_job_id: str = ""


def assemble_stream_modes(
    overrides: Mapping[str, Any] | None = None,
    *,
    extra: Sequence[str] = ("custom",),
) -> tuple[str, ...]:
    """装配本次 ``stream_mode``，并**硬断言** ``"custom"`` 在清单里。

    ``overrides`` 允许测试/调用方替换基线模式（键 ``stream_modes``），
    但 **``"custom"`` 无论怎么替换都必须已经存在**——这是阶段 5 明确的接线期断言：
    工具侧拿不到模式清单（``Runtime.merge`` 会用外层真 writer 覆盖内层 no-op），
    所以唯一能自检的位置就是这里（缺失时静默丢帧，不报错）。
    """
    base: tuple[str, ...] = ()
    if overrides:
        raw = overrides.get("stream_modes")
        if raw is not None:
            base = tuple(str(mode) for mode in raw)
    if not base:
        base = CANDIDATE_STREAM_MODES

    # 硬断言（不是 warning）：缺 "custom" 会让子代理的 stream_writer 静默失效。
    assert "custom" in base, (  # noqa: S101 - 装配期不变量
        "候选入口装配错误：stream_mode 必须含 'custom'（阶段 5 §5-1："
        f"Runtime.merge 会让工具侧拿到外层真 writer，缺该模式时写帧被静默过滤）；"
        f"实际得到 {list(base)!r}"
    )

    modes: list[str] = list(base)
    for mode in extra:
        if mode not in modes:
            modes.append(mode)
    return tuple(modes)


def _tool_name(tool: Any) -> str:
    return str(getattr(tool, "name", "") or "")


def build_agent_run_plan(
    *,
    tools: Sequence[Any],
    stream_modes: Sequence[str],
    is_resume: bool,
    has_tools: bool,
    client_job_id: str = "",
) -> AgentRunPlan:
    """生成 :class:`AgentRunPlan`，并**硬断言图里至少有一个工具**。

    阶段 5 §5-2 实测：``tools`` 为空时 ``after_model`` 直连 ``END``
    （``langchain/agents/factory.py:1731-1743``），视觉兜底注入的合成 ``AIMessage``
    不会回跳模型——兜底静默失效。生产候选必然挂工具，此处把该前提显式化，
    避免将来工具集解析成空列表时静默退化。
    """
    names = tuple(sorted(_tool_name(tool) for tool in tools))
    assert names, (  # noqa: S101 - 装配期不变量
        "候选入口装配错误：进图的工具清单为空（阶段 5 §5-2：无工具时 after_model "
        "直连 END，视觉兜底的合成 AIMessage 不会回跳模型）。"
        f"has_tools={has_tools!r}"
    )
    assert "custom" in tuple(stream_modes), (  # noqa: S101 - 装配期不变量
        f"候选入口装配错误：stream_mode 少了 'custom'：{tuple(stream_modes)!r}"
    )
    return AgentRunPlan(
        tool_names=names,
        stream_modes=tuple(str(mode) for mode in stream_modes),
        is_resume=bool(is_resume),
        has_tools=bool(has_tools),
        client_job_id=client_job_id,
    )


# ── 旧前置段（逐条复刻 ``agent.py:147-436``）───────────────────────────


def _deepseek_extra_body(model: str, base_url: str) -> dict[str, Any] | None:
    """= ``agent.py:150-163`` / ``:191-204``（DeepSeek 关闭 Thinking 模式）。"""
    if "deepseek" in model.lower() or "deepseek" in base_url.lower():
        return {"thinking": {"type": "disabled"}}
    return None


def build_llm_pair(body: LocalChatStreamRequest) -> tuple[Any, Any]:
    """构造主模型与辅助模型（= ``agent.py:148-214``）。

    只做**模型实例构造**：不读环境变量、不发网络请求；``entry.ChatOpenAI``
    是模块级可替换的工厂名（默认由 :func:`_load_chat_openai` 惰性解析，
    测试与部署可注入脚本化模型 / 其它 ``BaseChatModel``）。
    """
    global ChatOpenAI  # noqa: PLW0603 - 惰性缓存，避免 baseline 环境 import langchain_openai
    if ChatOpenAI is None:
        ChatOpenAI = _load_chat_openai()
    factory = ChatOpenAI

    base_url = body.base_url.rstrip("/")
    llm = factory(
        model=body.model,
        api_key=body.api_key,
        base_url=base_url,
        streaming=True,
        temperature=0.7,
        timeout=120,
        extra_body=_deepseek_extra_body(body.model, base_url),
    )

    aux_llm: Any = None
    if body.aux_model.strip() and body.aux_api_key.strip() and body.aux_base_url.strip():
        aux_base_url = body.aux_base_url.strip().rstrip("/")
        aux_llm = factory(
            model=body.aux_model.strip(),
            api_key=body.aux_api_key.strip(),
            base_url=aux_base_url,
            streaming=True,
            temperature=0.7,
            timeout=120,
            extra_body=_deepseek_extra_body(body.aux_model, aux_base_url),
        )
    return llm, aux_llm


@lru_cache(maxsize=1)
def _load_chat_openai() -> Any:
    """惰性解析 ``ChatOpenAI``（**模块导入期不 import langchain_openai**）。

    必要性：baseline 环境（只有 ``langchain-core``）也要能 import 本模块，
    否则候选入口会把整个 FastAPI 应用拖进 ImportError。
    """
    from langchain_openai import ChatOpenAI

    return ChatOpenAI


ChatOpenAI: Any = None
"""模型工厂名（模块级可替换）：默认惰性解析为 ``langchain_openai.ChatOpenAI``。

保持为可替换的模块全局名，是为了让 FastAPI 集成测试注入脚本化模型而不发网络请求。
"""


def _has_tools(body: LocalChatStreamRequest) -> bool:
    """= ``agent.py:220-233``。"""
    client_ctx = body.client_context
    return bool(
        client_ctx
        and (
            (client_ctx.workspace_root or "").strip()
            or client_ctx.active_annotation_project_id
            or (client_ctx.annotation_project_snapshot is not None)
        )
    )


def _build_lc_messages(body: LocalChatStreamRequest, system_prompt: str) -> list:
    """= ``agent.py:75-130``（``_build_lc_messages_from_local``）。"""
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

    lc_messages: list = [SystemMessage(content=system_prompt)]

    if body.context_summary:
        lc_messages.append(SystemMessage(content=f"【此前对话摘要】\n{body.context_summary}"))

    for item in body.messages:
        if item.role == "user":
            lc_messages.append(HumanMessage(content=item.content or ""))
        elif item.role == "assistant":
            tool_calls = [
                {"id": tc.id, "name": tc.name, "args": tc.args}
                for tc in (item.tool_calls or [])
            ]
            lc_messages.append(
                AIMessage(content=item.content or "", tool_calls=tool_calls)
                if tool_calls
                else AIMessage(content=item.content or "")
            )
        elif item.role == "tool":
            if not (item.tool_call_id or "").strip():
                continue
            lc_messages.append(
                ToolMessage(content=item.content or "", tool_call_id=item.tool_call_id)
            )
        elif item.role == "system":
            lc_messages.append(SystemMessage(content=item.content or ""))

    return lc_messages


def build_system_prompt(body: LocalChatStreamRequest) -> str:
    """= ``agent.py:238-278``：系统提示 + 任务阶段块。"""
    from app.agent.assist.task_phase import phase_prompt_block
    from app.agent.context_service import CHAT_SYSTEM_PROMPT
    from app.agent.context_snapshot import (
        build_assist_system_prompt,
        format_runtime_identity_block,
    )

    client_ctx = body.client_context
    task_phase_ctx = _derive_task_phase(body)

    identity = format_runtime_identity_block(
        model=body.model,
        provider_label="local",
        supports_vision=body.supports_vision,
    )

    if client_ctx:
        system_prompt = build_assist_system_prompt(
            client_ctx,
            model=body.model,
            provider_label="local",
            supports_vision=body.supports_vision,
        )
    else:
        system_prompt = f"{identity}\n\n{CHAT_SYSTEM_PROMPT}"

    phase_block = phase_prompt_block(task_phase_ctx)
    if phase_block:
        system_prompt = f"{system_prompt}\n\n{phase_block}"
    return system_prompt


def _derive_task_phase(body: LocalChatStreamRequest) -> Any:
    """= ``agent.py:241-245``。"""
    from app.agent.assist.task_phase import derive_task_phase

    client_ctx = body.client_context
    return derive_task_phase(client_ctx.proposal_states if client_ctx else None)


def build_local_tools(body: LocalChatStreamRequest, settings: Any) -> list:
    """= ``agent.py:287-329``：模式解析 + 工具集构建（复用注册表，不改 schema）。"""
    from app.agent.assist_mode_router import resolve_assist_tool_set
    from app.agent.tools.registry import build_tools_by_name_set

    client_ctx = body.client_context
    has_workspace = bool(client_ctx and (client_ctx.workspace_root or "").strip())
    has_project_snapshot = bool(
        client_ctx and (client_ctx.annotation_project_snapshot is not None)
    )
    is_editor = bool(client_ctx and client_ctx.work_mode == "editor")

    tool_set = resolve_assist_tool_set(
        has_project_snapshot=has_project_snapshot,
        agent_mode=(client_ctx.agent_mode if client_ctx else None),
        is_editor=is_editor,
        has_workspace=has_workspace,
    )

    from app.api.v1.agent import _anonymous_user

    return build_tools_by_name_set(
        _anonymous_user(),
        client_ctx,
        tool_set,
        settings=settings,
        provider_is_vision=body.supports_vision,
    )


async def merge_mcp_tools(body: LocalChatStreamRequest, settings: Any, tools: list) -> list:
    """= ``agent.py:331-436``：MCP 发现 + 工具合并 + 稳定排序。

    返回**新的**列表（不原地改入参）；``preparing(stage="mcp")`` 帧由调用方
    在进入本函数之前先发（与旧路径的 yield 位置一致）。
    """
    from app.agent.tools.mcp_client import load_mcp_tools_from_servers, should_expose_mcp_tool

    client_ctx = body.client_context
    mcp_url = (client_ctx.mcp_server_url or "").strip() if client_ctx else ""
    remote_mcp = list(client_ctx.mcp_servers) if client_ctx else []
    local_mcp_token = (
        (client_ctx.mcp_server_token or "").strip() if client_ctx else ""
    )

    merged = list(tools)
    if mcp_url or remote_mcp:
        try:
            mcp_tools = await load_mcp_tools_from_servers(
                mcp_url or None,
                remote_mcp,
                local_server_token=(local_mcp_token or None),
                existing_capabilities=CANONICAL_CAPABILITIES,
                ttl_seconds=settings.agent_mcp_tools_ttl_seconds,
            )
            if mcp_tools:
                memory_on = bool(client_ctx and client_ctx.workspace_memory_enabled)
                existing = {_tool_name(tool) for tool in merged}
                merged = merged + [
                    tool
                    for tool in mcp_tools
                    if (_tool_name(tool) not in existing)
                    and should_expose_mcp_tool(
                        _tool_name(tool),
                        workspace_memory_enabled=memory_on,
                        agent_mode=(client_ctx.agent_mode if client_ctx else None),
                    )
                ]
        except Exception:
            logger.warning("Failed to load MCP tools", exc_info=True)

    # tools 列表保持稳定（按名称排序）：阶段门禁不在 bind 时增删工具
    return sorted(merged, key=_tool_name)


def _mcp_configured(body: LocalChatStreamRequest) -> bool:
    """= ``agent.py:355`` 的判据（配置了至少一个 MCP 源）。"""
    client_ctx = body.client_context
    if not client_ctx:
        return False
    return bool((client_ctx.mcp_server_url or "").strip() or list(client_ctx.mcp_servers))


# ── 候选 Agent 组装 ────────────────────────────────────────────────────


def _fn_map(tools: Sequence[Any]) -> dict[str, Any]:
    from app.agent.tools.registry import tool_fn_map

    return tool_fn_map(list(tools))


def _replace_explore_readonly(
    tools: Sequence[Any],
    fn_map: dict[str, Any],
    *,
    llm: Any,
    settings: Any,
    is_cancelled: Any,
    client_context: ClientContextInput | None,
) -> tuple[list[Any], dict[str, Any]]:
    """把 ``explore_readonly`` 换成候选侧的子代理工具（= ``assist_service.py:39-58``）。

    旧路径的输入逐条相同：``llm = aux_llm or llm``、``settings``、``is_cancelled``、
    ``parent_tools = tools``、``parent_fn_map = {name: fn | name != explore_readonly}``。
    """
    from app.agent.assist.explore_readonly import EXPLORE_READONLY_TOOL_NAME
    from app.agent.langchain_runtime.subagent import build_explore_readonly_agent_tool

    out_tools = list(tools)
    out_fn_map = dict(fn_map)
    if not any(_tool_name(tool) == EXPLORE_READONLY_TOOL_NAME for tool in out_tools):
        return out_tools, out_fn_map

    parent_fn_map = {
        name: fn for name, fn in out_fn_map.items() if name != EXPLORE_READONLY_TOOL_NAME
    }
    explore_tool = build_explore_readonly_agent_tool(
        llm=llm,
        settings=settings,
        is_cancelled=is_cancelled,
        parent_tools=out_tools,
        parent_fn_map=parent_fn_map,
        client_context=client_context,
    )
    out_fn_map[EXPLORE_READONLY_TOOL_NAME] = getattr(explore_tool, "coroutine", None) or getattr(
        explore_tool, "func", None
    )
    out_tools = [
        explore_tool if _tool_name(tool) == EXPLORE_READONLY_TOOL_NAME else tool
        for tool in out_tools
    ]
    return out_tools, out_fn_map


def build_engine_agent(
    *,
    llm: Any,
    aux_llm: Any,
    tools: Sequence[Any],
    settings: Any,
    is_cancelled: Any,
    body: LocalChatStreamRequest,
    system_prompt: str,
    task_phase_ctx: Any,
    is_resume: bool,
) -> tuple[Any, Any, dict[str, Any]]:
    """构建候选 Agent，返回 ``(agent, model_for_vision, resolved)``。

    ``resolved`` 是交给 :func:`stream_agent_events` 的素材（消息 + 上下文 + 配置），
    两条分支的差异只在「resume 用 :func:`prepare_resume_turn` 补消息 + 播种
    ``completed_tool_ids``」：

    - 首轮：``model = llm``，``messages = _build_lc_messages(...)``；
    - resume：``model = llm``（子代理仍用 ``aux_llm or llm``）、消息补齐走
      :func:`prepare_resume_turn`（复用阶段 3 的幂等 + 谎报防护）。

    middleware 顺序 = :func:`build_business_middleware`（阶段 2 实测顺序）+ 视觉件
    **追加在最后**（``extra=[VisionFallbackMiddleware, VisionToolResultMiddleware]``，
    见阶段 5 备忘的顺序要求：视觉件依赖业务件已算出的轮末状态）。
    """
    from app.agent.langchain_runtime.middleware import build_business_middleware
    from app.agent.langchain_runtime.resume import prepare_resume_turn
    from app.agent.langchain_runtime.runtime import (
        AgentContext,
        build_langchain_agent,
    )
    from app.agent.langchain_runtime.vision import (
        VisionFallbackMiddleware,
        VisionToolResultMiddleware,
    )
    from app.agent.tools.workspace_file_reader import VISION_TOOL_NAME

    client_ctx = body.client_context
    max_tool_rounds = int(settings.agent_max_tool_rounds)

    fn_map = _fn_map(tools)
    agent_tools, agent_fn_map = _replace_explore_readonly(
        tools,
        fn_map,
        llm=aux_llm or llm,
        settings=settings,
        is_cancelled=is_cancelled,
        client_context=client_ctx,
    )

    vision_fn = agent_fn_map.get(VISION_TOOL_NAME)

    middleware = build_business_middleware(
        max_tool_rounds=max_tool_rounds,
        phase_ctx=task_phase_ctx,
        extra=[
            VisionFallbackMiddleware(
                vision_fn=vision_fn,
                provider_is_vision=body.supports_vision,
                settings=settings,
                client_context=client_ctx,
                user_content=body.user_content,
                is_resume=is_resume,
            ),
            VisionToolResultMiddleware(
                provider_is_vision=body.supports_vision,
                settings=settings,
            ),
        ],
    )

    agent = build_langchain_agent(
        llm,
        agent_tools,
        system_prompt=system_prompt,
        middleware=middleware,
    )

    lc_messages = _build_lc_messages(body, system_prompt)
    base_context = AgentContext(
        mode="assist",
        client_context=client_ctx,
        task_phase_context=task_phase_ctx,
    )

    if is_resume:
        turn = prepare_resume_turn(
            lc_messages,
            body.client_tool_results or None,
            context=base_context,
            phase_ctx=task_phase_ctx,
            user_content=body.user_content,
            context_updates={"workspace_root": _workspace_root(client_ctx)},
        )
        messages = turn.messages
        context = turn.context
    else:
        messages = lc_messages
        context = base_context.model_copy(
            update={"workspace_root": _workspace_root(client_ctx)}
        )

    resolved = {
        "messages": messages,
        "context": context,
        "client_context": client_ctx,
        "task_phase_ctx": task_phase_ctx,
    }
    return agent, llm, resolved


def _workspace_root(client_ctx: ClientContextInput | None) -> str | None:
    if not client_ctx:
        return None
    root = (client_ctx.workspace_root or "").strip()
    return root or None


# ── 候选引擎的 SSE 生成器 ──────────────────────────────────────────────


async def _stream_candidate_frames(
    agent: Any,
    resolved: Mapping[str, Any],
    *,
    stream_modes: Sequence[str],
) -> AsyncIterator[StreamEventPayload]:
    """驱动适配器（单独一层，便于测试注入与生命周期管理）。"""
    from app.agent.langchain_runtime.sse_adapter import SseStreamConfig, stream_agent_events

    async for frame in stream_agent_events(
        agent,
        messages=resolved["messages"],
        config=SseStreamConfig(
            context=resolved["context"],
            client_context=resolved["client_context"],
            task_phase_context=resolved["task_phase_ctx"],
            stream_modes=tuple(str(mode) for mode in stream_modes),
        ),
        client_context=resolved["client_context"],
        task_phase_ctx=resolved["task_phase_ctx"],
    ):
        yield frame


async def stream_candidate_engine_sse(
    body: LocalChatStreamRequest,
    settings: Any,
    *,
    is_cancelled: Any = None,
    on_plan: Any = None,
    agent_builder: Any = None,
    frame_source: Any = None,
) -> AsyncIterator[str]:
    """候选引擎的 SSE 帧生成器（**唯一**候选入口，行为对齐旧 HTTP 层）。

    产出与 ``app/api/v1/agent.py::_stream_local_chat`` **同格式**的 SSE 字符串：

    - 先 ``preparing(stage="mcp")``（**仅**在配置了 MCP 时，且在发现之前）；
    - MCP loader 失败只记 warning，本轮继续（工具集退回本地工具）；
    - 适配器首帧 ``preparing(stage="streaming")``；
    - 每帧 **yield 前**查一次取消（旧 ``agent.py:486-487``），取消则断流；
    - 结尾恒发 ``done``（含取消路径；异常不补 ``done``，与旧路径的 ``try/finally`` 同构）。

    ``on_plan`` / ``agent_builder`` / ``frame_source`` 是给阶段 7 集成测试的
    **装配观测口**，默认 ``None`` = 生产实现；它们不改变任何业务判定。
    """
    from app.api.v1.agent import (
        _cleanup_cancel_event,
        _get_or_create_cancel_event,
    )

    client_job_id: str = body.client_job_id
    cancelled = is_cancelled
    if cancelled is None:
        cancel_event = _get_or_create_cancel_event(client_job_id)

        async def cancelled() -> bool:  # type: ignore[misc]
            return cancel_event.is_set()

    async def _is_cancelled() -> bool:
        return bool(await cancelled())

    try:
        stream_modes = assemble_stream_modes()

        if not _has_tools(body):
            # 无 client_context / 无工作区：与旧路径一致地走 chat_service.stream_chat
            # （无工具、无图、无阶段）。候选内核不适用于这条纯聊天路径。
            from app.agent import chat_service

            llm, _aux = build_llm_pair(body)
            system_prompt = body.system_prompt or _chat_system_prompt()
            stream = chat_service.stream_chat(llm, _build_lc_messages(body, system_prompt))
            try:
                async for event in stream:
                    if await _is_cancelled():
                        break
                    yield sse_frame(event)
            finally:
                await _aclose(stream)
            yield SSE_DONE_FRAME
            return

        system_prompt = build_system_prompt(body)

        if _mcp_configured(body):
            yield sse_frame(StreamEventPayload(type="preparing", stage="mcp"))

        llm, aux_llm = build_llm_pair(body)
        tools = await merge_mcp_tools(body, settings, build_local_tools(body, settings))
        is_resume = bool(body.client_tool_results)

        plan = build_agent_run_plan(
            tools=tools,
            stream_modes=stream_modes,
            is_resume=is_resume,
            has_tools=True,
            client_job_id=client_job_id,
        )
        if on_plan is not None:
            on_plan(plan)

        builder = agent_builder or build_engine_agent
        built = builder(
            llm=llm,
            aux_llm=aux_llm,
            tools=tools,
            settings=settings,
            is_cancelled=_is_cancelled,
            body=body,
            system_prompt=system_prompt,
            task_phase_ctx=_derive_task_phase(body),
            is_resume=is_resume,
        )
        agent, _model, resolved = built

        source = frame_source or _stream_candidate_frames
        frames = source(agent, resolved, stream_modes=stream_modes)
        try:
            async for frame in frames:
                if await _is_cancelled():
                    break
                yield sse_frame(frame)
        finally:
            # 取消 / 中途放弃时把框架流真正关掉（阶段 4 备忘 §7）：
            # ``break`` 后的 async generator 不会被自动 aclose，必须显式关闭。
            await _aclose(frames)

        yield SSE_DONE_FRAME
    finally:
        _cleanup_cancel_event(client_job_id)


def _chat_system_prompt() -> str:
    from app.agent.context_service import CHAT_SYSTEM_PROMPT

    return CHAT_SYSTEM_PROMPT


async def _aclose(agen: Any) -> None:
    """尽力关闭一个 async generator（不存在 ``aclose`` 时静默跳过）。

    只吞「尚未启动 / 已关闭」的 ``RuntimeError``（``aclose`` 对未启动的生成器
    抛 ``RuntimeError: aclose(): asynchronous generator is already running`` 的兄弟情形），
    其它异常照旧上抛——收尾阶段也不得把真实错误静默掉。
    """
    aclose = getattr(agen, "aclose", None)
    if aclose is None:
        return
    try:
        await aclose()
    except RuntimeError:
        logger.debug("candidate engine: abandoned stream already finished", exc_info=True)


async def stream_engine_sse(
    body: LocalChatStreamRequest,
    settings: Any,
) -> AsyncIterator[str]:
    """后端受控的引擎分发器（旧路由调用的唯一新代码）。

    ``settings.agent_engine`` 是本次运行的唯一开关：

    - ``"legacy"``（默认）：**原样**委派旧 ``_stream_local_chat``，一个字节都不变；
    - ``"candidate"``：委派 :func:`stream_candidate_engine_sse`。

    ``Settings`` 是 ``BaseSettings``，因此 ``AGENT_ENGINE=candidate`` 即可在
    服务端切换；FastAPI 测试客户端用 ``app.dependency_overrides[get_settings]``
    注入候选设置（无需环境变量、无需前端参与）。
    """
    engine = str(getattr(settings, "agent_engine", "legacy") or "legacy").strip().lower()

    if engine == "candidate":
        async for chunk in stream_candidate_engine_sse(body, settings, is_cancelled=None):
            yield chunk
        return

    from app.api.v1.agent import _stream_local_chat

    async for chunk in _stream_local_chat(body, settings):
        yield chunk
