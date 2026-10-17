"""阶段 8 前置探针（第三批）：同一故障场景在**旧路径**与**候选路径**上的帧/计数/耗时。

用途（对应任务书 §B-3/§B-4/§B-5）：
  * 逐场景记录两侧的 SSE 帧序列、模型调用次数、工具真实执行次数；
  * 记录同一场景的**脚本化模型**墙钟耗时（并明确它**不是**迁移收益指标）。

旧路径驱动方式：真实 ``app.api.v1.agent._stream_local_chat``（含 ``done``），
只把模型工厂、工具集、MCP loader 换成脚本化/存根件。
候选路径驱动方式：真实 ``entry.stream_candidate_engine_sse``，同样的替换。

只观测，不设断言。运行：``PYTHONPATH=. python experiments/probe_stage8_faults3.py``
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from typing import Any

from langchain_core.tools import StructuredTool

from app.agent.langchain_runtime import entry
from app.api.v1 import agent as agent_module
from app.core.config import Settings
from app.schemas.agent import ClientContextInput, LocalChatStreamRequest

from probe_stage8_faults import (  # noqa: E402
    ScriptedChat,
    body,
    call_round,
    frames_of,
    make_tools,
    text_chunk,
)


# ── 旧路径脚本化模型（``stream_assist`` 需要 ``bind_tools`` + 裸 chunk 的 astream）


class Chunk:
    def __init__(self, content: str = "", tool_calls=None, tool_call_chunks=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.tool_call_chunks = tool_call_chunks or []
        self.additional_kwargs: dict[str, Any] = {}

    def __add__(self, other: "Chunk") -> "Chunk":
        return Chunk(
            content=(self.content or "") + (other.content or ""),
            tool_calls=list(self.tool_calls) + list(other.tool_calls),
            tool_call_chunks=list(self.tool_call_chunks)
            + list(other.tool_call_chunks),
        )


class OldScriptedChat:
    """旧路径的脚本化模型：按轮次 yield 裸 ``Chunk``；遇到异常对象则抛出。"""

    def __init__(self, rounds: list[list[Any]]) -> None:
        self._rounds = list(rounds)
        self.astream_calls = 0
        self.ainvoke_calls = 0
        self.bound_tool_names: list[str] = []
        self.seen_messages: list[list[Any]] = []

    def bind_tools(self, tools, tool_choice=None):
        self.bound_tool_names = [getattr(t, "name", str(t)) for t in tools]
        return self

    async def astream(self, messages):
        self.astream_calls += 1
        self.seen_messages.append(list(messages))
        items = self._rounds.pop(0) if self._rounds else []
        for item in items:
            if isinstance(item, BaseException):
                raise item
            yield item

    async def ainvoke(self, messages):
        self.ainvoke_calls += 1
        return Chunk(content="")


def old_round(calls: list[tuple[str, str, dict[str, Any]]]) -> list[Chunk]:
    """旧路径的「一轮工具调用」：每个调用一块 chunk。

    ``tool_calls`` 与 ``tool_call_chunks`` **同时**给出：前者是 ``ToolLoopRunner``
    的调用来源（旧路径靠 ``gathered.tool_calls``，不是 ``tool_call_chunks``），
    后者是 ``ProposalStreamInterceptor`` 的提案流式来源。
    """
    out: list[Chunk] = []
    for index, (call_id, name, args) in enumerate(calls):
        out.append(
            Chunk(
                tool_calls=[{"id": call_id, "name": name, "args": dict(args)}],
                tool_call_chunks=[
                    {
                        "name": name,
                        "args": json.dumps(args, ensure_ascii=False),
                        "id": call_id,
                        "index": index,
                    }
                ],
            )
        )
    return out


class CancelAfter:
    """第 n 次 ``is_cancelled()`` 调用起返回 True。两侧各持一个独立实例。"""

    def __init__(self, n: int) -> None:
        self.n = n
        self.calls = 0

    async def __call__(self) -> bool:
        self.calls += 1
        return self.calls >= self.n


async def run_old(
    *,
    rounds: list[list[Any]],
    specs: dict[str, dict[str, Any]],
    request: LocalChatStreamRequest,
    cancel_at: int | None = None,
    mcp_loader: Any = None,
) -> dict[str, Any]:
    tools, executions = make_tools(specs)
    model = OldScriptedChat(rounds)
    agent_module.ChatOpenAI = lambda **kwargs: model  # type: ignore[assignment]
    agent_module.build_tools_by_name_set = lambda *a, **k: list(tools)  # type: ignore[assignment]
    if mcp_loader is not None:
        agent_module.load_mcp_tools_from_servers = mcp_loader  # type: ignore[assignment]

    if cancel_at is None:
        from contextlib import nullcontext

        patch = nullcontext()
    else:
        from unittest import mock

        patch = mock.patch.object(
            agent_module, "_get_or_create_cancel_event", lambda job_id: _set_event()
            if cancel_at == 0 else _counter_event(cancel_at)
        )

    chunks: list[str] = []
    error: str | None = None
    started = time.perf_counter()
    try:
        with patch:
            async for chunk in agent_module._stream_local_chat(request, Settings()):
                chunks.append(chunk)
    except BaseException as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
    return {
        "frames": frames_of(chunks),
        "error": error,
        "model_calls": model.astream_calls,
        "executions": executions,
        "elapsed": round(time.perf_counter() - started, 3),
        "seen_messages": model.seen_messages,
    }


async def run_new(
    *,
    rounds: list[list[Any]],
    specs: dict[str, dict[str, Any]],
    request: LocalChatStreamRequest,
    cancel_at: int | None = None,
    mcp_loader: Any = None,
) -> dict[str, Any]:
    tools, executions = make_tools(specs)
    model = ScriptedChat(rounds=rounds)
    entry.ChatOpenAI = lambda **kwargs: model  # type: ignore[assignment]
    entry.build_local_tools = lambda b, s: list(tools)  # type: ignore[assignment]

    cancel = CancelAfter(cancel_at) if cancel_at is not None else None

    chunks: list[str] = []
    error: str | None = None
    started = time.perf_counter()
    try:
        async for chunk in entry.stream_candidate_engine_sse(
            request, Settings(agent_engine="candidate"), is_cancelled=cancel
        ):
            chunks.append(chunk)
    except BaseException as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
    return {
        "frames": frames_of(chunks),
        "error": error,
        "model_calls": model.invoke_calls,
        "executions": executions,
        "elapsed": round(time.perf_counter() - started, 3),
        "seen_messages": model.seen_messages,
    }


def _set_event():
    import asyncio as _a

    event = _a.Event()
    event.set()
    return event


def _counter_event(n: int):
    """旧路径的 ``is_cancelled`` 是「同一个 Event 的 is_set()」，无法按次数计数。

    旧路径没有「按帧计数取消」的注入点，故此分支只模拟「第 n 次模型 chunk
    检查时已取消」——用事件计时器近似：调用 n-1 次后置位。
    """
    import asyncio as _a

    event = _a.Event()
    state = {"calls": 0}

    class _Event(_a.Event):
        def is_set(self) -> bool:  # type: ignore[override]
            state["calls"] += 1
            if state["calls"] >= n:
                super().set()
            return super().is_set()

    return _Event()


def _returning_loader(tools):
    async def _loader(*a, **k):
        return list(tools)

    return _loader


def _raising_loader(msg: str = "MCP server unreachable"):
    async def _loader(*a, **k):
        raise ConnectionError(msg)

    return _loader


def _stub(name: str) -> StructuredTool:
    def _fn(**kwargs: Any) -> str:
        return json.dumps({"ok": True, "summary": f"{name} ok"}, ensure_ascii=False)

    return StructuredTool(
        name=name,
        description=f"{name} stub",
        func=_fn,
        args_schema={"type": "object", "properties": {}},
    )


READ = {"result": {"ok": True, "summary": "已读取 a.md"}}
ANNOTATE = {"result": {"ok": True, "summary": "不应在后端执行"}}
WRITE = {"result": {"ok": True, "summary": "已写入", "file_written": True}}
TEXT_OLD = "你好，我可以帮你整理工作区。"
PENDING_CTX = ClientContextInput(
    workspace_root="/tmp/ws",
    proposal_states=[{"path": "data/1.jpg", "kind": "annotation", "status": "pending"}],
)
VERIFY_CTX = ClientContextInput(
    workspace_root="/tmp/ws",
    proposal_states=[
        {"path": "data/1.jpg", "kind": "annotation", "status": "applied",
         "annotation_ids": ["ann-1"]}
    ],
)

MCP_URL = "http://127.0.0.1:9000"


def mcp_body(**kwargs: Any) -> LocalChatStreamRequest:
    request = body(**kwargs)
    assert request.client_context is not None
    request.client_context.mcp_server_url = MCP_URL
    return request


# (标题, 候选脚本, 旧脚本, 工具规格, 请求, cancel_at, mcp_loader)
SCENARIOS: list[tuple[Any, ...]] = [
    ("S0 纯文本轮（对照）", [[text_chunk(TEXT_OLD)]], [[Chunk(content=TEXT_OLD)]],
     {"read_workspace_file": READ}, body(user_content="你好"), None, None),
    ("S1 单只读工具轮",
     [call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [text_chunk("已读取。")]],
     [old_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [Chunk(content="已读取。")]],
     {"read_workspace_file": READ}, body(), None, None),
    ("S2 写类工具(delete)抛 RuntimeError",
     [call_round([("d1", "delete_workspace_file", {"relative_path": "a.md"})]), [text_chunk("删除失败。")]],
     [old_round([("d1", "delete_workspace_file", {"relative_path": "a.md"})]), [Chunk(content="删除失败。")]],
     {"delete_workspace_file": {"raises": RuntimeError("磁盘炸了")}}, body(), None, None),
    ("S3 写类工具(delete)抛 TimeoutError",
     [call_round([("d1", "delete_workspace_file", {"relative_path": "a.md"})]), [text_chunk("删除超时。")]],
     [old_round([("d1", "delete_workspace_file", {"relative_path": "a.md"})]), [Chunk(content="删除超时。")]],
     {"delete_workspace_file": {"raises": TimeoutError("tool timeout")}}, body(), None, None),
    ("S4 只读工具抛 TimeoutError（可重试）",
     [call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [text_chunk("读取超时。")]],
     [old_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [Chunk(content="读取超时。")]],
     {"read_workspace_file": {"raises": TimeoutError("read timeout")}}, body(), None, None),
    ("S5 只读工具抛 ConnectionError（可重试）",
     [call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [text_chunk("连接断开。")]],
     [old_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [Chunk(content="连接断开。")]],
     {"read_workspace_file": {"raises": ConnectionError("socket closed")}}, body(), None, None),
    ("S6 只读工具抛 RuntimeError",
     [call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [text_chunk("读取失败。")]],
     [old_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [Chunk(content="读取失败。")]],
     {"read_workspace_file": {"raises": RuntimeError("磁盘炸了")}}, body(), None, None),
    ("S7 写类工具(带 content)抛 RuntimeError → dismissed 卡",
     [call_round([("w1", "write_workspace_file", {"relative_path": "a.md", "content": "x"})]),
      [text_chunk("写入失败。")]],
     [old_round([("w1", "write_workspace_file", {"relative_path": "a.md", "content": "x"})]),
      [Chunk(content="写入失败。")]],
     {"write_workspace_file": {"raises": RuntimeError("磁盘炸了")}}, body(), None, None),
    ("S8 挂起调用（auto_annotate）",
     [call_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})])],
     [old_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})])],
     {"auto_annotate": ANNOTATE}, body(), None, None),
    ("S9 AWAIT_CONFIRM 拦截写类工具(delete)",
     [call_round([("d1", "delete_workspace_file", {"relative_path": "a.md"})]), [text_chunk("提案未确认。")]],
     [old_round([("d1", "delete_workspace_file", {"relative_path": "a.md"})]), [Chunk(content="提案未确认。")]],
     {"delete_workspace_file": {"result": {"ok": True, "summary": "不应执行"}}},
     body(client_context=PENDING_CTX), None, None),
    ("S10 AWAIT_CONFIRM 拦截写类工具(write+content)",
     [call_round([("w1", "write_workspace_file", {"relative_path": "a.md", "content": "x"})]),
      [text_chunk("提案未确认。")]],
     [old_round([("w1", "write_workspace_file", {"relative_path": "a.md", "content": "x"})]),
      [Chunk(content="提案未确认。")]],
     {"write_workspace_file": {"result": {"ok": True, "summary": "不应执行"}}},
     body(client_context=PENDING_CTX), None, None),
    ("S11 VERIFY 拦截重复 auto_annotate（paths）",
     [call_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})])],
     [old_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})])],
     {"auto_annotate": ANNOTATE}, body(client_context=VERIFY_CTX), None, None),
    ("S12 VERIFY 拦截 all_files=true",
     [call_round([("a1", "auto_annotate", {"all_files": True})])],
     [old_round([("a1", "auto_annotate", {"all_files": True})])],
     {"auto_annotate": ANNOTATE}, body(client_context=VERIFY_CTX), None, None),
    ("S13 非法参数：类型错误（int 给 string 槽）",
     [call_round([("i1", "read_workspace_file", {"relative_path": 123})]), [text_chunk("参数有误。")]],
     [old_round([("i1", "read_workspace_file", {"relative_path": 123})]), [Chunk(content="参数有误。")]],
     {"read_workspace_file": {"result": {"ok": True, "summary": "已读取 a.md"},
                              "properties": {"relative_path": {"type": "string"}}}},
     body(), None, None),
    ("S14 非法参数：缺必填",
     [call_round([("i2", "read_workspace_file", {})]), [text_chunk("缺少参数。")]],
     [old_round([("i2", "read_workspace_file", {})]), [Chunk(content="缺少参数。")]],
     {"read_workspace_file": {"result": {"ok": True, "summary": "已读取 a.md"},
                              "properties": {"relative_path": {"type": "string"}}}},
     body(), None, None),
    ("S15 MCP loader 抛 ConnectionError",
     [[text_chunk("本地工具就绪。")]], [[Chunk(content="本地工具就绪。")]],
     {"read_workspace_file": READ}, mcp_body(), None, _raising_loader()),
    ("S16 MCP loader 返回 []",
     [[text_chunk("本地工具就绪。")]], [[Chunk(content="本地工具就绪。")]],
     {"read_workspace_file": READ}, mcp_body(), None, _returning_loader([])),
    ("S17 MCP loader 返回 1 个工具（对照）",
     [[text_chunk("本地工具就绪。")]], [[Chunk(content="本地工具就绪。")]],
     {"read_workspace_file": READ}, mcp_body(), None,
     _returning_loader([_stub("mcp_echo")])),
    ("S18 取消：第一个检查点即取消",
     [call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [text_chunk("第二轮。")]],
     [old_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [Chunk(content="第二轮。")]],
     {"read_workspace_file": READ}, body(), 0, None),
    ("S19 取消：工具轮之后（候选 CancelAfter(4) / 旧事件第 4 次检查）",
     [call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [text_chunk("第二轮。")]],
     [old_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]), [Chunk(content="第二轮。")]],
     {"read_workspace_file": READ}, body(), 4, None),
    ("S20 resume：messages 已含结果 + 重复投递 ×2",
     [[text_chunk("已收到写入结果。")]], [[Chunk(content="已收到写入结果。")]],
     {"write_workspace_file": WRITE},
     body(messages=[
         {"role": "user", "content": "写一个文件"},
         {"role": "assistant", "content": "",
          "tool_calls": [{"id": "w1", "name": "write_workspace_file",
                          "args": {"relative_path": "a.md", "content": "x"}}]},
         {"role": "tool", "content": '{"ok": true}', "tool_call_id": "w1"},
     ], client_tool_results=[
         {"tool_call_id": "w1", "name": "write_workspace_file", "result": '{"ok": true}'},
         {"tool_call_id": "w1", "name": "write_workspace_file", "result": '{"ok": true}'},
     ]), None, None),
]

SUMMARY: list[tuple[str, str, str, str, str]] = []


async def main() -> None:
    for (title, rounds_new, rounds_old, specs, request, cancel_at, mcp_loader) in SCENARIOS:
        old = await run_old(rounds=rounds_old, specs=specs, request=request,
                            cancel_at=cancel_at, mcp_loader=mcp_loader)
        new = await run_new(rounds=rounds_new, specs=specs, request=request,
                            cancel_at=cancel_at, mcp_loader=mcp_loader)
        print("=" * 78)
        print(title)
        print("-" * 78)
        print(f"OLD  err={old['error']!r} model={old['model_calls']} exe={old['executions']} elapsed={old['elapsed']}")
        print("     types:", [f["type"] for f in old["frames"]],
              "done=", any(f["type"] == "done" for f in old["frames"]))
        print(f"NEW  err={new['error']!r} model={new['model_calls']} exe={new['executions']} elapsed={new['elapsed']}")
        print("     types:", [f["type"] for f in new["frames"]],
              "done=", any(f["type"] == "done" for f in new["frames"]))
        same = old["frames"] == new["frames"]
        print("  ->", "帧序列相同" if same else "帧序列不同")
        if not same:
            for label, res in (("OLD", old), ("NEW", new)):
                for frame in res["frames"]:
                    print(f"     {label}", json.dumps(frame, ensure_ascii=False))
        SUMMARY.append((
            title,
            f"{old['model_calls']}/{new['model_calls']}",
            f"{sum(len(v) for v in old['executions'].values())}/{sum(len(v) for v in new['executions'].values())}",
            f"{old['elapsed']}/{new['elapsed']}",
            "same" if same else "diff",
        ))

    print("=" * 78)
    print("汇总  model(OLD/NEW) | tool-exec(OLD/NEW) | elapsed(OLD/NEW) | frames")
    for row in SUMMARY:
        print("   " + " | ".join(row))

    await benchmark()
    print("探针 3 结束")


BENCH_N = 20


async def benchmark() -> None:
    """同一场景（S1 单只读工具轮）在两侧各跑 20 次，取 min/median。

    ⚠️ 只测**脚本化模型**的墙钟耗时：无真实 provider、无网络、无磁盘 I/O。
    它衡量的是「每轮编排 + 事件适配」的固定开销，**不是迁移收益/损失指标**。
    """
    specs = {"read_workspace_file": READ}
    rounds_new = [
        call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
        [text_chunk("已读取。")],
    ]
    rounds_old = [
        old_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
        [Chunk(content="已读取。")],
    ]

    # 预热：导入 + 图编译 + 首次 jit 都只付一次
    for _ in range(3):
        await run_old(rounds=[list(r) for r in rounds_old], specs=specs, request=body())
        await run_new(rounds=[list(r) for r in rounds_new], specs=specs, request=body())

    def _stats(values: list[float]) -> str:
        ordered = sorted(values)
        mid = ordered[len(ordered) // 2]
        return f"min={min(values):.4f}s median={mid:.4f}s mean={sum(values)/len(values):.4f}s"

    old_times: list[float] = []
    new_times: list[float] = []
    for _ in range(BENCH_N):
        started = time.perf_counter()
        await run_old(rounds=[list(r) for r in rounds_old], specs=specs, request=body())
        old_times.append(time.perf_counter() - started)
        started = time.perf_counter()
        await run_new(rounds=[list(r) for r in rounds_new], specs=specs, request=body())
        new_times.append(time.perf_counter() - started)

    print("=" * 78)
    print(f"BENCH S1 单只读工具轮 × {BENCH_N}（脚本化模型；非迁移收益指标）")
    print("   OLD", _stats(old_times))
    print("   NEW", _stats(new_times))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
