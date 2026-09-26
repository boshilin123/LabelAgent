"""阶段 2：业务 middleware（``app.agent.langchain_runtime``）对照测试。

对照对象是阶段 0 冻结的 OLD 契约
（``tests/test_agent_baseline_contract.py``，18 passed）。本文件覆盖
``docs/阶段2-业务middleware设计备忘.md`` §7 实施清单第 1-7 项。

**强制约定**（规格 §7 风险 1/2；阶段 1 记录 §5-2/5-3）：

- **不断言 ``bind_tools_calls``**：``create_agent`` 每次模型调用都会 ``bind_tools``
  （``langchain/agents/factory.py:1432``），旧路径只在开头 bind 一次。
  改用 **``bound_tool_names`` 稳定性**（这才是「工具列表不动」的承重面）。
- **不逐对象比较 ``ToolMessage.status``**：官方 ``ToolErrorMiddleware`` 置
  ``"error"``，旧路径默认 ``"success"``（``tool_loop.py:287``）。
  本文件只比较 **内容 JSON** 与 **``tool_call_id`` 对齐**。

**事件序列口径**：候选侧的事件来自官方 ``updates`` 流（``tools`` 节点更新）
与 ``messages`` 流，不是旧路径的 ``StreamEventPayload`` 序列。
因此对照的是**语义等价物**：

- ``executions[name]``（真实函数调用列表，长度 = 执行次数）—— 与基线同口径；
- ``tool_start``/``tool_result`` ⇒ ``tools`` 节点更新里的 ``ToolMessage``
  与 ``bound_tool_names``；
- ``tool_pending`` ⇒ 客户端工具的**后端零执行** + 待执行调用暴露。

严格的 SSE 帧逐字段对照属阶段 4（适配器）；本文件钉住的是阶段 2 的门槛：
**同轮计划顺序、真实执行次数、被抑制调用的 ``tool_result`` 载荷、
``tool_bound_names`` 稳定、不出现 ``error``**。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import pytest

# baseline 环境（只有 langchain-core，无 langchain/langgraph）应整体 skip 而不是 collect error
pytest.importorskip("langchain")

from langchain.agents import create_agent  # noqa: E402
from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import (  # noqa: E402
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    ToolMessage,
)
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
)
from langchain_core.tools import StructuredTool  # noqa: E402
from pydantic import Field, create_model  # noqa: E402

from app.agent.assist.task_phase import derive_task_phase  # noqa: E402
from app.agent.langchain_runtime import (  # noqa: E402
    AgentContext,
    build_business_middleware,
)
from app.agent.langchain_runtime.round_plan import (  # noqa: E402
    ALREADY_COMPLETED_SUMMARY,
    DUPLICATE_SUMMARY,
    WORKSPACE_WRITE_BLOCKED_SUMMARY,
    plan_round,
)
from app.schemas.agent import ProposalStateInput  # noqa: E402

pytestmark = pytest.mark.filterwarnings(
    "ignore:Pydantic serializer warnings:UserWarning"
)


# ── 脚本化假模型（与阶段 1 同构：``_generate`` + 块级 ``_astream``）──────


class ScriptedChat(BaseChatModel):
    """按轮次返回预设 chunk 的假聊天模型（离线、确定性）。

    ``counters`` 跨 ``bind_tools`` 的 pydantic 浅拷贝共享——只有这样才观测得到
    真实调用轮数与绑定清单（``create_agent`` 在模型节点执行时才 ``bind_tools``）。
    """

    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)
    seen_messages: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "lr-agent-scripted-chat-stage2"

    @property
    def bound_tool_names(self) -> list[str]:
        return list(self.counters.get("bound_tool_names", []))

    @property
    def invoke_calls(self) -> int:
        return int(self.counters.get("invoke_calls", 0))

    @property
    def bind_tools_calls(self) -> int:
        return int(self.counters.get("bind_tools_calls", 0))

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [getattr(t, "name", str(t)) for t in tools]
        self.counters["bind_tools_calls"] = self.bind_tools_calls + 1
        return self

    def _round(self) -> list[AIMessageChunk]:
        index = int(self.counters.get("invoke_calls", 0))
        self.counters["invoke_calls"] = index + 1
        if index < len(self.rounds):
            return self.rounds[index]
        # 脚本轮次用尽 → 产出一条空文本轮（真实模型在无话可说时就是这个形状），
        # 而不是抛 ``ValueError: No generations found in stream``。
        # 借助它还能把「图意外多跑了一轮」变成可断言的观测值（``invoke_calls``）。
        return [AIMessageChunk(content="")]

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        chunks = self._round()
        merged: AIMessageChunk | None = None
        for chunk in chunks:
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

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self.seen_messages.append(list(messages))
        return self._generate(messages)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen_messages.append(list(messages))
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


def tool_call_chunk(name: str, args: dict[str, Any], call_id: str) -> AIMessageChunk:
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


# ── 工具桩：真实记录**每次**调用的参数（执行次数 = 列表长度）──────────


class Recorder:
    """记录工具真实执行（与基线 ``make_tools`` 的 ``executions[name]`` 同口径）。"""

    def __init__(self) -> None:
        self.calls: dict[str, list[dict[str, Any]]] = {}

    def record(self, name: str, args: dict[str, Any]) -> None:
        self.calls.setdefault(name, []).append(args)

    def count(self, name: str) -> int:
        return len(self.calls.get(name, []))

    def args(self, name: str) -> list[dict[str, Any]]:
        return list(self.calls.get(name, []))


_JSON_TYPE_TO_PY: dict[str, Any] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
}


def make_tools(specs: dict[str, dict[str, Any]]) -> tuple[list[StructuredTool], Recorder]:
    """按 ``{name: {"properties": {...}, "result": {...}, "raises": Exception|None}}`` 造工具。

    实现要点（三次踩坑后的结论）：

    - ``StructuredTool(args_schema=<裸 JSON schema dict>)`` 会得到**空**参数模型，
      模型给的参数被丢掉 → 参数断言失去意义；
    - 用 ``**kwargs`` 签名让 ``from_function`` 推断，会把 ``kwargs`` 本身
      变成模型可见的 schema 属性（实测 ``properties == {'relative_path', 'kwargs'}``），
      假模型于是按 ``{}`` 调用 → 计划里没有 paths、执行次数归零；
    - 因此这里用 ``pydantic.create_model`` 构造**精确**的 ``args_schema``，
      函数体则用 ``**kwargs`` 原样接收。
    """
    rec = Recorder()
    tools: list[StructuredTool] = []

    for name, spec in specs.items():
        props: dict[str, dict[str, Any]] = spec.get("properties") or {}
        raises: Exception | None = spec.get("raises")
        result: dict[str, Any] = spec.get(
            "result", {"ok": True, "tool": name, "status": "ok", "summary": f"{name} ok"}
        )
        schema = create_model(
            f"{name}_args",
            **{
                prop: (_JSON_TYPE_TO_PY.get(cfg.get("type", "string"), Any), ...)
                for prop, cfg in props.items()
            },
        )

        def _build(tool_name=name, tool_raises=raises, tool_result=result):
            def _impl(**kwargs: Any) -> str:
                rec.record(tool_name, dict(kwargs))
                if tool_raises is not None:
                    raise tool_raises
                return json.dumps(tool_result, ensure_ascii=False)

            _impl.__name__ = f"impl_{tool_name}"
            return _impl

        tools.append(
            StructuredTool.from_function(
                func=_build(),
                name=name,
                description=f"{name} stub",
                args_schema=schema,
            )
        )
    return tools, rec


# ── 驱动与事件读取 ──────────────────────────────────────────────────────


class Drive:
    """一次候选驱动的观测结果。"""

    def __init__(self, events: list, model: ScriptedChat) -> None:
        self.events = events
        self.model = model

    @property
    def node_sequence(self) -> list[str]:
        """节点更新里出现过的节点名（按出现顺序，保留重复）。"""
        seq: list[str] = []
        for event in self.events:
            if isinstance(event, dict) and event.get("type") == "updates":
                seq.extend(event["data"])
        return seq

    @property
    def tool_messages(self) -> list[ToolMessage]:
        """``updates`` 流里产出的 ``ToolMessage``（按产出顺序）。"""
        found: list[ToolMessage] = []
        for event in self.events:
            if not (isinstance(event, dict) and event.get("type") == "updates"):
                continue
            for update in event["data"].values():
                if not isinstance(update, dict):
                    continue
                for message in update.get("messages", []) or []:
                    if isinstance(message, ToolMessage):
                        found.append(message)
        return found

    @property
    def tool_result_by_id(self) -> dict[str, str]:
        """``tool_call_id`` → 结果内容。

        **合并**而不是覆盖：同一条 ``ToolMessage`` 可能同时出现在不同节点的
        ``updates`` 里（例如 ``after_model`` 注入的合成结果与 ``tools`` 节点的真实结果）。
        后者按字典顺序覆盖前者会丢掉先出现的那条（曾经的测试 bug 来源）。
        """
        merged: dict[str, str] = {}
        for message in self.tool_messages:
            merged.setdefault(message.tool_call_id, message.content)
        return merged

    @property
    def executed_tool_ids(self) -> list[str]:
        """真正进过 ``tools`` 节点执行的 ``tool_call_id``。"""
        ids: list[str] = []
        for event in self.events:
            if not (isinstance(event, dict) and event.get("type") == "updates"):
                continue
            if "tools" not in event["data"]:
                continue
            update = event["data"]["tools"]
            if isinstance(update, dict):
                for message in update.get("messages", []) or []:
                    if isinstance(message, ToolMessage):
                        ids.append(message.tool_call_id)
        return ids

    @property
    def saw_tools_node(self) -> bool:
        return any(
            isinstance(event, dict)
            and event.get("type") == "updates"
            and "tools" in event["data"]
            for event in self.events
        )

    @property
    def final_text(self) -> str:
        text = ""
        for event in self.events:
            if not (isinstance(event, dict) and event.get("type") == "updates"):
                continue
            for update in event["data"].values():
                if not isinstance(update, dict):
                    continue
                for message in update.get("messages", []) or []:
                    if getattr(message, "type", None) == "ai":
                        content = getattr(message, "content", "")
                        if isinstance(content, str) and content:
                            text = content
        return text


async def drive(
    model: ScriptedChat,
    tools: list[StructuredTool],
    *,
    context: AgentContext | None = None,
    max_tool_rounds: int = 5,
) -> Drive:
    """用阶段 2 的 middleware 组装候选 Agent 并跑完，返回观测结果。"""
    middleware = build_business_middleware(max_tool_rounds=max_tool_rounds)
    agent = create_agent(
        model, tools, context_schema=AgentContext, middleware=middleware
    )
    events = [
        event
        async for event in agent.astream(
            {"messages": [HumanMessage(content="执行任务")]},
            context=context if context is not None else AgentContext(mode="assist"),
            stream_mode=["messages", "updates"],
            version="v2",
        )
    ]
    return Drive(events, model)


def _sse_types_for(drive_result: Drive) -> list[str]:
    """把候选事件折成与旧路径可比的「语义事件类型」序列。

    - ``tools`` 节点更新里每个真的执行完的 ``ToolMessage`` → ``tool_result``；
    - 其余节点更新不计（``model`` / ``*before_model`` / ``*after_model``）；
    - 模型最终文本 → ``text_delta``。

    这个映射只用于**顺序**断言，不做逐字段 SSE 对照（那是阶段 4 的职责）。
    """
    seq: list[str] = []
    for event in drive_result.events:
        if not (isinstance(event, dict) and event.get("type") == "updates"):
            continue
        for node, update in event["data"].items():
            if node == "tools" and isinstance(update, dict):
                for message in update.get("messages", []) or []:
                    if isinstance(message, ToolMessage):
                        seq.append("tool_result")
    if drive_result.final_text:
        seq.append("text_delta")
    return seq


# ── 1. 纯函数「本轮计划」层 ─────────────────────────────────────────────


class TestRoundPlanPureFunctions:
    """清单第 1 项：纯函数「本轮计划」层（复用 ``task_phase`` + ``tool_dispatcher``）。

    证明用例：``TestMultipleTools::test_two_parallel_read_tools_keep_order_and_ids``
    （旧路径两并行只读保序、各 1 次）。
    """

    def test_two_parallel_reads_keep_model_order(self):
        message = AIMessage(
            content="",
            tool_calls=[
                {"name": "grep_workspace", "args": {"pattern": "TODO"}, "id": "g1", "type": "tool_call"},
                {"name": "glob_workspace", "args": {"pattern": "*.py"}, "id": "g2", "type": "tool_call"},
            ],
        )
        plan = plan_round(message)
        assert [c.tool_call_id for c in plan.execute_now] == ["g1", "g2"]
        assert plan.deferred == ()
        assert plan.suppressed == ()
        assert plan.all_calls_resolved_here

    async def test_two_parallel_reads_execute_in_order_exactly_once(self):
        tools, rec = make_tools(
            {
                "grep_workspace": {
                    "properties": {"pattern": {"type": "string"}},
                    "result": {"ok": True, "summary": "grep 命中 2 处"},
                },
                "glob_workspace": {
                    "properties": {"pattern": {"type": "string"}},
                    "result": {"ok": True, "summary": "glob 命中 3 个文件"},
                },
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk("grep_workspace", {"pattern": "TODO"}, "g1"),
                    tool_call_chunk("glob_workspace", {"pattern": "*.py"}, "g2"),
                ],
                [AIMessageChunk(content="共 2 处命中、3 个文件。")],
            ]
        )
        result = await drive(model, tools)

        # 与基线同口径：每个工具**恰好执行一次**，参数逐字来自模型调用
        assert rec.args("grep_workspace") == [{"pattern": "TODO"}]
        assert rec.args("glob_workspace") == [{"pattern": "*.py"}]
        # 执行顺序 = 模型给出的顺序（基线 :396-398）
        order = [
            name
            for name, calls in rec.calls.items()
            for _ in calls
        ]
        assert order == ["grep_workspace", "glob_workspace"]
        assert model.invoke_calls == 2

    def test_scopes_come_from_task_phase(self):
        """门禁路径提取复用 ``task_phase.extract_call_paths``（含 scope_hint）。"""
        message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "auto_annotate",
                    "args": {"scope_hint": "a.jpg, b.jpg"},
                    "id": "s1",
                    "type": "tool_call",
                },
                {
                    "name": "auto_annotate",
                    "args": {"paths": ["b.jpg", "a.jpg"]},
                    "id": "s2",
                    "type": "tool_call",
                },
            ],
        )
        plan = plan_round(message)
        # 同范围（同一 frozenset）→ 第二个被去重（若未先被合并）
        assert plan.suppression_reasons in (("coalesced",), ("duplicate_call",))
        assert plan.all_calls_resolved_here


# ── 2. 同轮多个 auto_annotate 合并 ──────────────────────────────────────


class TestCoalescedAutoAnnotate:
    """清单第 2 项：``coalesced`` 注入。

    证明用例：``experiments/compare_stage2_old_suppression.py`` A 场景实测
    （旧路径 event types = ``preparing, tool_start, tool_result, tool_start,
    tool_pending``；被并者 ``c2`` 的 ``tool_result`` payload 见下）。
    """

    def test_merge_rule_matches_old_path_byte_for_byte(self):
        message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "auto_annotate",
                    "args": {"paths": ["a.jpg"], "all_files": False, "write_mode": "append"},
                    "id": "c1",
                    "type": "tool_call",
                },
                {
                    "name": "auto_annotate",
                    "args": {"paths": ["b.jpg"], "all_files": True, "write_mode": "replace_matching"},
                    "id": "c2",
                    "type": "tool_call",
                },
            ],
        )
        plan = plan_round(message)
        # 合并后的首个调用携带合并参数（paths 首见序并集 / all_files OR /
        # write_mode 任一 replace_matching），且**键顺序保持首个调用的顺序**
        assert len(plan.deferred) == 1
        assert plan.deferred[0].tool_call_id == "c1"
        assert plan.deferred[0].arguments == {
            "paths": ["a.jpg", "b.jpg"],
            "all_files": True,
            "write_mode": "replace_matching",
        }
        assert plan.merged_arguments == {
            "c1": {"paths": ["a.jpg", "b.jpg"], "all_files": True, "write_mode": "replace_matching"}
        }
        # 被并者 c2 的 tool_result 载荷逐字等于旧路径
        assert len(plan.suppressed) == 1
        sse = json.loads(plan.suppressed[0].result_json)
        assert sse == {
            "ok": False,
            "tool": "auto_annotate",
            "status": "coalesced",
            "summary": (
                "本次调用已并入第一个 auto_annotate（paths 合并为 ['a.jpg', 'b.jpg']），"
                "请勿重复发起。"
            ),
            "file_written": False,
            "proposal_pending": False,
        }

    async def test_coalesced_second_call_never_runs_backend(self):
        tools, rec = make_tools(
            {
                "auto_annotate": {
                    "properties": {
                        "paths": {"type": "array"},
                        "all_files": {"type": "boolean"},
                        "write_mode": {"type": "string"},
                    },
                    "result": {"ok": True, "summary": "不应在后端执行"},
                }
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk(
                        "auto_annotate",
                        {"paths": ["a.jpg"], "all_files": False, "write_mode": "append"},
                        "c1",
                    ),
                    tool_call_chunk(
                        "auto_annotate",
                        {"paths": ["b.jpg"], "all_files": True, "write_mode": "replace_matching"},
                        "c2",
                    ),
                ]
            ]
        )
        result = await drive(model, tools)

        # ASYNC 工具后端零执行（两个调用都没跑）
        assert rec.calls.get("auto_annotate", []) == []
        # 被并者的 tool_result 载荷与旧路径一致
        payload = json.loads(result.tool_result_by_id["c2"])
        assert payload["status"] == "coalesced"
        assert payload["ok"] is False
        # 合并后的首个调用**没有**被后端执行，而是挂起（旧路径 tool_pending 语义）
        assert not result.saw_tools_node
        # 工具清单稳定（不被隐藏/增删）
        assert model.bound_tool_names == ["auto_annotate"]


# ── 3. 同范围去重 ───────────────────────────────────────────────────────


class TestDuplicateCallDedup:
    """清单第 2 项：``duplicate_call`` 注入（``tool_loop.py:595-617``）。"""

    def test_dedup_uses_name_plus_extracted_paths(self):
        message = AIMessage(
            content="",
            tool_calls=[
                {"name": "auto_annotate", "args": {"paths": ["a.jpg"]}, "id": "d1", "type": "tool_call"},
                {
                    "name": "auto_annotate",
                    "args": {"paths": '["a.jpg"]'},  # 同范围（JSON 字符串形式）
                    "id": "d2",
                    "type": "tool_call",
                },
            ],
        )
        plan = plan_round(message)
        assert len(plan.deferred) == 1
        assert plan.deferred[0].tool_call_id == "d1"
        reasons = plan.suppression_reasons
        assert "duplicate_call" in reasons or "coalesced" in reasons
        suppressed = plan.suppressed[0]
        payload = json.loads(suppressed.result_json)
        assert payload["status"] in ("duplicate_call", "coalesced")
        if payload["status"] == "duplicate_call":
            assert payload["summary"] == DUPLICATE_SUMMARY

    async def test_duplicate_scope_never_runs_backend(self):
        tools, rec = make_tools(
            {"auto_annotate": {"properties": {"paths": {"type": "array"}}}}
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk("auto_annotate", {"paths": ["a.jpg"]}, "d1"),
                    tool_call_chunk("auto_annotate", {"paths": ["a.jpg"]}, "d2"),
                ]
            ]
        )
        result = await drive(model, tools)

        # ASYNC 工具后端零执行
        assert rec.calls.get("auto_annotate", []) == []
        # 被去掉的那个调用拿到了结果（这是「框架保证每个 tool_call_id 必有结果」
        # 里**真正**成立的那一半：只有被调度的调用才需要结果）
        payload = json.loads(result.tool_result_by_id["d2"])
        assert payload["ok"] is False
        assert payload["status"] in ("duplicate_call", "coalesced")
        # 旧路径同口径（``experiments/compare_stage2_old_suppression.py`` A/B 场景）：
        # 存活的那个调用**没有** ToolMessage——它以 ``tool_pending`` 结束本轮 HTTP，
        # 结果要等客户端 resume 才回填（阶段 3）。候选侧同样不造这条消息。
        assert "d1" not in result.tool_result_by_id
        assert not result.saw_tools_node


# ── 4. 阶段门禁（执行层唯一入口）────────────────────────────────────────


class TestPhaseGate:
    """清单第 3/4 项：``check_call_allowed`` 执行层门禁 + 兜底。

    证明用例：
    - ``TestReadOnlyTools::test_read_only_rounds_emit_no_proposal_and_never_run_write_tools``
      （写工具零执行、且仍留在 bind 列表）
    - ``TestDismissAndReject::test_all_dismissed_clears_gate_and_allows_replanning``
      （门禁解除后可重新规划）
    - ``experiments/compare_stage2_old_suppression.py`` C/D 场景（理由逐字对照）
    """

    async def test_await_confirm_blocks_workspace_write_but_allows_read(self):
        """``await_confirm``：写工具被门禁拒绝（理由逐字同旧路径），只读照常执行。"""
        states = [
            ProposalStateInput(path="data/1.jpg", kind="annotation", status="pending")
        ]
        ctx = AgentContext(
            mode="assist",
            workspace_root="/w",
            task_phase_context=derive_task_phase(states),
        )
        tools, rec = make_tools(
            {
                "write_workspace_file": {
                    "properties": {
                        "relative_path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "result": {"ok": True, "summary": "不应被调用"},
                },
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}},
                    "result": {"ok": True, "summary": "已读取 a.md"},
                },
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk(
                        "write_workspace_file",
                        {"relative_path": "r.md", "content": "x"},
                        "w1",
                    ),
                    tool_call_chunk(
                        "read_workspace_file", {"relative_path": "a.md"}, "r1"
                    ),
                ],
                [AIMessageChunk(content="提案待确认。")],
            ]
        )
        result = await drive(model, tools, context=ctx)

        # 写工具零执行；只读恰好 1 次（基线 TestReadOnlyTools 同口径）
        assert rec.args("write_workspace_file") == []
        assert rec.args("read_workspace_file") == [{"relative_path": "a.md"}]

        # 被拒调用的 tool_result 载荷：status=phase_blocked + 旧路径逐字理由
        blocked = json.loads(result.tool_result_by_id["w1"])
        assert blocked["ok"] is False
        assert blocked["status"] == "phase_blocked"
        assert blocked["summary"] == (
            "当前存在未确认的标注提案（data/1.jpg），用户尚未 Keep All，提案未写盘。"
            "禁止标注写入与文件写入操作。请用一两句说明提案内容，"
            "提示用户 Keep All 或关闭提案后再继续。"
        )
        assert blocked["file_written"] is False
        assert blocked["proposal_pending"] is False

        # 写工具仍在绑定列表里（基线 :1176：门禁不在 bind 时增删工具，保前缀缓存）
        assert "write_workspace_file" in model.bound_tool_names
        assert model.bound_tool_names == ["write_workspace_file", "read_workspace_file"]
        # 循环继续：模型读到门禁反馈后再答一次（基线 C 场景 astream_calls == 2）
        assert model.invoke_calls == 2
        assert result.final_text == "提案待确认。"

    async def test_annotation_write_and_workspace_write_mutually_exclusive_in_round(self):
        """同轮互斥：有标注写入时，工作区写入一律 ``phase_blocked``（理由逐字同旧路径）。"""
        states = [
            ProposalStateInput(
                path="data/1.jpg", kind="annotation", status="applied", annotation_ids=["x"]
            )
        ]
        ctx = AgentContext(
            mode="assist",
            workspace_root="/w",
            task_phase_context=derive_task_phase(states),
        )
        tools, rec = make_tools(
            {
                "write_workspace_file": {
                    "properties": {
                        "relative_path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "result": {"ok": True, "summary": "不应被调用"},
                },
                "auto_annotate": {
                    "properties": {"paths": {"type": "array"}},
                    "result": {"ok": True, "summary": "不应在后端执行"},
                },
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk(
                        "write_workspace_file",
                        {"relative_path": "r.md", "content": "x"},
                        "w1",
                    ),
                    tool_call_chunk("auto_annotate", {"paths": ["new.jpg"]}, "a1"),
                ]
            ]
        )
        result = await drive(model, tools, context=ctx)

        assert rec.args("write_workspace_file") == []
        assert rec.calls.get("auto_annotate", []) == []
        blocked = json.loads(result.tool_result_by_id["w1"])
        assert blocked["status"] == "phase_blocked"
        assert blocked["summary"] == WORKSPACE_WRITE_BLOCKED_SUMMARY

    def test_all_dismissed_clears_gate_and_allows_replanning(self):
        """基线 ``TestDismissAndReject``（:627-681）：全 dismissed → 门禁关闭，不再 phase_blocked。"""
        states = [
            ProposalStateInput(path="data/2.jpg", kind="annotation", status="dismissed")
        ]
        assert derive_task_phase(states) is None
        message = AIMessage(
            content="",
            tool_calls=[
                {"name": "auto_annotate", "args": {"paths": ["data/2.jpg"]}, "id": "d1", "type": "tool_call"}
            ],
        )
        plan = plan_round(message, phase_ctx=derive_task_phase(states))
        assert plan.suppression_reasons == ()
        assert [c.tool_call_id for c in plan.deferred] == ["d1"]

    def test_verify_phase_blocks_all_files_reannotation(self):
        """``verify`` 阶段 ``all_files=true`` 全量重标被拒（``task_phase.py:201-205``）。"""
        states = [
            ProposalStateInput(
                path="data/3.jpg", kind="annotation", status="applied", annotation_ids=["y"]
            )
        ]
        message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "auto_annotate",
                    "args": {"all_files": True},
                    "id": "v1",
                    "type": "tool_call",
                }
            ],
        )
        plan = plan_round(message, phase_ctx=derive_task_phase(states))
        assert plan.suppression_reasons == ("phase_blocked",)
        payload = json.loads(plan.suppressed[0].result_json)
        assert payload["status"] == "phase_blocked"
        assert "禁止 all_files=true 的全量重标" in payload["summary"]

    async def test_verify_phase_allows_targeted_reannotation(self):
        """``verify`` 阶段定向修正放行（``task_phase.py:231-232``）。"""
        states = [
            ProposalStateInput(
                path="data/3.jpg", kind="annotation", status="applied", annotation_ids=["y"]
            )
        ]
        message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "mutate_annotation",
                    "args": {"paths": ["data/other.jpg"]},
                    "id": "m1",
                    "type": "tool_call",
                }
            ],
        )
        plan = plan_round(message, phase_ctx=derive_task_phase(states))
        assert plan.suppression_reasons == ()
        assert [c.tool_call_id for c in plan.deferred] == ["m1"]


# ── 5. 混合同轮 SYNC + ASYNC（清单第 9 项）──────────────────────────────


class TestMixedSyncAsyncRound:
    """清单第 9 项：同轮「后端工具 + 客户端 ASYNC 工具」。

    证明用例：``TestMultipleTools::test_sync_and_async_tool_same_round_executes_sync_then_pends``
    （旧路径 ``executions["read_workspace_file"] == [{"relative_path": "a.md"}]``、
    ``executions["auto_annotate"] == []``、``astream_calls == 1``）。
    """

    async def test_sync_executes_once_and_async_never_runs_on_backend(self):
        tools, rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}},
                    "result": {"ok": True, "summary": "已读取 a.md"},
                },
                "auto_annotate": {
                    "properties": {
                        "paths": {"type": "array"},
                        "all_files": {"type": "boolean"},
                    },
                    "result": {"ok": True, "summary": "不应在后端执行"},
                },
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk(
                        "read_workspace_file", {"relative_path": "a.md"}, "r1"
                    ),
                    tool_call_chunk(
                        "auto_annotate",
                        {"paths": ["data/1.jpg"], "all_files": False},
                        "a1",
                    ),
                ]
            ]
        )
        result = await drive(model, tools)

        # 阶段 2 门槛：SYNC 恰好 1 次 + ASYNC 后端零执行
        assert rec.args("read_workspace_file") == [{"relative_path": "a.md"}]
        assert rec.count("read_workspace_file") == 1
        assert rec.calls.get("auto_annotate", []) == []

        # 工具清单稳定（阶段 0 §3-9 / 阶段 1 §5-2：不用 bind_tools_calls）
        assert model.bound_tool_names == ["read_workspace_file", "auto_annotate"]

        # 被挂起的 ASYNC 调用拿到一条结果（框架保证每个 tool_call_id 有结果），
        # 且**不是**工具的执行输出
        assert json.loads(result.tool_result_by_id["a1"])["ok"] is False
        assert json.loads(result.tool_result_by_id["a1"])["tool"] == "auto_annotate"

    async def test_async_first_then_sync_still_only_sync_executes(self):
        """顺序无关：ASYNC 在模型调用里排前面时，SYNC 仍恰好 1 次、ASYNC 仍零执行。"""
        tools, rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}},
                    "result": {"ok": True, "summary": "已读取 a.md"},
                },
                "auto_annotate": {
                    "properties": {"paths": {"type": "array"}},
                    "result": {"ok": True, "summary": "不应在后端执行"},
                },
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk("auto_annotate", {"paths": ["data/1.jpg"]}, "a1"),
                    tool_call_chunk(
                        "read_workspace_file", {"relative_path": "a.md"}, "r1"
                    ),
                ]
            ]
        )
        await drive(model, tools)
        assert rec.args("read_workspace_file") == [{"relative_path": "a.md"}]
        assert rec.calls.get("auto_annotate", []) == []

    def test_plan_puts_async_in_deferred_and_sync_in_execute_now(self):
        message = AIMessage(
            content="",
            tool_calls=[
                {"name": "read_workspace_file", "args": {"relative_path": "a.md"}, "id": "r1", "type": "tool_call"},
                {"name": "auto_annotate", "args": {"paths": ["d.jpg"]}, "id": "a1", "type": "tool_call"},
            ],
        )
        plan = plan_round(message)
        assert [c.tool_call_id for c in plan.execute_now] == ["r1"]
        assert [c.tool_call_id for c in plan.deferred] == ["a1"]
        assert plan.suppressed == ()
        assert plan.all_calls_resolved_here


# ── 6. 工具错误（不重试）与未知工具 ─────────────────────────────────────


class TestToolError:
    """清单第 5/6 项：``ToolErrorMiddleware`` 文本映射 + 收窄 ``ToolRetry``。

    证明用例：``TestToolError::test_raising_tool_becomes_error_tool_result_without_retry``
    （旧路径 ``tool_result.result == "工具执行失败: 磁盘炸了"``、**恰好 1 次**、
    事件表不含 ``error``）与 ``::test_unknown_tool_reports_error_json``。
    """

    async def test_raising_tool_runs_exactly_once_and_reports_old_text(self):
        tools, rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}},
                    "raises": RuntimeError("磁盘炸了"),
                }
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk(
                        "read_workspace_file", {"relative_path": "a.md"}, "e1"
                    )
                ],
                [AIMessageChunk(content="读取失败，已停止。")],
            ]
        )
        result = await drive(model, tools)

        # 恰好一次（收窄后的 ToolRetryMiddleware 不得重试 RuntimeError）
        assert rec.args("read_workspace_file") == [{"relative_path": "a.md"}]
        assert rec.count("read_workspace_file") == 1

        # 文本逐字复刻 ``tool_loop.py:100-104``
        payload = json.loads(result.tool_result_by_id["e1"])
        # 载荷必须**逐字等于**旧路径的手写四键（``tool_loop.py:101-104``）：
        # 阶段 8 的 D1 修复前这里多 ``file_written`` / ``proposal_pending`` 两键。
        assert payload == {
            "ok": False,
            "tool": "read_workspace_file",
            "status": "error",
            "summary": "工具执行失败: 磁盘炸了",
        }

        # 循环继续一轮（基线 astream_calls == 2）
        assert model.invoke_calls == 2
        assert result.final_text == "读取失败，已停止。"

    async def test_unknown_tool_is_reported_without_raising(self):
        """未注册工具（MCP 未就绪等）→ 框架 ``ToolNode`` 产出错误 ToolMessage，不抛异常。"""
        tools, rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}},
                    "result": {"ok": True, "summary": "ok"},
                }
            }
        )
        model = ScriptedChat(
            rounds=[
                [tool_call_chunk("memory_read", {"topic": "x"}, "u1")],
                [AIMessageChunk(content="该工具当前不可用。")],
            ]
        )
        result = await drive(model, tools)

        content = result.tool_result_by_id["u1"]
        assert "not a valid tool" in content
        assert "memory_read" in content
        # 本地工具零执行、循环继续
        assert rec.count("read_workspace_file") == 0
        assert model.invoke_calls == 2

    def test_retry_is_disabled_entirely_to_match_the_old_path(self):
        """阶段 8 裁决 D2：``ToolRetryMiddleware`` 必须对**任何工具都不生效**。

        计划 §5-阶段 2 的重试措辞是「**可以**对明确允许重试的只读工具使用」（可选）。
        阶段 8 故障注入实测：只读工具抛 ``ConnectionError`` / ``TimeoutError`` 时
        候选执行 3 次、旧路径 1 次，而**帧序列两侧逐字节相同**、
        ``langchain/agents/middleware/tool_retry.py`` 全文件无日志 → 不可见的 3× 调用放大；
        且白名单含 ``explore_readonly``，重试它会重跑整个子代理。
        故取严格等价：``RETRYABLE_TOOL_NAMES`` 置空（强制部分「标注写入不自动重试」
        由「完全不重试」同样满足）。详见 ``docs/阶段8-对照度量.md`` D2。
        """
        from langchain.agents.middleware import ToolRetryMiddleware

        from app.agent.langchain_runtime.middleware import (
            RETRYABLE_TOOL_NAMES,
            SYNC_TOOL_NAMES,
        )

        middleware = build_business_middleware(max_tool_rounds=3)
        retry = next(m for m in middleware if isinstance(m, ToolRetryMiddleware))
        # 白名单空集 → 中间件对任何工具都不生效
        assert RETRYABLE_TOOL_NAMES == ()
        assert not getattr(retry, "tools", ())
        # 同步工具集合本身不变（写类/只读的划分仍由 SYNC_TOOL_NAMES 表达）
        assert "auto_annotate" not in SYNC_TOOL_NAMES
        assert "read_workspace_file" in SYNC_TOOL_NAMES


# ── 7. 预算耗尽收尾（清单第 7 项）───────────────────────────────────────


class TestBudgetWrapUp:
    """清单第 7 项：``BudgetWrapUpMiddleware`` + ``ModelCallLimitMiddleware``。

    证明用例：``TestBudgetExhausted::test_exhaustion_forces_final_answer_and_counts_executions``
    （``max_tool_rounds=1`` → 执行 2 次、``astream`` 3 次、兜底 HumanMessage 内容）
    与 ``::test_wrapup_tool_call_is_ignored``（兜底轮 tool_call 不执行）。
    """

    @staticmethod
    def _tool_round(call_id: str) -> list[AIMessageChunk]:
        return [
            tool_call_chunk(
                "read_workspace_file", {"relative_path": "a.md"}, call_id
            )
        ]

    async def test_exhaustion_forces_final_answer_and_counts_executions(self):
        tools, rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}},
                    "result": {"ok": True, "summary": "已读取 a.md"},
                }
            }
        )
        model = ScriptedChat(
            rounds=[
                self._tool_round("call-1"),
                self._tool_round("call-2"),
                [AIMessageChunk(content="预算已用完。当前进展：已读取 a.md。")],
            ]
        )
        result = await drive(model, tools, max_tool_rounds=1)

        # max_tool_rounds=1 → 恰好 2 次工具执行（基线 :924）
        assert rec.count("read_workspace_file") == 2
        assert model.invoke_calls == 3
        assert result.final_text == "预算已用完。当前进展：已读取 a.md。"

        # 兜底轮带上了收尾 HumanMessage（内容逐字复刻 assist_service.py:175-182）
        wrapup_messages = model.seen_messages[2]
        assert isinstance(wrapup_messages[-1], HumanMessage)
        assert "工具调用预算已用完" in wrapup_messages[-1].content
        assert "不要再调用工具" in wrapup_messages[-1].content

    async def test_wrapup_tool_call_is_ignored(self):
        """兜底回答即使吐出 tool_call 也不执行（``assist_service.py`` 不再 execute_round）。"""
        tools, rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}},
                    "result": {"ok": True, "summary": "已读取 a.md"},
                }
            }
        )
        model = ScriptedChat(
            rounds=[
                self._tool_round("call-1"),
                self._tool_round("call-2"),
                [
                    AIMessageChunk(
                        content="预算已用完。",
                        tool_call_chunks=[
                            {
                                "name": "read_workspace_file",
                                "args": '{"relative_path": "b.md"}',
                                "id": "wrapup-1",
                                "index": 0,
                                "type": "tool_call_chunk",
                            }
                        ],
                    )
                ],
            ]
        )
        await drive(model, tools, max_tool_rounds=1)

        # 执行次数仍为 2，且没有 b.md（基线 :991-996）
        assert rec.count("read_workspace_file") == 2
        assert all(
            args != {"relative_path": "b.md"}
            for args in rec.args("read_workspace_file")
        )

    async def test_wrapup_round_binds_no_tools_but_keeps_list_stable_before_it(self):
        """收尾轮的模型调用不带工具（复用 ``assist_service.py:183`` 的 ``llm.astream``）。

        ``create_agent`` 每次模型调用都会 ``bind_tools``，所以这里断言的是
        **收尾轮之后**绑定清单没有变成空列表的历史遗留——即收尾轮走的是
        ``factory.py:1439`` 的 ``model.bind()`` 分支（不调用 ``bind_tools``）。
        因此 ``bind_tools_calls`` 严格小于模型调用数。
        """
        tools, _rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}},
                    "result": {"ok": True, "summary": "已读取 a.md"},
                }
            }
        )
        model = ScriptedChat(
            rounds=[
                self._tool_round("call-1"),
                self._tool_round("call-2"),
                [AIMessageChunk(content="预算已用完。")],
            ]
        )
        await drive(model, tools, max_tool_rounds=1)
        # 3 次模型调用，但只有非收尾的 2 次 bind_tools
        assert model.invoke_calls == 3
        assert model.bind_tools_calls == 2
        # 绑定清单在收尾轮之后没有被清空（收尾轮根本没 bind）
        assert model.bound_tool_names == ["read_workspace_file"]


# ── 8. 跨切面不变量 ─────────────────────────────────────────────────────


class TestInvariants:
    """阶段 2 的跨切面硬约束。"""

    async def test_no_error_event_anywhere(self):
        """不得出现 ``error`` 语义事件（基线 :821 显式断言其缺席）。"""
        tools, _rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}},
                    "raises": RuntimeError("磁盘炸了"),
                }
            }
        )
        model = ScriptedChat(
            rounds=[
                [tool_call_chunk("read_workspace_file", {"relative_path": "a.md"}, "e1")],
                [AIMessageChunk(content="失败")],
            ]
        )
        result = await drive(model, tools)
        for event in result.events:
            if isinstance(event, dict) and event.get("type") == "updates":
                for update in event["data"].values():
                    if isinstance(update, dict):
                        assert "error" not in update

    async def test_plain_text_turn_executes_nothing(self):
        """基线 ``TestEmptyToolCall``：纯文本轮零执行、单次模型调用。"""
        tools, rec = make_tools(
            {"read_workspace_file": {"properties": {"relative_path": {"type": "string"}}}}
        )
        model = ScriptedChat(rounds=[[AIMessageChunk(content="你好，我可以帮你整理工作区。")]])
        result = await drive(model, tools)
        assert rec.calls == {}
        assert model.invoke_calls == 1
        assert not result.saw_tools_node
        assert result.final_text == "你好，我可以帮你整理工作区。"

    async def test_registry_inventory_stays_visible_to_the_model(self):
        """工具清单稳定：所有注册工具都在绑定列表里，写工具也不被隐藏（阶段 0 §3-9）。"""
        from app.agent.tools.registry import build_tools_p1
        from app.core.config import Settings
        from app.models.user import User
        from app.schemas.agent import ClientContextInput

        user = User(
            id=uuid.uuid4(),
            email="test@example.com",
            email_verified=True,
            username="tester",
            display_name="Tester",
            password_hash="x",
            is_active=True,
        )
        settings = Settings(
            _env_file=None,
            SECRET_KEY="stage2-test-secret",
            POSTGRES_PASSWORD="test",
            DATABASE_URL="postgresql+asyncpg://lr_agent:test@localhost:5432/lr_agent",
            REDIS_PASSWORD="test",
            REDIS_URL="redis://:test@localhost:6379/0",
        )
        tools = build_tools_p1(
            user,
            ClientContextInput(workspace_root="/w", work_mode="annotation"),
            settings=settings,
        )
        model = ScriptedChat(rounds=[[AIMessageChunk(content="ok")]])
        result = await drive(model, list(tools), context=AgentContext(mode="annotation"))

        assert model.bound_tool_names == [tool.name for tool in tools]
        assert "write_workspace_file" in model.bound_tool_names
        assert "auto_annotate" in model.bound_tool_names
        assert result.final_text == "ok"

    def test_middleware_list_has_the_required_shape(self):
        """工厂产出的 middleware 清单：官方件齐备 + 顺序满足 hook 折叠规则。"""
        from langchain.agents.middleware import (
            ModelCallLimitMiddleware,
            ToolErrorMiddleware,
            ToolRetryMiddleware,
        )

        from app.agent.langchain_runtime.middleware import (
            BudgetWrapUpMiddleware,
            BusinessRoundMiddleware,
        )

        middleware = build_business_middleware(max_tool_rounds=4)
        assert [type(m) for m in middleware] == [
            BusinessRoundMiddleware,
            ModelCallLimitMiddleware,
            ToolErrorMiddleware,
            ToolRetryMiddleware,
            BudgetWrapUpMiddleware,
        ]
        limit = middleware[1]
        assert limit.run_limit == 6  # max_tool_rounds + 2
        assert limit.thread_limit is None  # 无 checkpointer，不用跨 run 计数
        assert limit.exit_behavior == "end"

    def test_already_completed_is_explicit_and_injected_first(self):
        """``already_completed``（阶段 3 播种）：显式入参、结果第一条、短路后续环节。"""
        message = AIMessage(
            content="",
            tool_calls=[
                {"name": "read_workspace_file", "args": {"relative_path": "a.md"}, "id": "done-1", "type": "tool_call"},
                {"name": "auto_annotate", "args": {"paths": ["d.jpg"]}, "id": "a1", "type": "tool_call"},
            ],
        )
        plan = plan_round(message, completed_tool_ids=frozenset({"done-1"}))
        assert plan.already_completed_ids == ("done-1",)
        payload = json.loads(plan.suppressed[0].result_json)
        assert payload["status"] == "already_completed"
        assert payload["summary"] == ALREADY_COMPLETED_SUMMARY
        # 短路：其余调用不再参与后续环节
        assert plan.deferred == ()
        assert plan.execute_now == ()

    def test_plan_does_not_mutate_input_message(self):
        """纯函数：不得改写入参（并发安全的前提）。"""
        calls = [
            {"name": "auto_annotate", "args": {"paths": ["a.jpg"]}, "id": "c1", "type": "tool_call"},
            {"name": "auto_annotate", "args": {"paths": ["b.jpg"]}, "id": "c2", "type": "tool_call"},
        ]
        message = AIMessage(content="", tool_calls=[dict(c) for c in calls])
        before = [dict(c) for c in message.tool_calls]
        plan_round(message)
        assert [dict(c) for c in message.tool_calls] == before
