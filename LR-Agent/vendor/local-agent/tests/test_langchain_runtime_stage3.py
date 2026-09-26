"""阶段 3：客户端工具跨请求续跑（``app.agent.langchain_runtime.resume``）对照测试。

对照对象是阶段 0 冻结的 OLD 契约（``tests/test_agent_baseline_contract.py``）。
本文件覆盖 ``docs/阶段3-跨请求续跑设计备忘.md`` §7 实施清单第 **3-7、9、10** 项：

| 清单项 | 覆盖它的用例 | 阶段 0 对照样例 |
|--------|--------------|-----------------|
| 3 两段式回合终止（``before_model`` 断路器） | ``TestCrossRequestResume::test_mixed_sync_async_round_after_resume_executes_sync_once`` | ``TestMultipleTools::test_sync_and_async_tool_same_round_executes_sync_then_pends`` |
| 4 resume 消息补齐复用 ``context_service`` | ``TestResumeMessageAssembly`` | ``test_assist_resume_messages.py::test_append_only_tool_message_when_aimessage_already_present`` |
| 5 谎报防护改写（仅 VERIFY） | ``TestHonestyGuardRewrite`` | ``TestProposalConfirm::test_keep_all_resume_rewrites_pending_flags`` / ``test_resume_applied_hint_skips_no_proposal_result`` |
| 6 AWAIT_CONFIRM / VERIFY 门禁落在执行层 | ``TestResumePhaseGate`` | ``tests/test_assist_phase_flow.py`` 的 ``client_tool_results`` 用例 |
| 7 回合结束语义等价 + 跨请求 ``already_completed`` | ``TestCrossRequestResume`` / ``TestNoSecondSideEffect`` | ``TestProposalConfirm::test_pending_then_confirm_resume_alignment``、``test_agent_migration_contract.py::test_pending_resume_preserves_backend_sse_contract`` |
| 9 取代阶段 1 早停 | ``TestEarlyStopNarrowing`` | 阶段 1 ``TestClientToolRound``（早停只对纯客户端轮生效） |
| 10 双次 resume 幂等 | ``TestIdempotentDoubleResume`` | ``test_append_only_tool_message_when_aimessage_already_present`` 的重复投递形态 |

**口径约定**（与阶段 2 测试同源）：

- 不断言 ``bind_tools_calls``（``create_agent`` 每次模型调用都 bind）；
  只断言 ``bound_tool_names`` 稳定性与 ``tool_call_id`` 对齐；
- 工具「执行次数」= 桩函数真实被调用的参数列表长度（与基线 ``executions[name]`` 同口径）；
- 事件来自官方 ``messages`` / ``updates`` 流，不是旧路径的 ``StreamEventPayload``；
  SSE 帧映射属阶段 4。

全部离线、确定性：无网络、无真实模型、无 YOLO、无 Docker、无磁盘写入。
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest

# baseline 环境（只有 langchain-core，无 langchain/langgraph）应整体 skip 而不是 collect error
pytest.importorskip("langchain")

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

from app.agent.assist.task_phase import (  # noqa: E402
    TaskPhase,
    check_call_allowed,
    derive_task_phase,
)
from app.agent.context_service import (  # noqa: E402
    RESUME_APPLIED_NEXT_HINT,
    RESUME_NEXT_HINT,
    append_client_tool_results_to_messages,
    enrich_resume_tool_result,
    unanswered_tool_call_ids,
)
from app.agent.langchain_runtime import AgentContext  # noqa: E402
from app.agent.langchain_runtime.resume import (  # noqa: E402
    answered_tool_call_ids,
    build_resume_agent,
    completed_tool_ids_from,
    prepare_resume_messages,
    prepare_resume_turn,
    proposals_applied,
    stream_resume_raw_events,
    unanswered_client_tool_results,
    with_completed_tool_ids,
)
from app.agent.langchain_runtime.runtime import (  # noqa: E402
    build_langchain_agent,
    stream_agent_raw_events,
)
from app.schemas.agent import (  # noqa: E402
    ClientToolResult,
    ProposalStateInput,
)

pytestmark = pytest.mark.filterwarnings(
    "ignore:Pydantic serializer warnings:UserWarning"
)


# ── 脚本化假模型（与阶段 1/2 同构：``_generate`` + 块级 ``_astream``）──────


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
        return "lr-agent-scripted-chat-stage3"

    @property
    def bound_tool_names(self) -> list[str]:
        return list(self.counters.get("bound_tool_names", []))

    @property
    def invoke_calls(self) -> int:
        return int(self.counters.get("invoke_calls", 0))

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [getattr(t, "name", str(t)) for t in tools]
        return self

    def _round(self) -> list[AIMessageChunk]:
        index = int(self.counters.get("invoke_calls", 0))
        self.counters["invoke_calls"] = index + 1
        if index < len(self.rounds):
            return self.rounds[index]
        # 脚本轮次用尽 → 空文本轮：把「图意外多跑了一轮」变成可观测的 invoke_calls。
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
    """构造「模型发起工具调用」的流式分片（与阶段 0/1/2 同形）。"""
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


# ── 工具桩：真实记录每次调用（执行次数 = 列表长度）──────────────────────

_JSON_TYPE_TO_PY: dict[str, Any] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
}


class Recorder:
    """与基线 ``executions[name]`` 同口径：记录真实执行的参数列表。"""

    def __init__(self) -> None:
        self.calls: dict[str, list[dict[str, Any]]] = {}

    def count(self, name: str) -> int:
        return len(self.calls.get(name, []))

    def args(self, name: str) -> list[dict[str, Any]]:
        return list(self.calls.get(name, []))

    def total(self) -> int:
        return sum(len(items) for items in self.calls.values())


def make_tools(specs: dict[str, dict[str, Any]]) -> tuple[list[StructuredTool], Recorder]:
    """按 ``{name: {"properties": {...}}}`` 造真 ``StructuredTool``（精确 args_schema）。"""
    rec = Recorder()
    tools: list[StructuredTool] = []
    for name, spec in specs.items():
        props: dict[str, dict[str, Any]] = spec.get("properties") or {}
        schema = create_model(
            f"{name}_args",
            **{
                prop: (_JSON_TYPE_TO_PY.get(cfg.get("type", "string"), Any), ...)
                for prop, cfg in props.items()
            },
        )

        def _build(tool_name=name):
            def _impl(**kwargs: Any) -> str:
                rec.calls.setdefault(tool_name, []).append(dict(kwargs))
                return json.dumps(
                    {
                        "ok": True,
                        "tool": tool_name,
                        "status": "ok",
                        "summary": f"{tool_name} ok",
                    },
                    ensure_ascii=False,
                )

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


# ── 驱动与观测 ─────────────────────────────────────────────────────────


class Run:
    """一次 resume 回合的观测结果。"""

    def __init__(self, turn, events: list, model: ScriptedChat, pending: list) -> None:
        self.turn = turn
        self.events = events
        self.model = model
        self.pending = pending

    @property
    def node_sequence(self) -> list[str]:
        seq: list[str] = []
        for event in self.events:
            if isinstance(event, dict) and event.get("type") == "updates":
                seq.extend(event["data"])
        return seq

    @property
    def round_plans(self) -> list[Any]:
        """``after_model`` 节点写进 state 的本轮计划（阶段 4 的读点，实测确实出现在 updates）。"""
        found: list[Any] = []
        for event in self.events:
            if not (isinstance(event, dict) and event.get("type") == "updates"):
                continue
            for update in event["data"].values():
                if isinstance(update, dict) and update.get("round_plan") is not None:
                    found.append(update["round_plan"])
        return found

    @property
    def tool_messages(self) -> list[ToolMessage]:
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
            update = event["data"].get("tools")
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

    @property
    def model_saw(self) -> list[Any]:
        """最后一次模型调用收到的完整消息快照（= 模型真正看到的内容）。"""
        return self.model.seen_messages[-1] if self.model.seen_messages else []

    @property
    def model_saw_tool_messages(self) -> list[ToolMessage]:
        return [m for m in self.model_saw if isinstance(m, ToolMessage)]


async def run_resume(
    model: ScriptedChat,
    tools: list[StructuredTool],
    lc_messages: list,
    client_tool_results: list | None = None,
    *,
    phase_ctx=None,
    context: AgentContext | None = None,
    max_tool_rounds: int = 5,
) -> Run:
    """跑一次候选 resume 回合（业务 middleware + ``stream_resume_raw_events``）。"""
    agent = build_resume_agent(model, tools, max_tool_rounds=max_tool_rounds)
    turn = prepare_resume_turn(
        lc_messages,
        client_tool_results,
        context=context if context is not None else AgentContext(mode="annotation"),
        phase_ctx=phase_ctx,
    )
    pending: list = []
    events = [
        event
        async for event in stream_resume_raw_events(agent, turn, pending_calls_out=pending)
    ]
    return Run(turn, events, model, pending)


# ── 共用输入 ───────────────────────────────────────────────────────────


def auto_annotate_result(
    *, call_id: str = "c1", pending: bool = True, written: bool = False, status: str = "completed"
) -> ClientToolResult:
    return ClientToolResult(
        tool_call_id=call_id,
        name="auto_annotate",
        result=json.dumps(
            {
                "status": status,
                "tool": "auto_annotate",
                "summary": "已生成待确认提案（未写盘）。批量标注完成：处理 5 张，共 14 个框。",
                "proposal_pending": pending,
                "file_written": written,
            },
            ensure_ascii=False,
        ),
    )


def history_with_declared_call(call_id: str = "c1", path: str = "data/1.jpg") -> list:
    """resume 请求的典型消息形态：客户端重发本轮 assistant 的 ``tool_calls``。"""
    return [
        HumanMessage(content=f"标注 {path}"),
        AIMessage(
            content="",
            tool_calls=[{"id": call_id, "name": "auto_annotate", "args": {"paths": [path]}}],
        ),
    ]


ANNOTATE_TOOL = {"auto_annotate": {"properties": {"paths": {"type": "array"}}}}


# ── 清单第 4 项：resume 消息补齐复用 context_service ────────────────────


class TestResumeMessageAssembly:
    """清单第 4 项。对照 ``test_assist_resume_messages.py``（旧函数本身的契约）。"""

    def test_reuses_the_old_assembler_byte_for_byte(self):
        """候选的补齐结果与直接调用旧函数**逐字节相同**（证明是复用而非重写）。"""
        lc_messages = history_with_declared_call()
        results = [auto_annotate_result()]

        ours = prepare_resume_messages(
            lc_messages, results, user_content="标注 data/1.jpg"
        )
        expected = append_client_tool_results_to_messages(
            history_with_declared_call(),
            [auto_annotate_result()],
            user_content="标注 data/1.jpg",
            proposals_applied=False,
        )

        assert [type(m).__name__ for m in ours] == [type(m).__name__ for m in expected]
        assert [getattr(m, "content", "") for m in ours] == [
            getattr(m, "content", "") for m in expected
        ]
        assert [getattr(m, "tool_call_id", None) for m in ours] == [
            getattr(m, "tool_call_id", None) for m in expected
        ]

    def test_declared_id_gets_only_a_tool_message(self):
        """已声明的 ``tool_call_id`` 只补 ``ToolMessage``（不重复插 ``AIMessage``）。"""
        messages = history_with_declared_call()
        out = prepare_resume_messages(messages, [auto_annotate_result()])

        assert len(out) == 3
        ai_messages = [m for m in out if isinstance(m, AIMessage)]
        tool_messages = [m for m in out if isinstance(m, ToolMessage)]
        assert [[tc["id"] for tc in m.tool_calls] for m in ai_messages] == [["c1"]]
        assert [m.tool_call_id for m in tool_messages] == ["c1"]
        assert json.loads(tool_messages[0].content)["next_hint"] == RESUME_NEXT_HINT

    def test_undeclared_id_gets_a_synthetic_ai_and_tool_pair(self):
        """从未声明的 id 才补「合成 ``AIMessage`` + ``ToolMessage``」对（旧函数行为）。"""
        out = prepare_resume_messages(
            [HumanMessage(content="标注")],
            [auto_annotate_result(call_id="s1")],
            user_content="标注",
        )
        assert [type(m).__name__ for m in out] == ["HumanMessage", "AIMessage", "ToolMessage"]
        call = out[1].tool_calls[0]
        assert call["id"] == "s1"
        assert call["name"] == "auto_annotate"
        assert call["args"] == {"user_request": "标注"}
        assert out[2].tool_call_id == "s1"

    def test_ids_that_never_come_back_keep_no_tool_message(self):
        """从未回来的 id 保持**没有** ``ToolMessage``（与旧路径同态）。"""
        messages = [
            HumanMessage(content="标注"),
            AIMessage(
                content="",
                tool_calls=[
                    {"id": "c1", "name": "auto_annotate", "args": {"paths": ["a.jpg"]}},
                    {"id": "c2", "name": "auto_annotate", "args": {"paths": ["b.jpg"]}},
                ],
            ),
        ]
        out = prepare_resume_messages(messages, [auto_annotate_result(call_id="c1")])

        assert [m.tool_call_id for m in out if isinstance(m, ToolMessage)] == ["c1"]
        assert unanswered_tool_call_ids(out) == {"c2"}

    def test_does_not_mutate_the_caller_messages(self):
        messages = history_with_declared_call()
        prepare_resume_messages(messages, [auto_annotate_result()])
        assert len(messages) == 2

    def test_empty_results_is_a_noop(self):
        messages = history_with_declared_call()
        assert prepare_resume_messages(messages, []) == messages
        assert prepare_resume_messages(messages, None) == messages

    def test_answered_helper_matches_input_tool_messages(self):
        messages = history_with_declared_call() + [
            ToolMessage(content="{}", tool_call_id="c1")
        ]
        assert answered_tool_call_ids(messages) == {"c1"}
        assert unanswered_client_tool_results(messages, [auto_annotate_result()]) == []


# ── 清单第 4 项（续）：completed_tool_ids 播种 ─────────────────────────


class TestResumeContextSeeding:
    def test_completed_ids_come_from_client_tool_results(self):
        ids = completed_tool_ids_from(
            [auto_annotate_result(call_id="c1"), auto_annotate_result(call_id="m2")]
        )
        assert ids == {"c1", "m2"}
        assert completed_tool_ids_from(None) == frozenset()

    def test_seeding_is_idempotent_and_does_not_mutate_the_input_context(self):
        base = AgentContext(mode="annotation")
        once = with_completed_tool_ids(base, ["c1"])
        twice = with_completed_tool_ids(once, ["c1"])

        assert base.completed_tool_ids == frozenset()
        assert once.completed_tool_ids == {"c1"}
        assert twice is once  # 二次播种同一批 id 直接返回原对象
        assert with_completed_tool_ids(once, []).completed_tool_ids == {"c1"}

    def test_prepare_turn_fills_phase_ctx_and_completed_ids(self):
        states = [
            ProposalStateInput(path="data/1.jpg", kind="annotation", status="applied")
        ]
        phase_ctx = derive_task_phase(states)
        assert phase_ctx is not None and phase_ctx.phase == TaskPhase.VERIFY

        turn = prepare_resume_turn(
            history_with_declared_call(),
            [auto_annotate_result()],
            context=AgentContext(mode="annotation"),
            phase_ctx=phase_ctx,
        )

        assert turn.context.task_phase_context is phase_ctx
        assert turn.context.completed_tool_ids == {"c1"}
        assert turn.completed_tool_ids == {"c1"}
        # 客户端工具名默认取注册表真相源（仅作 pending_calls_out 的结构防线；
        # 终止判据由 stream_resume_raw_events 的 early_stop_on_client_tools=False 关闭）
        assert "auto_annotate" in turn.context.client_tool_names
        assert "read_workspace_file" not in turn.context.client_tool_names

    def test_explicit_task_phase_context_wins(self):
        states = [
            ProposalStateInput(path="data/1.jpg", kind="annotation", status="applied")
        ]
        explicit = derive_task_phase(states)
        turn = prepare_resume_turn(
            [HumanMessage(content="x")],
            [],
            context=AgentContext(task_phase_context=explicit),
            phase_ctx=None,
        )
        assert turn.context.task_phase_context is explicit

    def test_context_updates_are_applied_to_a_copy(self):
        base = AgentContext(mode="assist")
        turn = prepare_resume_turn(
            [HumanMessage(content="x")],
            [],
            context=base,
            context_updates={"mode": "annotation", "workspace_root": "/w"},
        )
        assert base.mode == "assist" and base.workspace_root is None
        assert turn.context.mode == "annotation"
        assert turn.context.workspace_root == "/w"

    def test_proposals_applied_only_in_verify(self):
        assert proposals_applied(None) is False
        await_confirm = derive_task_phase(
            [ProposalStateInput(path="a.jpg", kind="annotation", status="pending")]
        )
        verify = derive_task_phase(
            [ProposalStateInput(path="a.jpg", kind="annotation", status="applied")]
        )
        assert proposals_applied(await_confirm) is False
        assert proposals_applied(verify) is True


# ── 清单第 5 项：谎报防护改写（仅 VERIFY）──────────────────────────────


class TestHonestyGuardRewrite:
    """对照 ``TestProposalConfirm::test_keep_all_resume_rewrites_pending_flags``（:579-617）
    与 ``test_append_only_tool_message_when_aimessage_already_present``。"""

    def _verify_ctx(self):
        ctx = derive_task_phase(
            [ProposalStateInput(path="data/1.jpg", kind="annotation", status="applied")]
        )
        assert ctx is not None and ctx.phase == TaskPhase.VERIFY
        return ctx

    def test_keep_all_rewrites_pending_flags_before_the_model_sees_them(self):
        payload = json.dumps(
            {"status": "completed", "proposal_pending": True, "file_written": False},
            ensure_ascii=False,
        )
        result = ClientToolResult(
            tool_call_id="c1", name="auto_annotate", result=payload
        )
        out = prepare_resume_messages(
            history_with_declared_call(), [result], phase_ctx=self._verify_ctx()
        )
        tool_message = [m for m in out if isinstance(m, ToolMessage)][0]
        rewritten = json.loads(tool_message.content)

        assert rewritten["proposal_pending"] is False
        assert rewritten["file_written"] is True
        assert rewritten["next_hint"] == RESUME_APPLIED_NEXT_HINT
        assert "Keep All" in rewritten["next_hint"]
        # 逐字节等于旧路径的改写函数（复用而非近似）
        assert tool_message.content == enrich_resume_tool_result(
            payload, proposals_applied=True
        )

    def test_await_confirm_keeps_pending_flags(self):
        await_confirm = derive_task_phase(
            [ProposalStateInput(path="data/2.jpg", kind="annotation", status="pending")]
        )
        out = prepare_resume_messages(
            history_with_declared_call(), [auto_annotate_result()], phase_ctx=await_confirm
        )
        payload = json.loads([m for m in out if isinstance(m, ToolMessage)][0].content)

        assert payload["proposal_pending"] is True
        assert payload["file_written"] is False
        assert payload["next_hint"] == RESUME_NEXT_HINT
        assert "不要声称已标注" in payload["next_hint"]

    def test_skipped_mutation_is_never_reported_as_written(self):
        """VERIFY 阶段但 mutate 未生成提案 → 不得谎报已写盘（阶段 0 同款）。"""
        result = ClientToolResult(
            tool_call_id="m1",
            name="mutate_annotation",
            result=json.dumps(
                {
                    "status": "skipped",
                    "summary": "未生成提案",
                    "proposal_pending": False,
                    "file_written": False,
                },
                ensure_ascii=False,
            ),
        )
        out = prepare_resume_messages(
            [HumanMessage(content="修正标注")], [result], phase_ctx=self._verify_ctx()
        )
        payload = json.loads([m for m in out if isinstance(m, ToolMessage)][0].content)

        assert payload["file_written"] is False
        assert payload["next_hint"] == RESUME_NEXT_HINT

    async def test_model_sees_the_rewritten_payload(self):
        """改写必须发生在**模型看到之前**：断言真实模型调用收到的 ToolMessage。"""
        tools, rec = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(rounds=[[AIMessageChunk(content="已核对落盘结果。")]])
        run = await run_resume(
            model,
            tools,
            history_with_declared_call(),
            [auto_annotate_result(pending=True, written=False)],
            phase_ctx=self._verify_ctx(),
        )

        seen = run.model_saw_tool_messages
        assert [m.tool_call_id for m in seen] == ["c1"]
        payload = json.loads(seen[0].content)
        assert payload["proposal_pending"] is False
        assert payload["file_written"] is True
        assert "Keep All" in payload["next_hint"]
        # 后端零执行 + 单轮模型调用（回合结束语义与旧路径一致）
        assert rec.total() == 0
        assert model.invoke_calls == 1
        assert run.saw_tools_node is False


# ── 清单第 6 项：AWAIT_CONFIRM / VERIFY 门禁落在执行层 ─────────────────


class TestResumePhaseGate:
    """对照 ``tests/test_assist_phase_flow.py`` 的 ``client_tool_results`` 用例。"""

    async def test_await_confirm_blocks_write_tool_on_resume(self):
        states = [
            ProposalStateInput(path="data/2.jpg", kind="annotation", status="pending")
        ]
        phase_ctx = derive_task_phase(states)
        assert phase_ctx is not None and phase_ctx.phase == TaskPhase.AWAIT_CONFIRM

        tools, rec = make_tools(
            {
                "write_workspace_file": {
                    "properties": {
                        "relative_path": {"type": "string"},
                        "content": {"type": "string"},
                    }
                },
                **ANNOTATE_TOOL,
            }
        )
        write_args = {"relative_path": "reports/r.md", "content": "# 报告"}
        model = ScriptedChat(
            rounds=[
                [tool_call_chunk("write_workspace_file", write_args, "w1")],
                [AIMessageChunk(content="提案已生成，请 Keep All 后我再生成报告。")],
            ]
        )
        run = await run_resume(
            model,
            tools,
            [HumanMessage(content="补标并写报告")],
            [auto_annotate_result()],
            phase_ctx=phase_ctx,
        )

        # 写工具零执行（执行层唯一门禁），且理由逐字等于 check_call_allowed 的返回
        assert rec.count("write_workspace_file") == 0
        assert rec.total() == 0
        injected = json.loads(run.tool_result_by_id["w1"])
        assert injected["status"] == "phase_blocked"
        assert injected["ok"] is False
        assert injected["summary"] == check_call_allowed(
            "write_workspace_file", write_args, phase_ctx
        )
        assert "Keep All" in injected["summary"]
        # 门禁反馈后模型继续一轮 → 最终回答提示用户确认（旧路径 tool_loop.py:537-539 同态）
        assert model.invoke_calls == 2
        assert "Keep All" in run.final_text
        # 工具清单保持稳定（不在 bind 时删减，保 system prompt 前缀缓存）
        assert "write_workspace_file" in model.bound_tool_names

    async def test_verify_blocks_reannotation_of_applied_path_on_resume(self):
        states = [
            ProposalStateInput(path="data/2.jpg", kind="annotation", status="applied")
        ]
        phase_ctx = derive_task_phase(states)
        assert phase_ctx is not None and phase_ctx.phase == TaskPhase.VERIFY

        tools, rec = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk(
                        "auto_annotate", {"paths": ["data/2.jpg"]}, "a9"
                    )
                ],
                [AIMessageChunk(content="该文件已落盘，不再重复标注。")],
            ]
        )
        run = await run_resume(
            model,
            tools,
            history_with_declared_call(),
            [auto_annotate_result()],
            phase_ctx=phase_ctx,
        )

        assert rec.count("auto_annotate") == 0
        injected = json.loads(run.tool_result_by_id["a9"])
        assert injected["status"] == "phase_blocked"
        assert injected["summary"] == check_call_allowed(
            "auto_annotate", {"paths": ["data/2.jpg"]}, phase_ctx
        )
        assert "请勿重复标注" in injected["summary"]
        # 该轮调用被门禁拦下：**权威**挂起集合（state 里的计划）为空
        plan = run.round_plans[0]
        assert plan.deferred == ()
        assert [c.tool_call_id for c in plan.suppressed] == ["a9"]
        # ``pending_calls_out`` 是「按工具名」的**结构防线**素材（不知道门禁结果），
        # 因此它仍然列出 a9；阶段 4 必须以 ``round_plan`` 为准。
        assert [call["tool_call_id"] for call in run.pending] == ["a9"]

    async def test_all_dismissed_disables_the_gate_on_resume(self):
        """对照 ``TestDismissAndReject::test_all_dismissed_clears_gate_and_allows_replanning``。"""
        states = [
            ProposalStateInput(path="data/2.jpg", kind="annotation", status="dismissed")
        ]
        assert derive_task_phase(states) is None

        tools, rec = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(
            rounds=[[tool_call_chunk("auto_annotate", {"paths": ["data/2.jpg"]}, "d1")]]
        )
        run = await run_resume(
            model,
            tools,
            [HumanMessage(content="继续标注 data/2.jpg")],
            [auto_annotate_result()],
            phase_ctx=derive_task_phase(states),
        )

        # 门禁解除 → 调用正常挂起（而不是 phase_blocked），后端零执行
        assert rec.total() == 0
        assert not any(
            json.loads(content)["status"] == "phase_blocked"
            for content in run.tool_result_by_id.values()
        )
        assert [c.tool_call_id for c in run.round_plans[0].deferred] == ["d1"]
        assert "d1" in [call["tool_call_id"] for call in run.pending]


# ── 清单第 3/7 项：跨请求续跑、already_completed、回合终止 ─────────────


class TestCrossRequestResume:
    async def test_pending_then_confirm_resume_alignment(self):
        """对照 ``TestProposalConfirm::test_pending_then_confirm_resume_alignment``（:503-577）
        与 ``test_agent_migration_contract.py::test_pending_resume_preserves_backend_sse_contract``。"""
        tools, rec = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(
            rounds=[[AIMessageChunk(content="已收到标注结果，等待用户确认提案。")]]
        )
        run = await run_resume(
            model,
            tools,
            history_with_declared_call(),
            [auto_annotate_result()],
        )

        # 1) 消息对齐：合成 AIMessage(tool_calls) 与 ToolMessage 的 id 一致
        seen = run.model_saw
        declared = [
            call["id"]
            for message in seen
            if isinstance(message, AIMessage)
            for call in (message.tool_calls or [])
        ]
        assert declared == ["c1"]
        assert [m.tool_call_id for m in run.model_saw_tool_messages] == ["c1"]
        assert "next_hint" in run.model_saw_tool_messages[0].content

        # 2) 回合结束语义等价：一轮模型调用、无 tools 节点、最终文本等于旧路径
        assert model.invoke_calls == 1
        assert run.saw_tools_node is False
        assert run.final_text == "已收到标注结果，等待用户确认提案。"
        # 3) resume 回合不重复执行客户端工具
        assert rec.total() == 0

    async def test_repeat_client_call_is_suppressed_across_requests(self):
        """模型复读上一轮已挂起的调用 → 跨请求 ``already_completed``，零二次执行。"""
        tools, rec = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(
            rounds=[
                # 第 1 轮：复读 c1（同一 tool_call_id）
                [tool_call_chunk("auto_annotate", {"paths": ["data/1.jpg"]}, "c1")],
                # 第 2 轮：收到 already_completed 反馈后的最终回答
                [AIMessageChunk(content="已收到结果，不再重复发起。")],
            ]
        )
        run = await run_resume(
            model,
            tools,
            history_with_declared_call(),
            [auto_annotate_result()],
        )

        plans = run.round_plans
        assert plans, "after_model 必须把本轮计划写进 state（阶段 4 的读点）"
        first = plans[0]
        assert [c.tool_call_id for c in first.suppressed] == ["c1"]
        assert json.loads(first.suppressed[0].result_json)["status"] == "already_completed"
        assert first.deferred == () and first.execute_now == ()

        assert rec.total() == 0
        assert model.invoke_calls == 2
        assert run.final_text == "已收到结果，不再重复发起。"
        # 模型看到「原始结果（带 next_hint）」+「already_completed 反馈」两条
        statuses = [
            json.loads(m.content)["status"]
            for m in run.model_saw_tool_messages
            if m.tool_call_id == "c1"
        ]
        assert statuses == ["completed", "already_completed"]

    async def test_mixed_sync_async_round_after_resume_executes_sync_once(self):
        """清单第 3/7 项：混合同轮里 SYNC 恰好 1 次、ASYNC 零执行、回合经断路器终止。

        对照 ``TestMultipleTools::test_sync_and_async_tool_same_round_executes_sync_then_pends``
        （``executions["auto_annotate"] == []``、``llm.astream_calls == 1``）。
        """
        tools, rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}}
                },
                **ANNOTATE_TOOL,
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk("read_workspace_file", {"relative_path": "a.md"}, "r1"),
                    tool_call_chunk("auto_annotate", {"paths": ["data/3.jpg"]}, "a2"),
                ],
                [AIMessageChunk(content="读完了，标注已交给客户端。")],
            ]
        )
        run = await run_resume(
            model,
            tools,
            history_with_declared_call(),
            [auto_annotate_result()],
        )

        # SYNC 恰好执行一次且参数逐字来自模型调用；ASYNC 后端零执行
        assert rec.args("read_workspace_file") == [{"relative_path": "a.md"}]
        assert rec.count("auto_annotate") == 0
        # tools 节点确实跑了：r1 是真执行；a2 只是被 awrap_tool_call 拦下并产出
        # 合成的 client_tool_pending 结果（框架要求每个被调度的 tool_call 有结果）。
        # **阶段 4 注意**：旧路径此时不追加任何 ToolMessage，适配器不得把它渲染成 tool_result。
        assert sorted(run.executed_tool_ids) == ["a2", "r1"]
        assert (
            json.loads(run.tool_result_by_id["a2"])["status"] == "client_tool_pending"
        )

        plan = [p for p in run.round_plans if p.calls][0]
        assert [c.tool_call_id for c in plan.execute_now] == ["r1"]
        assert [c.tool_call_id for c in plan.deferred] == ["a2"]

        # 两段式终止：tools → before_model 断路器结束回合
        # （与旧路径 mixed 轮「SYNC 执行后 tool_pending 结束本轮、不再发起模型调用」同态：
        #  基线 ``TestMultipleTools::..._executes_sync_then_pends`` 断言 ``astream_calls == 1``）
        assert model.invoke_calls == 1
        assert run.node_sequence[-1] == "BusinessRoundMiddleware.before_model"
        assert run.final_text == ""
        assert run.pending and run.pending[0]["tool_call_id"] == "a2"

    async def test_pure_client_round_ends_without_a_second_model_call(self):
        """纯挂起轮：计划帧可见、零执行、单次模型调用（旧路径 ``tool_pending`` 同态）。"""
        tools, rec = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(
            rounds=[[tool_call_chunk("auto_annotate", {"paths": ["data/9.jpg"]}, "n1")]]
        )
        run = await run_resume(
            model,
            tools,
            [HumanMessage(content="标注 data/9.jpg")],
            [],
        )

        assert rec.total() == 0
        assert model.invoke_calls == 1
        assert run.saw_tools_node is False
        plan = run.round_plans[0]
        assert [c.tool_call_id for c in plan.deferred] == ["n1"]
        assert [c.tool_call_id for c in plan.execute_now] == []
        assert [call["tool_call_id"] for call in run.pending] == ["n1"]
        assert run.turn.completed_tool_ids == frozenset()


# ── 清单第 7 项（续）：无第二副作用 ────────────────────────────────────


class TestNoSecondSideEffect:
    async def test_resume_turn_executes_each_server_tool_at_most_once(self):
        """VERIFY 阶段允许的写工具在 resume 回合内**恰好一次**（无重试、无重复）。"""
        states = [
            ProposalStateInput(path="data/2.jpg", kind="annotation", status="applied")
        ]
        phase_ctx = derive_task_phase(states)

        tools, rec = make_tools(
            {
                "write_workspace_file": {
                    "properties": {
                        "relative_path": {"type": "string"},
                        "content": {"type": "string"},
                    }
                },
                **ANNOTATE_TOOL,
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk(
                        "write_workspace_file",
                        {"relative_path": "reports/r.md", "content": "# 报告"},
                        "w1",
                    )
                ],
                [AIMessageChunk(content="报告已生成。")],
            ]
        )
        run = await run_resume(
            model,
            tools,
            history_with_declared_call(),
            [auto_annotate_result()],
            phase_ctx=phase_ctx,
        )

        assert rec.count("write_workspace_file") == 1
        assert rec.count("auto_annotate") == 0
        assert run.executed_tool_ids == ["w1"]
        assert run.final_text == "报告已生成。"
        assert model.invoke_calls == 2

    async def test_resume_request_leaves_no_server_side_state(self):
        """方案 A：resume 只从请求体读数据，不引入任何跨请求状态（无 checkpointer）。

        用 ``ast`` 扫描**代码**（跳过 docstring / 注释里的名词），
        避免「文档里提到 checkpointer」被误判为「代码用了 checkpointer」。
        """
        import ast
        import inspect

        from app.agent.langchain_runtime import resume as resume_module

        tree = ast.parse(inspect.getsource(resume_module))
        used: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                used.add(node.id)
            elif isinstance(node, ast.Attribute):
                used.add(node.attr)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    used.add(alias.name.split(".")[-1])
                module = getattr(node, "module", None)
                if module:
                    used.add(module.split(".")[-1])

        forbidden = {
            "interrupt",
            "Command",
            "StateGraph",
            "InMemorySaver",
            "BaseCheckpointSaver",
            "HumanInTheLoopMiddleware",
            "langgraph",
        }
        assert used & forbidden == set(), sorted(used & forbidden)

    async def test_resume_turn_passes_no_state_to_the_graph_input(self):
        """图输入只有 ``messages``（``stream_agent_raw_events`` 的唯一写入点）。"""
        import inspect

        from app.agent.langchain_runtime import resume as resume_module

        source = inspect.getsource(resume_module)
        assert '{"messages":' not in source.replace('{"messages": list(messages)}', "")
        assert "checkpointer=" not in source

    async def test_agent_build_keeps_business_middleware_first(self):
        """组装顺序是承重面（阶段 2 实测）：``BusinessRoundMiddleware`` 必须首位。"""
        tools, _ = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(rounds=[[AIMessageChunk(content="ok")]])
        agent = build_resume_agent(model, tools, max_tool_rounds=2)

        names = [name for name in agent.nodes if name.endswith(".after_model")]
        assert names and names[0].startswith("BusinessRoundMiddleware"), names


# ── 清单第 9 项：取代阶段 1 早停 ───────────────────────────────────────


class TestEarlyStopNarrowing:
    """阶段 1 早停已降级为**兼容路径专用**：挂了 ``after_model`` 业务件的 Agent 自动禁用。"""

    async def test_legacy_early_stop_still_stops_a_pure_client_round(self):
        """无业务 middleware 的 Agent 保持阶段 1 行为（阶段 1 的 3 个用例依赖它）。"""
        tools, rec = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(
            rounds=[
                [tool_call_chunk("auto_annotate", {"paths": ["data/1.jpg"]}, "p1")],
                [AIMessageChunk(content="这一轮不应该发生。")],
            ]
        )
        agent = build_langchain_agent(model, tools)
        pending: list = []
        events = [
            event
            async for event in stream_agent_raw_events(
                agent,
                [HumanMessage(content="标注 data/1.jpg")],
                context=AgentContext(
                    mode="annotation", client_tool_names=frozenset({"auto_annotate"})
                ),
                pending_calls_out=pending,
            )
        ]

        assert model.invoke_calls == 1
        assert [call["name"] for call in pending] == ["auto_annotate"]
        assert rec.total() == 0
        assert events, "早停前的事件必须照常产出"

    async def test_explicit_false_disables_it_on_a_legacy_agent(self):
        """**边界**：无 middleware 时手动关早停 ⇒ 客户端工具会被送进 ``tools`` 节点执行。

        因此「早停 + ``client_tool_names``」是阶段 1 兼容配置的**唯一**结构防线，
        生产候选路径必须走业务 middleware（``awrap_tool_call`` 无条件硬拦 ASYNC）
        或让工具清单不含客户端工具。
        """
        tools, rec = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(
            rounds=[
                [tool_call_chunk("auto_annotate", {"paths": ["data/1.jpg"]}, "p1")],
                [AIMessageChunk(content="第二轮。")],
            ]
        )
        agent = build_langchain_agent(model, tools)
        pending: list = []
        async for _ in stream_agent_raw_events(
            agent,
            [HumanMessage(content="标注 data/1.jpg")],
            context=AgentContext(
                mode="annotation", client_tool_names=frozenset({"auto_annotate"})
            ),
            pending_calls_out=pending,
            early_stop_on_client_tools=False,
        ):
            pass

        # 不再断流：图继续走到第二轮（阶段 1 早停下这里恒为 1）
        assert model.invoke_calls == 2
        assert [call["tool_call_id"] for call in pending] == ["p1"]
        # 这就是**不能**在无 middleware 的配置下关早停的原因：
        # 客户端工具（此处是注册表存根）在后端被真实调用了 1 次。
        assert rec.count("auto_annotate") == 1

    async def test_business_agent_is_never_truncated_even_with_client_tool_names(self):
        """阶段 1 缺陷（``runtime.py`` 的按名断流）的回归测试。

        同一轮 ``[SYNC, ASYNC]`` 且 ``client_tool_names`` 非空时，旧判据会在
        ``tools`` 节点之前 ``break``，导致 SYNC 工具**零执行**。
        挂了 ``BusinessRoundMiddleware`` 后早停自动失效（``early_stop_on_client_tools``
        取默认 ``None``，由 ``_has_after_model_hook`` 判定）。
        """
        tools, rec = make_tools(
            {
                "read_workspace_file": {
                    "properties": {"relative_path": {"type": "string"}}
                },
                **ANNOTATE_TOOL,
            }
        )
        model = ScriptedChat(
            rounds=[
                [
                    tool_call_chunk("read_workspace_file", {"relative_path": "a.md"}, "r1"),
                    tool_call_chunk("auto_annotate", {"paths": ["data/1.jpg"]}, "a1"),
                ],
                [AIMessageChunk(content="这一轮不应该发生。")],
            ]
        )
        agent = build_resume_agent(model, tools, max_tool_rounds=3)
        pending: list = []
        events = [
            event
            async for event in stream_agent_raw_events(
                agent,
                [HumanMessage(content="读 a.md 并标注")],
                context=AgentContext(
                    mode="annotation", client_tool_names=frozenset({"auto_annotate"})
                ),
                pending_calls_out=pending,
            )
        ]

        # 修复点：SYNC 工具真的执行了（旧判据下这里恒为 0 次）
        assert rec.args("read_workspace_file") == [{"relative_path": "a.md"}]
        # ASYNC 仍然后端零执行（由 awrap_tool_call 无条件硬拦）
        assert rec.count("auto_annotate") == 0
        # 结构防线素材仍然记录该客户端调用
        assert [call["tool_call_id"] for call in pending] == ["a1"]
        # 混合同轮不再截断：图走完了 tools 节点（旧判据下连 tools 都进不去），
        # 随后由两段式断路器结束回合 —— 与旧路径「SYNC 执行后 tool_pending 结束本轮」
        # 同态（基线 ``astream_calls == 1``），因此第二轮脚本（canary）不得被消费。
        assert model.invoke_calls == 1
        assert any(
            isinstance(event, dict)
            and event.get("type") == "updates"
            and "tools" in event["data"]
            for event in events
        )

    async def test_resume_driver_disables_the_early_stop_entirely(self):
        """业务路径显式 ``early_stop_on_client_tools=False``：纯客户端轮也照常计算计划。"""
        tools, rec = make_tools(ANNOTATE_TOOL)
        model = ScriptedChat(
            rounds=[[tool_call_chunk("auto_annotate", {"paths": ["data/1.jpg"]}, "n1")]]
        )
        run = await run_resume(
            model,
            tools,
            [HumanMessage(content="标注 data/1.jpg")],
            [],
        )
        assert run.round_plans, "早停一旦生效，after_model 的计划就不会被计算"
        assert rec.total() == 0


# ── 清单第 10 项：双次 resume 幂等 ─────────────────────────────────────


class TestIdempotentDoubleResume:
    async def test_resume_twice_is_idempotent(self):
        """重复投递同一批 ``client_tool_results``：不重复补消息、不重复执行、不重复写盘。

        移植 ``test_append_only_tool_message_when_aimessage_already_present`` 的
        「重复投递」形态：第二次投递时输入消息里已经有该 id 的 ``ToolMessage``。
        """
        tools, rec = make_tools(ANNOTATE_TOOL)
        results = [auto_annotate_result()]

        # 第 1 次投递
        first_model = ScriptedChat(rounds=[[AIMessageChunk(content="已收到结果。")]])
        first = await run_resume(
            first_model, tools, history_with_declared_call(), results
        )
        assert [m.tool_call_id for m in first.model_saw_tool_messages] == ["c1"]
        assert len(first.turn.messages) == 3

        # 第 2 次投递：前端把上一轮的 tool 结果也重发（或重试整个请求）
        repeat_messages = [
            *history_with_declared_call(),
            ToolMessage(content="{}", tool_call_id="c1"),
        ]
        second_model = ScriptedChat(rounds=[[AIMessageChunk(content="已收到结果。")]])
        second = await run_resume(
            second_model, tools, repeat_messages, results
        )

        # 消息层：不再追加第二条 c1 结果（旧函数此时会补一对合成消息，见 docstring 证据）
        assert len(second.turn.messages) == 3
        assert [
            m.tool_call_id for m in second.turn.messages if isinstance(m, ToolMessage)
        ] == ["c1"]
        assert [
            [tc["id"] for tc in m.tool_calls]
            for m in second.turn.messages
            if isinstance(m, AIMessage)
        ] == [["c1"]]

        # 执行层：两次投递都零后端执行、零副作用，模型调用轮数完全相同
        assert rec.total() == 0
        assert second_model.invoke_calls == first_model.invoke_calls == 1
        assert second.final_text == first.final_text
        assert second.turn.completed_tool_ids == first.turn.completed_tool_ids == {"c1"}
        assert len([m for m in second.model_saw_tool_messages if m.tool_call_id == "c1"]) == 1

    def test_prepare_is_idempotent_on_its_own_output(self):
        """消息层幂等的直接证明：把补齐后的消息再补一次，长度与内容都不变。"""
        once = prepare_resume_messages(history_with_declared_call(), [auto_annotate_result()])
        twice = prepare_resume_messages(once, [auto_annotate_result()])
        thrice = prepare_resume_messages(twice, [auto_annotate_result()])

        assert len(once) == len(twice) == len(thrice) == 3
        assert [m.content for m in twice] == [m.content for m in once]
        assert [m.tool_call_id for m in twice if isinstance(m, ToolMessage)] == ["c1"]

    def test_old_assembler_is_not_idempotent_for_repeat_delivery(self):
        """记录候选侧幂等守卫的**必要性**：旧函数在「已答」id 上会补一对合成消息。

        这是候选侧与旧路径的**刻意差异**（阶段 3 唯一一处行为收窄），
        证据：``context_service.py:88-116`` 只区分「已声明未答」与「未声明」，
        对「已答」走 ``else`` 分支再补 ``AIMessage`` + ``ToolMessage``。
        """
        messages = [
            *history_with_declared_call(),
            ToolMessage(content="{}", tool_call_id="c1"),
        ]
        legacy_out = append_client_tool_results_to_messages(
            list(messages), [auto_annotate_result()], user_content="标注 data/1.jpg"
        )
        ours = prepare_resume_messages(messages, [auto_annotate_result()])

        assert len(legacy_out) == 5
        assert [m.tool_call_id for m in legacy_out if isinstance(m, ToolMessage)] == [
            "c1",
            "c1",
        ]
        assert len(ours) == 3

    async def test_repeat_delivery_with_a_second_client_call_still_applies_it(self):
        """幂等不等于吞掉新结果：第 2 次投递里的**新** id 照常补齐。"""
        tools, rec = make_tools(
            {
                "auto_annotate": {"properties": {"paths": {"type": "array"}}},
                "mutate_annotation": {"properties": {"annotation_ids": {"type": "array"}}},
            }
        )
        messages = [
            *history_with_declared_call(),
            ToolMessage(content="{}", tool_call_id="c1"),
        ]
        model = ScriptedChat(rounds=[[AIMessageChunk(content="收到两批结果。")]])
        run = await run_resume(
            model,
            tools,
            messages,
            [
                auto_annotate_result(call_id="c1"),
                ClientToolResult(
                    tool_call_id="m2",
                    name="mutate_annotation",
                    result=json.dumps(
                        {"status": "completed", "proposal_pending": True},
                        ensure_ascii=False,
                    ),
                ),
            ],
        )

        assert [
            m.tool_call_id for m in run.turn.messages if isinstance(m, ToolMessage)
        ] == ["c1", "m2"]
        assert run.turn.completed_tool_ids == {"c1", "m2"}
        assert rec.total() == 0


# ── 常量 / 契约 ────────────────────────────────────────────────────────


def test_resume_module_public_surface():
    from app.agent.langchain_runtime import resume as resume_module

    for name in (
        "ResumeTurn",
        "answered_tool_call_ids",
        "build_resume_agent",
        "completed_tool_ids_from",
        "prepare_resume_messages",
        "prepare_resume_turn",
        "proposals_applied",
        "stream_resume_raw_events",
        "unanswered_client_tool_results",
        "with_completed_tool_ids",
    ):
        assert name in resume_module.__all__

    assert AgentContext().completed_tool_ids == frozenset()
    assert uuid.UUID(int=0)  # 保持 imports 稳定（无隐式网络/时间依赖）
