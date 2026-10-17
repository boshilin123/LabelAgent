"""阶段 8 前置探针（第二批）：MCP 断开 / 重复结果 / 取消竞态 / 脏参数 / 写类工具干净帧序。

只观测，不设断言。运行方式见 ``probe_stage8_faults.py`` 顶部说明。
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from typing import Any

from langchain_core.messages import AIMessageChunk
from langchain_core.tools import StructuredTool

from app.agent.langchain_runtime import entry
from app.api.v1 import agent as agent_module
from app.core.config import Settings
from app.schemas.agent import ClientContextInput, LocalChatStreamRequest

from probe_stage8_faults import (  # noqa: E402 - 复用同一批脚本化素材
    ScriptedChat,
    body,
    call_round,
    frames_of,
    make_tools,
    show,
    text_chunk,
)


class CancelAfter:
    """第 n 次 ``is_cancelled()`` 调用起返回 True（与阶段 0 基线同款）。"""

    def __init__(self, n: int) -> None:
        self.n = n
        self.calls = 0

    async def __call__(self) -> bool:
        self.calls += 1
        return self.calls >= self.n


async def run(
    *,
    rounds: list[list[Any]],
    specs: dict[str, dict[str, Any]],
    request: LocalChatStreamRequest,
    is_cancelled: Any = None,
    mcp_loader: Any = None,
    mcp_url: str | None = None,
) -> dict[str, Any]:
    tools, executions = make_tools(specs)
    model = ScriptedChat(rounds=rounds)
    entry.ChatOpenAI = lambda **kwargs: model  # type: ignore[assignment]
    entry.build_local_tools = lambda b, s: list(tools)  # type: ignore[assignment]
    if mcp_url is not None and request.client_context is not None:
        request.client_context.mcp_server_url = mcp_url
    if mcp_loader is not None:
        agent_module.load_mcp_tools_from_servers = mcp_loader  # type: ignore[assignment]
        import app.agent.tools.mcp_client as _mcp

        _mcp.load_mcp_tools_from_servers = mcp_loader  # type: ignore[assignment]

    chunks: list[str] = []
    error: str | None = None
    started = time.perf_counter()
    try:
        async for chunk in entry.stream_candidate_engine_sse(
            request, Settings(agent_engine="candidate"), is_cancelled=is_cancelled
        ):
            chunks.append(chunk)
    except BaseException as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
    return {
        "frames": frames_of(chunks),
        "error": error,
        "model_calls": model.invoke_calls,
        "executions": executions,
        "seen_messages": model.seen_messages,
        "elapsed": round(time.perf_counter() - started, 3),
    }


def _stub(name: str) -> StructuredTool:
    def _fn(**kwargs: Any) -> str:
        return json.dumps({"ok": True, "summary": f"{name} ok"}, ensure_ascii=False)

    return StructuredTool(
        name=name,
        description=f"{name} stub",
        func=_fn,
        args_schema={"type": "object", "properties": {}},
    )


async def main() -> None:
    # ── 3. MCP 断开：loader 抛异常 / 返回 [] ────────────────────────────
    async def _raising_loader(*a, **k):
        raise ConnectionError("MCP server unreachable")

    async def _empty_loader(*a, **k):
        return []

    async def _returning_loader(*a, **k):
        return [_stub("mcp_echo")]

    for label, loader in (
        ("3a MCP loader 抛 ConnectionError", _raising_loader),
        ("3b MCP loader 返回 []", _empty_loader),
        ("3c MCP loader 正常返回 1 个工具（对照）", _returning_loader),
    ):
        show(
            label,
            await run(
                rounds=[[text_chunk("本地工具就绪。")]],
                specs={"read_workspace_file": {"result": {"ok": True, "summary": "ok"}}},
                request=body(),
                mcp_loader=loader,
                mcp_url="http://127.0.0.1:9000",
            ),
        )

    # ── 4. 重复工具结果（resume）────────────────────────────────────────
    dup_result = {
        "tool_call_id": "w1",
        "name": "write_workspace_file",
        "result": json.dumps(
            {"ok": True, "status": "completed", "file_written": True}, ensure_ascii=False
        ),
    }
    resume_messages = [
        {"role": "user", "content": "写一个文件"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "w1",
                    "name": "write_workspace_file",
                    "args": {"relative_path": "a.md", "content": "x"},
                }
            ],
        },
        {"role": "tool", "content": dup_result["result"], "tool_call_id": "w1"},
    ]

    show(
        "4a resume：messages 已含 ToolMessage + 重复投递同一结果 ×2（幂等）",
        await run(
            rounds=[[text_chunk("已收到写入结果。")]],
            specs={"write_workspace_file": {"result": {"ok": True, "summary": "已写入"}}},
            request=body(messages=resume_messages, client_tool_results=[dup_result, dup_result]),
        ),
    )

    no_tool_msg_messages = resume_messages[:2]
    show(
        "4b resume：messages 未含 ToolMessage + 重复投递同一结果 ×2",
        await run(
            rounds=[[text_chunk("已收到写入结果。")]],
            specs={"write_workspace_file": {"result": {"ok": True, "summary": "已写入"}}},
            request=body(
                messages=no_tool_msg_messages, client_tool_results=[dup_result, dup_result]
            ),
        ),
    )

    show(
        "4c resume：模型复读同一 tool_call_id（already_completed，零执行）",
        await run(
            rounds=[call_round([("w1", "write_workspace_file", {"relative_path": "a.md", "content": "x"})])],
            specs={"write_workspace_file": {"result": {"ok": True, "summary": "已写入"}}},
            request=body(messages=resume_messages, client_tool_results=[dup_result]),
        ),
    )

    # ── 5. 取消竞态 ────────────────────────────────────────────────────
    read_specs = {"read_workspace_file": {"result": {"ok": True, "summary": "已读取 a.md"}}}
    tool_then_text = [
        call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
        [text_chunk("第二轮回答。")],
    ]
    deferred_rounds = [
        call_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})]),
    ]

    for n in (1, 2, 3, 4, 5):
        show(
            f"5a 取消：CancelAfter({n})，round1 工具 → round2 文本",
            await run(
                rounds=tool_then_text,
                specs=read_specs,
                request=body(),
                is_cancelled=CancelAfter(n),
            ),
        )

    for n in (1, 2, 3, 4):
        show(
            f"5b 取消：CancelAfter({n})，round1 只有挂起调用（auto_annotate）",
            await run(
                rounds=deferred_rounds,
                specs={"auto_annotate": {"result": {"ok": True, "summary": "不应在后端执行"}}},
                request=body(),
                is_cancelled=CancelAfter(n),
            ),
        )

    # ── 6. 脏参数：JSON 截断 ───────────────────────────────────────────
    def broken_round(call_id: str, name: str, raw_args: str) -> list[AIMessageChunk]:
        return [
            AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": name,
                        "args": raw_args,
                        "id": call_id,
                        "index": 0,
                        "type": "tool_call_chunk",
                    }
                ],
            )
        ]

    show(
        "6c 脏参数：tool_call args 为截断 JSON",
        await run(
            rounds=[
                broken_round("b1", "read_workspace_file", '{"relative_path": '),
                [text_chunk("参数解析失败。")],
            ],
            specs={
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 a.md"},
                    "properties": {"relative_path": {"type": "string"}},
                }
            },
            request=body(),
        ),
    )

    show(
        "6d 脏参数：完全不是 JSON",
        await run(
            rounds=[
                broken_round("b2", "read_workspace_file", "not json at all"),
                [text_chunk("参数解析失败。")],
            ],
            specs={
                "read_workspace_file": {
                    "result": {"ok": True, "summary": "已读取 a.md"},
                    "properties": {"relative_path": {"type": "string"}},
                }
            },
            request=body(),
        ),
    )

    # ── 2e. 写类工具（delete_workspace_file）抛异常：干净帧序 ──────────
    show(
        "2e delete_workspace_file 抛 RuntimeError（干净帧序）",
        await run(
            rounds=[
                call_round([("d1", "delete_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("删除失败。")],
            ],
            specs={"delete_workspace_file": {"raises": RuntimeError("磁盘炸了")}},
            request=body(),
        ),
    )
    show(
        "2f delete_workspace_file 抛 TimeoutError（写类不得重试）",
        await run(
            rounds=[
                call_round([("d1", "delete_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("删除超时。")],
            ],
            specs={"delete_workspace_file": {"raises": TimeoutError("tool timeout")}},
            request=body(),
        ),
    )

    print("=" * 78)
    print("探针 2 结束")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
