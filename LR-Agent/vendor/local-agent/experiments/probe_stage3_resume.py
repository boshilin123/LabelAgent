"""阶段 3 只读探针：resume 回合的图行为（离线、确定性、无网络）。

跑法（工作目录 ``LR-Agent/vendor/local-agent``）::

    ..\\..\\..\\.venvs\\langchain-migration\\Scripts\\python.exe -m experiments.probe_stage3_resume

它回答四个问题（阶段 3 实施前必须实测，不能假设）：

1. resume 请求（输入 messages 里已有 ``AIMessage(tool_calls=[c1])`` + 回传结果）
   能否让模型看到补齐后的 ``ToolMessage``；
2. 阶段 2 的 ``BusinessRoundMiddleware`` 是否从 ``runtime.context`` 读到
   **本请求播种**的 ``completed_tool_ids``（跨请求 ``already_completed``）；
3. ``updates`` 流里 ``*.after_model`` 节点是否携带 ``round_plan``（阶段 4 要不要另发帧）；
4. 混合同轮 ``[SYNC, ASYNC]`` 在关闭早停后 SYNC 恰好执行 1 次、ASYNC 零执行。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field, create_model

from app.agent.assist.task_phase import derive_task_phase
from app.agent.langchain_runtime import AgentContext
from app.agent.langchain_runtime.resume import (
    build_resume_agent,
    prepare_resume_turn,
    stream_resume_raw_events,
)
from app.schemas.agent import ClientToolResult, ProposalStateInput

_JSON_TYPE_TO_PY: dict[str, Any] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
}


class ScriptedChat(BaseChatModel):
    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)
    seen_messages: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "probe-stage3"

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

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
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


def make_tools(specs: dict[str, dict[str, Any]]):
    calls: dict[str, list[dict[str, Any]]] = {}
    tools: list[StructuredTool] = []
    for name, spec in specs.items():
        props = spec.get("properties") or {}
        schema = create_model(
            f"{name}_args",
            **{
                prop: (_JSON_TYPE_TO_PY.get(cfg.get("type", "string"), Any), ...)
                for prop, cfg in props.items()
            },
        )

        def _build(tool_name=name):
            def _impl(**kwargs: Any) -> str:
                calls.setdefault(tool_name, []).append(dict(kwargs))
                return json.dumps(
                    {"ok": True, "tool": tool_name, "status": "ok", "summary": "ok"},
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
    return tools, calls


async def run_resume(
    model: ScriptedChat,
    tools,
    messages,
    ctrs,
    *,
    phase_ctx=None,
    max_tool_rounds: int = 5,
):
    agent = build_resume_agent(model, tools, max_tool_rounds=max_tool_rounds)
    turn = prepare_resume_turn(
        messages, ctrs, context=AgentContext(mode="annotation"), phase_ctx=phase_ctx
    )
    events = [e async for e in stream_resume_raw_events(agent, turn)]
    return turn, events


def dump(label: str, turn, events, model, calls) -> None:
    nodes: list[str] = []
    tool_msgs: list[tuple[str, str, str]] = []
    plans: list[str] = []
    for event in events:
        if not (isinstance(event, dict) and event.get("type") == "updates"):
            continue
        for node, update in event["data"].items():
            nodes.append(node)
            if not isinstance(update, dict):
                continue
            if "round_plan" in update:
                plan = update["round_plan"]
                plans.append(
                    f"{node}: deferred={[c.tool_call_id for c in plan.deferred]} "
                    f"execute_now={[c.tool_call_id for c in plan.execute_now]} "
                    f"suppressed={[(c.tool_call_id, json.loads(c.result_json)['status']) for c in plan.suppressed]}"
                )
            for message in update.get("messages", []) or []:
                if isinstance(message, ToolMessage):
                    tool_msgs.append(
                        (node, message.tool_call_id, (message.content or "")[:60])
                    )
    print(f"\n=== {label} ===")
    print("nodes            =", nodes)
    print("model_calls      =", model.invoke_calls)
    print("executions       =", {k: len(v) for k, v in calls.items()} or "{}")
    print("round_plan(updates) =", plans or "-")
    print("ToolMessages     =")
    for node, cid, head in tool_msgs:
        print(f"   [{node}] {cid} :: {head}")
    print("input messages   =", [type(m).__name__ for m in turn.messages])
    print("context.completed_tool_ids =", sorted(turn.context.completed_tool_ids))
    seen = model.seen_messages[-1] if model.seen_messages else []
    print("model saw        =", [type(m).__name__ for m in seen])
    for m in seen:
        if isinstance(m, ToolMessage):
            print(f"   saw tool {m.tool_call_id} :: {(m.content or '')[:70]}")


async def main() -> None:
    # Q1/Q2/Q4：混合同轮 + 跨请求 already_completed
    tools, calls = make_tools(
        {
            "read_workspace_file": {"properties": {"relative_path": {"type": "string"}}},
            "auto_annotate": {"properties": {"paths": {"type": "array"}}},
        }
    )
    result = ClientToolResult(
        tool_call_id="c1",
        name="auto_annotate",
        result=json.dumps(
            {"status": "completed", "proposal_pending": True, "file_written": False},
            ensure_ascii=False,
        ),
    )
    model = ScriptedChat(
        rounds=[
            # 第 1 次模型调用：复读上一轮已挂起的 c1（跨请求 already_completed）
            [tool_call_chunk("auto_annotate", {"paths": ["data/1.jpg"]}, "c1")],
            # 第 2 次：混合同轮 [SYNC, ASYNC]
            [
                tool_call_chunk("read_workspace_file", {"relative_path": "a.md"}, "r1"),
                tool_call_chunk("auto_annotate", {"paths": ["data/2.jpg"]}, "a2"),
            ],
            # 第 3 次：最终回答
            [AIMessageChunk(content="好的。")],
        ]
    )
    messages = [
        HumanMessage(content="标注 data/1.jpg"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "c1", "name": "auto_annotate", "args": {"paths": ["data/1.jpg"]}}
            ],
        ),
    ]
    turn, events = await run_resume(model, tools, messages, [result])
    dump("resume: repeat c1 + mixed [SYNC,ASYNC]", turn, events, model, calls)

    # Q3：VERIFY 阶段 + 重复投递幂等
    states = [
        ProposalStateInput(path="data/1.jpg", kind="annotation", status="applied")
    ]
    ctx = derive_task_phase(states)
    tools2, calls2 = make_tools(
        {
            "auto_annotate": {"properties": {"paths": {"type": "array"}}},
            "read_workspace_file": {"properties": {"relative_path": {"type": "string"}}},
        }
    )
    model2 = ScriptedChat(rounds=[[AIMessageChunk(content="已核对落盘结果。")]])
    # 第二次投递：输入消息里已经有 ToolMessage(c1)
    messages2 = [
        HumanMessage(content="标注 data/1.jpg"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "c1", "name": "auto_annotate", "args": {"paths": ["data/1.jpg"]}}
            ],
        ),
        ToolMessage(content=result.result, tool_call_id="c1"),
    ]
    turn2, events2 = await run_resume(
        model2, tools2, messages2, [result], phase_ctx=ctx
    )
    dump("repeat delivery (VERIFY)", turn2, events2, model2, calls2)

    # Q5：纯 ASYNC 轮在 resume 驱动下不再早停（after_model 计划必须可见）
    tools3, calls3 = make_tools(
        {"auto_annotate": {"properties": {"paths": {"type": "array"}}}}
    )
    model3 = ScriptedChat(
        rounds=[
            [tool_call_chunk("auto_annotate", {"paths": ["data/9.jpg"]}, "n1")],
        ]
    )
    turn3, events3 = await run_resume(
        model3, tools3, [HumanMessage(content="标注 data/9.jpg")], []
    )
    dump("pure ASYNC round (no early stop)", turn3, events3, model3, calls3)

    # Q6：AWAIT_CONFIRM 门禁在 resume 回合的执行层生效（写工具零执行）
    tools4, calls4 = make_tools(
        {
            "write_workspace_file": {
                "properties": {
                    "relative_path": {"type": "string"},
                    "content": {"type": "string"},
                }
            },
            "auto_annotate": {"properties": {"paths": {"type": "array"}}},
        }
    )
    states4 = [
        ProposalStateInput(path="data/2.jpg", kind="annotation", status="pending")
    ]
    ctx4 = derive_task_phase(states4)
    model4 = ScriptedChat(
        rounds=[
            [
                tool_call_chunk(
                    "write_workspace_file",
                    {"relative_path": "reports/r.md", "content": "# 报告"},
                    "w1",
                )
            ],
            [AIMessageChunk(content="提案未确认，请 Keep All 后我再生成报告。")],
        ]
    )
    turn4, events4 = await run_resume(
        model4,
        tools4,
        [HumanMessage(content="补标并写报告")],
        [result],
        phase_ctx=ctx4,
    )
    dump("AWAIT_CONFIRM gate on resume", turn4, events4, model4, calls4)

    # Q7：VERIFY 谎报防护（首次投递：messages 里没有 c1 的 ToolMessage）
    tools5, calls5 = make_tools({})
    model5 = ScriptedChat(rounds=[[AIMessageChunk(content="已核对落盘结果。")]])
    turn5, events5 = await run_resume(
        model5,
        tools5,
        [
            HumanMessage(content="标注 data/1.jpg"),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "c1",
                        "name": "auto_annotate",
                        "args": {"paths": ["data/1.jpg"]},
                    }
                ],
            ),
        ],
        [result],
        phase_ctx=ctx,
    )
    dump("VERIFY honesty guard (first delivery)", turn5, events5, model5, calls5)
    for m in turn5.messages:
        if isinstance(m, ToolMessage):
            print("   rewritten payload =", m.content)

    # Q8：旧函数在「输入已含该 ToolMessage」时的行为（用于记录候选侧幂等守卫的差异）
    from langchain_core.messages import HumanMessage as _HM

    from app.agent.context_service import append_client_tool_results_to_messages

    legacy = [
        _HM(content="标注 data/1.jpg"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "c1", "name": "auto_annotate", "args": {"paths": ["data/1.jpg"]}}
            ],
        ),
        ToolMessage(content=result.result, tool_call_id="c1"),
    ]
    out = append_client_tool_results_to_messages(
        legacy, [result], user_content="标注 data/1.jpg", proposals_applied=True
    )
    print("\n=== OLD append_* with already-answered id ===")
    print("len(messages) =", len(out), [type(m).__name__ for m in out])
    print("tool ids      =", [m.tool_call_id for m in out if isinstance(m, ToolMessage)])
    print("ai tool_ids   =", [
        [tc["id"] for tc in m.tool_calls] for m in out if isinstance(m, AIMessage)
    ])


if __name__ == "__main__":
    asyncio.run(main())
