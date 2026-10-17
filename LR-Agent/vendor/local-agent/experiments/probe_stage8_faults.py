"""阶段 8 前置探针：把七类故障的真实可观测行为打出来（**只观测，不设断言**）。

用途：在写 ``tests/test_langchain_runtime_stage8_faults.py`` 之前，先钉住
「候选路径在每类故障下究竟产出什么」——帧序列、``done`` 有无、``error`` 有无、
模型/工具的真实调用次数、以及框架的原文错误文本。禁止凭猜测写断言。

运行（工作目录 = ``LR-Agent/vendor/local-agent``）::

    ..\\..\\..\\.venvs\\langchain-migration\\Scripts\\python.exe experiments\\probe_stage8_faults.py

全部离线：脚本化模型、结构化存根工具、假 MCP loader；无网络、无真实模型、无写盘。
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import traceback
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import StructuredTool
from pydantic import Field

from app.agent.assist.task_phase import derive_task_phase
from app.agent.langchain_runtime import entry
from app.core.config import Settings
from app.schemas.agent import (
    ClientContextInput,
    ClientToolResult,
    LocalChatStreamRequest,
    ProposalStateInput,
)


# ── 脚本化模型 ─────────────────────────────────────────────────────────


class ScriptedChat(BaseChatModel):
    """按轮次返回预设项；列表项为 ``AIMessageChunk`` 或 ``Exception``（该处抛出）。"""

    rounds: list[list[Any]] = Field(default_factory=list)
    counters: dict[str, Any] = Field(default_factory=dict)
    seen_messages: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "lr-agent-probe-stage8"

    @property
    def invoke_calls(self) -> int:
        return int(self.counters.get("invoke_calls", 0))

    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        self.counters["bound_tool_names"] = [getattr(t, "name", str(t)) for t in tools]
        return self

    def _items(self) -> list[Any]:
        index = int(self.counters.get("invoke_calls", 0))
        self.counters["invoke_calls"] = index + 1
        if index < len(self.rounds):
            return list(self.rounds[index])
        return [AIMessageChunk(content="")]

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        merged: AIMessageChunk | None = None
        for item in self._items():
            if isinstance(item, BaseException):
                raise item
            merged = item if merged is None else merged + item
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="" if merged is None else merged.content,
                        tool_calls=[] if merged is None else list(merged.tool_calls or []),
                    )
                )
            ]
        )

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen_messages.append(list(messages))
        for item in self._items():
            if isinstance(item, BaseException):
                raise item
            yield ChatGenerationChunk(message=item)


# ── 分片 / 工具 ────────────────────────────────────────────────────────


def call_round(calls: list[tuple[str, str, dict[str, Any]]]) -> list[AIMessageChunk]:
    out: list[AIMessageChunk] = []
    for index, (call_id, name, args) in enumerate(calls):
        raw = json.dumps(args, ensure_ascii=False)
        head, tail = raw[: len(raw) // 2], raw[len(raw) // 2 :]
        out.append(
            AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": name,
                        "args": head,
                        "id": call_id,
                        "index": index,
                        "type": "tool_call_chunk",
                    }
                ],
            )
        )
        out.append(
            AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": None,
                        "args": tail,
                        "id": None,
                        "index": index,
                        "type": "tool_call_chunk",
                    }
                ],
            )
        )
    return out


def text_chunk(text: str) -> AIMessageChunk:
    return AIMessageChunk(content=text)


def make_tools(specs: dict[str, dict[str, Any]]):
    executions: dict[str, list[dict]] = {name: [] for name in specs}
    tools: list[StructuredTool] = []
    for name, spec in specs.items():
        def _make(tool_name=name, tool_spec=spec):
            def _fn(**kwargs):
                executions[tool_name].append(kwargs)
                if tool_spec.get("raises") is not None:
                    raise tool_spec["raises"]
                payload = tool_spec.get("result") or {
                    "ok": True,
                    "summary": f"{tool_name} ok",
                }
                return json.dumps(payload, ensure_ascii=False)

            return _fn

        schema: dict[str, Any] = {
            "type": "object",
            "properties": spec.get("properties") or {},
        }
        if spec.get("required"):
            schema["required"] = spec["required"]
        tools.append(
            StructuredTool(
                name=name,
                description=f"{name} stub",
                func=_make(),
                args_schema=schema,
            )
        )
    return tools, executions


# ── 驱动（真实候选入口；只有模型工厂与工具集被替换）────────────────────


def body(
    *,
    messages: list[dict[str, Any]] | None = None,
    client_tool_results: list[dict[str, Any]] | None = None,
    client_context: ClientContextInput | None = None,
    user_content: str = "执行任务",
    client_job_id: str = "job-probe-stage8",
) -> LocalChatStreamRequest:
    return LocalChatStreamRequest(
        api_key="k",
        base_url="https://api.example.com/v1",
        model="test-model",
        messages=messages or [{"role": "user", "content": user_content}],
        user_content=user_content,
        client_job_id=client_job_id,
        client_tool_results=client_tool_results or [],
        client_context=client_context
        if client_context is not None
        else ClientContextInput(workspace_root="/tmp/ws"),
    )


def frames_of(chunks: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for block in "".join(chunks).split("\n\n"):
        block = block.strip()
        if block.startswith("data: "):
            out.append(json.loads(block[len("data: ") :]))
    return out


async def run(
    *,
    rounds: list[list[Any]],
    specs: dict[str, dict[str, Any]],
    request: LocalChatStreamRequest,
    phase_states: list[ProposalStateInput] | None = None,
    is_cancelled: Any = None,
    real_phase: bool = True,
) -> dict[str, Any]:
    tools, executions = make_tools(specs)
    model = ScriptedChat(rounds=rounds)
    entry.ChatOpenAI = lambda **kwargs: model  # type: ignore[assignment]
    entry.build_local_tools = lambda b, s: list(tools)  # type: ignore[assignment]
    if real_phase and phase_states is not None:
        request.client_context.proposal_states = phase_states  # type: ignore[union-attr]

    chunks: list[str] = []
    error: str | None = None
    started = time.perf_counter()
    try:
        async for chunk in entry.stream_candidate_engine_sse(
            request, Settings(agent_engine="candidate"), is_cancelled=is_cancelled
        ):
            chunks.append(chunk)
    except BaseException as exc:  # noqa: BLE001 - 探针要看到一切
        error = f"{type(exc).__name__}: {exc}"
    elapsed = time.perf_counter() - started
    return {
        "frames": frames_of(chunks),
        "error": error,
        "model_calls": model.invoke_calls,
        "executions": {k: v for k, v in executions.items()},
        "elapsed": round(elapsed, 3),
        "seen_messages": model.seen_messages,
    }


def show(title: str, result: dict[str, Any]) -> None:
    print("=" * 78)
    print(title)
    print("-" * 78)
    print("error   :", result["error"])
    print("model   :", result["model_calls"])
    print("tool exe:", result["executions"])
    print("elapsed :", result["elapsed"])
    print("frames  :")
    for frame in result["frames"]:
        print("   ", json.dumps(frame, ensure_ascii=False))
    print("types   :", [f["type"] for f in result["frames"]])
    print("has done:", any(f["type"] == "done" for f in result["frames"]))
    print("has err :", any(f["type"] == "error" for f in result["frames"]))


READ = {"result": {"ok": True, "summary": "已读取 a.md"}}
WRITE = {"result": {"ok": True, "summary": "已写入", "file_written": True}}
ANNOTATE = {"result": {"ok": True, "summary": "不应在后端执行"}}


async def main() -> None:
    # 1a. 模型流中途抛 RuntimeError
    show(
        "1a 模型流中途 RuntimeError（round1: 文本 then raise）",
        await run(
            rounds=[
                [text_chunk("前半截"), RuntimeError("模型炸了")],
                [text_chunk("不应到达")],
            ],
            specs={"read_workspace_file": READ},
            request=body(),
        ),
    )

    # 1b. 模型超时（TimeoutError）
    show(
        "1b 模型超时 TimeoutError（round1: raise）",
        await run(
            rounds=[[TimeoutError("model timeout")], [text_chunk("不应到达")]],
            specs={"read_workspace_file": READ},
            request=body(),
        ),
    )

    # 2a. 工具抛 RuntimeError（写类 PROPOSAL 工具）
    show(
        "2a write_workspace_file 抛 RuntimeError",
        await run(
            rounds=[
                call_round(
                    [("w1", "write_workspace_file", {"relative_path": "a.md", "content": "x"})]
                ),
                [text_chunk("写入失败。")],
            ],
            specs={"write_workspace_file": {"raises": RuntimeError("磁盘炸了")}},
            request=body(),
        ),
    )

    # 2b. 工具超时（写类工具，TimeoutError）
    show(
        "2b write_workspace_file 抛 TimeoutError（写类不得重试）",
        await run(
            rounds=[
                call_round(
                    [("w1", "write_workspace_file", {"relative_path": "a.md", "content": "x"})]
                ),
                [text_chunk("写入超时。")],
            ],
            specs={"write_workspace_file": {"raises": TimeoutError("tool timeout")}},
            request=body(),
        ),
    )

    # 2c. 只读工具超时（可重试）：观察重试次数与耗时
    show(
        "2c read_workspace_file 抛 TimeoutError（只读可重试）",
        await run(
            rounds=[
                call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("读取超时。")],
            ],
            specs={"read_workspace_file": {"raises": TimeoutError("read timeout")}},
            request=body(),
        ),
    )

    # 2d. 只读工具抛 RuntimeError（不可重试）
    show(
        "2d read_workspace_file 抛 RuntimeError（不可重试）",
        await run(
            rounds=[
                call_round([("r1", "read_workspace_file", {"relative_path": "a.md"})]),
                [text_chunk("读取失败。")],
            ],
            specs={"read_workspace_file": {"raises": RuntimeError("磁盘炸了")}},
            request=body(),
        ),
    )

    # 6a. 非法参数：类型错误（properties 声明为 string，实际给 int）
    show(
        "6a 非法工具参数：relative_path=123（schema 声明 string）",
        await run(
            rounds=[
                call_round([("i1", "read_workspace_file", {"relative_path": 123})]),
                [text_chunk("参数有误。")],
            ],
            specs={
                "read_workspace_file": {
                    **READ,
                    "properties": {"relative_path": {"type": "string"}},
                    "required": ["relative_path"],
                }
            },
            request=body(),
        ),
    )

    # 6b. 非法参数：缺必填
    show(
        "6b 非法工具参数：缺必填 relative_path",
        await run(
            rounds=[
                call_round([("i2", "read_workspace_file", {})]),
                [text_chunk("缺少参数。")],
            ],
            specs={
                "read_workspace_file": {
                    **READ,
                    "properties": {"relative_path": {"type": "string"}},
                    "required": ["relative_path"],
                }
            },
            request=body(),
        ),
    )

    # 7a. AWAIT_CONFIRM：write_workspace_file（SYNC/PROPOSAL 会真实执行）
    await_ctx = ClientContextInput(
        workspace_root="/tmp/ws",
        proposal_states=[
            ProposalStateInput(path="data/1.jpg", kind="annotation", status="pending")
        ],
    )
    show(
        "7a AWAIT_CONFIRM + write_workspace_file（用户未确认）",
        await run(
            rounds=[
                call_round(
                    [("w1", "write_workspace_file", {"relative_path": "a.md", "content": "x"})]
                ),
                [text_chunk("提案未确认，先不写盘。")],
            ],
            specs={
                "write_workspace_file": {
                    "properties": {
                        "relative_path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    **WRITE,
                }
            },
            request=body(client_context=await_ctx),
            phase_states=await_ctx.proposal_states,
        ),
    )

    # 7b. VERIFY：对已 applied 路径重复 auto_annotate
    verify_ctx = ClientContextInput(
        workspace_root="/tmp/ws",
        proposal_states=[
            ProposalStateInput(
                path="data/1.jpg",
                kind="annotation",
                status="applied",
                annotation_ids=["ann-1"],
            )
        ],
    )
    show(
        "7b VERIFY + auto_annotate 重复标注已 applied 路径",
        await run(
            rounds=[
                call_round([("a1", "auto_annotate", {"paths": ["data/1.jpg"]})]),
            ],
            specs={"auto_annotate": ANNOTATE},
            request=body(client_context=verify_ctx),
            phase_states=verify_ctx.proposal_states,
        ),
    )

    # 7c. VERIFY：all_files=true 全量重标
    show(
        "7c VERIFY + auto_annotate all_files=true",
        await run(
            rounds=[
                call_round([("a1", "auto_annotate", {"all_files": True})]),
            ],
            specs={"auto_annotate": ANNOTATE},
            request=body(client_context=verify_ctx),
            phase_states=verify_ctx.proposal_states,
        ),
    )

    print("=" * 78)
    print("探针结束")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
