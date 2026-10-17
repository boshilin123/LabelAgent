"""阶段 5 探针 1（一次性、throwaway）：工具内 ``runtime: ToolRuntime`` + ``runtime.stream_writer``。

回答阶段 5 备忘 §2 的 inferred 风险 1/2（``docs/阶段5-MCP与子代理与视觉设计备忘.md:44,82``）：

Q1  工具函数声明 ``runtime: ToolRuntime`` 形参、在 ``stream_mode=["messages","updates","custom"]``
    下调用 ``runtime.stream_writer(payload)`` 是否成功？注入的 ``stream_writer`` 是否存在？
     ``stream_mode`` **不含** ``"custom"`` 时它是不是 no-op（不抛错、无分片）？
Q2  分片的**精确形状**（字段名 / ``ns`` 是否标识工具作用域），以及它与同一轮
    ``messages`` delta、``updates`` 事件的**相对到达顺序**。
Q3  payload 是否原样存活（dict + 嵌套 list / None / bool / 中文 / 数字 / 元组）？
Q4  ``create_agent(context_schema=...)`` + ``ToolRuntime`` 形参能否与
    ``middleware=build_business_middleware(...)``（阶段 2 栈）共存？
Q5  （备忘未列，附送）工具在 ``asyncio.to_thread`` 里写自定义帧是否安全
    ——视觉兜底计划用 ``asyncio.to_thread``（``assist_vision.py:78-82``）。

运行（工作目录 ``LR-Agent\\vendor\\local-agent``）：
    ..\\..\\..\\.venvs\\langchain-migration\\Scripts\\python.exe experiments\\probe_stage5_stream_writer.py
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain.agents import create_agent
from langchain.tools import ToolRuntime, tool
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langgraph.config import _no_op_stream_writer
from pydantic import BaseModel, ConfigDict, Field

from app.agent.langchain_runtime.middleware import build_business_middleware
from app.agent.langchain_runtime.runtime import AgentContext


# ── 观测通道（工具内部无法直接写进 updates，用模块级 list 侧录）─────────────
OBSERVATIONS: list[dict[str, Any]] = []

RICH_PAYLOAD: dict[str, Any] = {
    "kind": "subagent_text_delta",
    "text": "中文 payload ✓",
    "nested": [1, 2, [3, [4, {"deep": None}]], True, False],
    "none": None,
    "float": 1.5,
    "unicode_key_中文": {"a": [1, 2, 3]},
}


@tool
def probe_emit(marker: str, runtime: ToolRuntime) -> str:
    """向 custom 流写两帧。"""
    writer = runtime.stream_writer
    conf = (runtime.config or {}).get("configurable", {})
    OBSERVATIONS.append(
        {
            "marker": marker,
            "writer_repr": repr(writer),
            "writer_type": type(writer).__name__,
            "writer_qualname": getattr(writer, "__qualname__", None),
            "writer_is_module_no_op": writer is _no_op_stream_writer,
            "has_context": runtime.context is not None,
            "context_type": type(runtime.context).__name__,
            "state_keys": sorted(runtime.state.keys())
            if isinstance(runtime.state, dict)
            else "<not-dict>",
            "tool_call_id": runtime.tool_call_id,
            "config_has_pregel_stream": "__pregel_stream" in conf,
            "config_pregel_stream_type": type(conf.get("__pregel_stream")).__name__,
            "config_stream_mode": conf.get("__pregel_stream_mode", "<absent>"),
        }
    )
    writer({"marker": marker, "seq": 1, "payload": RICH_PAYLOAD})
    writer({"marker": marker, "seq": 2, "flat": "second frame"})
    return json.dumps({"ok": True, "marker": marker}, ensure_ascii=False)


@tool
async def probe_emit_threaded(marker: str, runtime: ToolRuntime) -> str:
    """在 ``asyncio.to_thread`` 里写自定义帧（视觉兜底的实际形态）。"""
    writer = runtime.stream_writer

    def _work() -> None:
        writer({"marker": marker, "thread": True})

    try:
        await asyncio.to_thread(_work)
        OBSERVATIONS.append({"marker": marker, "threaded_ok": True})
    except BaseException as exc:  # noqa: BLE001
        OBSERVATIONS.append(
            {"marker": marker, "threaded_ok": False, "threaded_err": repr(exc)}
        )
    return json.dumps({"ok": True, "marker": marker}, ensure_ascii=False)


class ScriptedChat(BaseChatModel):
    """按轮次脚本吐 tool_calls 的假模型（无网络）。"""

    rounds: list[list[AIMessageChunk]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)

    @property
    def _llm_type(self) -> str:
        return "probe-stage5-scripted-chat"

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        return self

    def _round(self) -> list[AIMessageChunk]:
        i = int(self.counters.get("calls", 0))
        self.counters["calls"] = i + 1
        return self.rounds[i] if i < len(self.rounds) else []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        chunks = self._round()
        merged: AIMessageChunk | None = None
        for c in chunks:
            merged = c if merged is None else merged + c
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
        return self._generate(messages)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.counters["stream_calls"] = int(self.counters.get("stream_calls", 0)) + 1
        for chunk in self._round():
            yield ChatGenerationChunk(message=chunk)


def tc(name: str, args: dict, call_id: str) -> AIMessageChunk:
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


class ProbeContext(BaseModel):
    """测试用 context_schema（与 :class:`AgentContext` 同形的最小版）。"""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    mode: str = "assist"


def describe_event(idx: int, event: Any) -> str:
    if not isinstance(event, dict):
        return f"{idx:>3}  <raw tuple> {event!r}"
    etype = event.get("type")
    ns = event.get("ns")
    data = event.get("data")
    if etype == "messages" and isinstance(data, tuple) and data:
        msg = data[0]
        meta = data[1] if len(data) > 1 else {}
        node = meta.get("langgraph_node") if isinstance(meta, dict) else None
        ckns = meta.get("checkpoint_ns") if isinstance(meta, dict) else None
        body = getattr(msg, "content", "")
        tcs = getattr(msg, "tool_call_chunks", None) or []
        tcs_full = getattr(msg, "tool_calls", None) or []
        return (
            f"{idx:>3}  messages  ns={ns} node={node} ckns={ckns!r} "
            f"cls={type(msg).__name__} content={body!r} "
            f"tc_chunks={len(tcs)} tc={tcs_full}"
        )
    if etype == "custom":
        return f"{idx:>3}  custom    ns={ns} data={data!r}"
    if etype == "updates":
        keys = sorted(data) if isinstance(data, dict) else data
        return f"{idx:>3}  updates   ns={ns} nodes={keys} data={data!r}"
    return f"{idx:>3}  {etype}  ns={ns} data={data!r}"


async def drive(
    *,
    title: str,
    rounds: list[list[AIMessageChunk]],
    tools: list[Any],
    stream_modes: list[str],
    middleware: list[Any] = (),
    context_schema: type[BaseModel] = ProbeContext,
    context: Any = None,
    verbose: bool = True,
) -> dict[str, Any]:
    global OBSERVATIONS
    OBSERVATIONS = []
    model = ScriptedChat(rounds=rounds)
    agent = create_agent(
        model,
        list(tools),
        context_schema=context_schema,
        middleware=list(middleware),
        name="probe_stage5",
    )
    print(f"\n{'=' * 100}\n### {title}\n  stream_mode={stream_modes} middleware={[type(m).__name__ for m in middleware]}")
    error: str | None = None
    raw: list[Any] = []
    try:
        async for ev in agent.astream(
            {"messages": [AIMessage(content="go")]},
            context=context if context is not None else context_schema(),
            stream_mode=stream_modes,
            version="v2",
        ):
            raw.append(ev)
    except BaseException as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"

    if verbose:
        for i, ev in enumerate(raw):
            print(describe_event(i, ev))

    customs = [e for e in raw if isinstance(e, dict) and e.get("type") == "custom"]
    updates = [e["data"] for e in raw if isinstance(e, dict) and e.get("type") == "updates"]
    model_calls = model.counters.get("calls")
    print(f"  --- error={error!r} model_calls={model_calls} "
          f"custom_frames={len(customs)} update_nodes={[sorted(d) for d in updates]}")
    print(f"  --- OBSERVATIONS={json.dumps(OBSERVATIONS, ensure_ascii=False)}")
    return {
        "title": title,
        "error": error,
        "customs": customs,
        "updates": updates,
        "observations": list(OBSERVATIONS),
        "raw": raw,
        "model_calls": model_calls,
        "agent": agent,
    }


async def main() -> int:
    # ── A：三模式齐全（Q1 前半 / Q2 / Q3）────────────────────────────
    a = await drive(
        title="A  正式路径：messages+updates+custom，工具声明 ToolRuntime 并写帧",
        rounds=[[tc("probe_emit", {"marker": "A"}, "cA1")], [AIMessageChunk(content="done")]],
        tools=[probe_emit],
        stream_modes=["messages", "updates", "custom"],
    )

    # ── B：custom 缺席（Q1 后半：是否为 no-op）───────────────────────
    b = await drive(
        title="B  对照组：stream_mode 不含 custom（writer 应为 no-op，不抛错）",
        rounds=[[tc("probe_emit", {"marker": "B"}, "cB1")], [AIMessageChunk(content="done")]],
        tools=[probe_emit],
        stream_modes=["messages", "updates"],
    )

    # ── C：to_thread 里写帧（Q5）─────────────────────────────────────
    c = await drive(
        title="C  工具在 asyncio.to_thread 里写帧（视觉兜底的形态）",
        rounds=[
            [tc("probe_emit_threaded", {"marker": "C"}, "cC1")],
            [AIMessageChunk(content="done")],
        ],
        tools=[probe_emit_threaded],
        stream_modes=["messages", "updates", "custom"],
    )

    # ── D：context_schema=AgentContext + 真实阶段 2 middleware 栈（Q4）──
    mw = build_business_middleware(max_tool_rounds=3)
    d = await drive(
        title="D  真实阶段 2 栈 build_business_middleware + AgentContext + ToolRuntime",
        rounds=[[tc("probe_emit", {"marker": "D"}, "cD1")], [AIMessageChunk(content="done")]],
        tools=[probe_emit],
        stream_modes=["messages", "updates", "custom"],
        middleware=mw,
        context_schema=AgentContext,
        context=AgentContext(),
    )

    print(f"\n{'=' * 100}\n### VERDICT")
    print(f"  Q1a ToolRuntime 注入存在且可写帧 (A)      : "
          f"{a['error'] is None and len(a['customs']) == 2 and a['observations'][0]['writer_is_module_no_op'] is False}")
    print(f"  Q1b custom 缺席：无异常、零 custom 帧 (B) : "
          f"{b['error'] is None and len(b['customs']) == 0}")
    print(f"      B writer 身份 = {b['observations'][0]['writer_repr']} "
          f"is_module_no_op={b['observations'][0]['writer_is_module_no_op']} "
          f"config_has_pregel_stream={b['observations'][0]['config_has_pregel_stream']} "
          f"pregel_stream_type={b['observations'][0]['config_pregel_stream_type']}")
    print(f"      A config_has_pregel_stream={a['observations'][0]['config_has_pregel_stream']}")
    print(f"  Q2  custom 形状字段 = {sorted(a['customs'][0]) if a['customs'] else '<none>'}")
    print(f"      ns(A) = {a['customs'][0]['ns'] if a['customs'] else '<none>'}")
    print(f"  Q3  payload 原样（嵌套结构逐字节相等）    : "
          f"{a['customs'][0]['data']['payload'] == RICH_PAYLOAD if a['customs'] else False}")
    print(f"  Q4  与 build_business_middleware 共存     : "
          f"{d['error'] is None and len(d['customs']) == 2 and d['model_calls'] == 2}")
    print(f"  Q5  to_thread 内写帧                      : "
          f"{c['error'] is None and len(c['customs']) == 1 and c['observations'][0].get('threaded_ok')}")
    for name, res in (("A", a), ("B", b), ("C", c), ("D", d)):
        print(f"  [{name}] obs={json.dumps(res['observations'], ensure_ascii=False)}")

    print("\n  --- 顺序明细（A：messages / updates / custom 相对位置）---")
    for i, ev in enumerate(a["raw"]):
        print("   ", describe_event(i, ev))
    print("\n  --- 顺序明细（D：挂了阶段 2 栈）---")
    for i, ev in enumerate(d["raw"]):
        print("   ", describe_event(i, ev))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
