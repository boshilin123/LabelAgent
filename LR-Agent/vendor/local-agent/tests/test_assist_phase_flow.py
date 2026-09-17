"""服务级集成：stream_assist + 标注任务阶段机。

模拟「扫描 → 补标 → 提案确认 → 核对 → 报告」复合任务的骨干流程：
  1. 提案 pending 时 resume → await_confirm：写报告/重复标注被门禁拦截
  2. Keep All 后 resume（applied）→ verify：对已落盘路径的重复标注被拦截
  3. 无结构化提案状态（旧客户端）→ 不启用门禁，行为与之前一致
"""

import json

from langchain_core.messages import HumanMessage

from app.agent.assist.task_phase import TaskPhase, derive_task_phase
from app.agent.assist_service import stream_assist
from app.schemas.agent import (
    ClientContextInput,
    ClientToolResult,
    ProposalStateInput,
)


class MockChunk:
    """Mock AIMessageChunk（与 test_tool_loop 同款）。"""

    def __init__(self, content="", tool_call_chunks=None, tool_calls=None, additional_kwargs=None):
        self.content = content
        self.tool_call_chunks = tool_call_chunks or []
        self.tool_calls = tool_calls
        self.additional_kwargs = additional_kwargs or {}

    def __add__(self, other):
        merged_tool_calls = (self.tool_calls or []) + (other.tool_calls or [])
        return MockChunk(
            content=(self.content or "") + (other.content or ""),
            tool_call_chunks=self.tool_call_chunks + other.tool_call_chunks,
            tool_calls=merged_tool_calls,
            additional_kwargs={**self.additional_kwargs, **other.additional_kwargs},
        )


class SequenceMockChat:
    """按轮次返回预设 chunk 序列的 Mock LLM。"""

    def __init__(self, rounds):
        self._rounds = list(rounds)

    def bind_tools(self, tools, tool_choice=None):
        return self

    async def astream(self, messages):
        chunks = self._rounds.pop(0) if self._rounds else []
        for chunk in chunks:
            yield chunk

    async def ainvoke(self, messages):
        return type("MockMsg", (), {"tool_calls": [], "content": ""})()


async def _never_cancel() -> bool:
    return False


async def _collect(async_iter):
    return [e async for e in async_iter]


def _auto_annotate_result() -> ClientToolResult:
    return ClientToolResult(
        tool_call_id="call-1",
        name="auto_annotate",
        result=json.dumps(
            {
                "status": "completed",
                "tool": "auto_annotate",
                "summary": "已生成待确认提案（未写盘）。批量标注完成：处理 5 张，共 14 个框。",
                "proposal_pending": True,
                "file_written": False,
            },
            ensure_ascii=False,
        ),
    )


class TestAwaitConfirmGate:
    async def test_pending_proposal_blocks_report_write(self) -> None:
        """提案未确认时 resume：模型试图写报告 → 门禁拦截并反馈。"""
        states = [
            ProposalStateInput(path="data/2.jpg", kind="annotation", status="pending")
        ]
        ctx = derive_task_phase(states)
        assert ctx is not None and ctx.phase == TaskPhase.AWAIT_CONFIRM

        llm = SequenceMockChat(
            [
                # 第一轮：模型试图在落盘前写报告
                [
                    MockChunk(
                        tool_calls=[
                            {
                                "id": "w1",
                                "name": "write_workspace_file",
                                "args": {
                                    "relative_path": "reports/r.md",
                                    "content": "# 报告",
                                },
                            }
                        ]
                    )
                ],
                # 第二轮：收到门禁反馈后改为提示用户确认
                [MockChunk(content="提案已生成，请 Keep All 后我再生成报告。")],
            ]
        )
        events = await _collect(
            stream_assist(
                llm,
                [HumanMessage(content="补标并写报告")],
                [],
                settings=None,  # type: ignore[arg-type]
                max_tool_rounds=5,
                is_cancelled=_never_cancel,
                client_context=ClientContextInput(
                    workspace_root="/w", proposal_states=states
                ),
                user_content="补标并写报告",
                client_tool_results=[_auto_annotate_result()],
                task_phase_ctx=ctx,
            )
        )
        blocked = [
            e
            for e in events
            if e.type == "tool_result" and "phase_blocked" in (e.result or "")
        ]
        assert len(blocked) == 1
        assert "Keep All" in (blocked[0].result or "")
        # 未产生任何文件提案
        assert not any(e.type == "file_proposal" for e in events)
        # 最终输出等待确认的文本
        assert any(
            e.type == "text_delta" and "Keep All" in (e.content or "")
            for e in events
        )


class TestAwaitConfirmToolsStayBound:
    async def test_write_tool_bound_but_blocked_at_execution(self) -> None:
        """await_confirm 阶段：写工具仍在 bind 列表中（保前缀缓存），执行层拦截。"""
        from langchain_core.tools import StructuredTool

        from app.agent.assist_service import stream_assist

        states = [
            ProposalStateInput(path="data/2.jpg", kind="annotation", status="pending")
        ]
        ctx = derive_task_phase(states)
        assert ctx is not None and ctx.phase == TaskPhase.AWAIT_CONFIRM

        def _must_not_run(**_kwargs) -> str:
            raise AssertionError("await_confirm 阶段不应执行写工具")

        write_tool = StructuredTool.from_function(
            func=_must_not_run,
            name="write_workspace_file",
            description="write file",
        )

        class CaptureBindLLM:
            def __init__(self) -> None:
                self.bound_tool_names: list[str] = []
                self.calls = 0

            def bind_tools(self, tools, tool_choice=None):
                self.bound_tool_names = [t.name for t in tools]
                return self

            async def astream(self, messages):
                self.calls += 1
                if self.calls == 1:
                    yield MockChunk(
                        tool_calls=[
                            {
                                "id": "w1",
                                "name": "write_workspace_file",
                                "args": {
                                    "relative_path": "reports/r.md",
                                    "content": "# 报告",
                                },
                            }
                        ]
                    )
                    return
                yield MockChunk(content="提案待确认，请 Keep All。")

        llm = CaptureBindLLM()
        events = await _collect(
            stream_assist(
                llm,  # type: ignore[arg-type]
                [HumanMessage(content="写报告")],
                [write_tool],
                settings=None,  # type: ignore[arg-type]
                max_tool_rounds=5,
                is_cancelled=_never_cancel,
                client_context=ClientContextInput(
                    workspace_root="/w", proposal_states=states
                ),
                user_content="写报告",
                client_tool_results=[_auto_annotate_result()],
                task_phase_ctx=ctx,
            )
        )
        # 工具仍在 bind 列表（不再 bind 时删减）
        assert "write_workspace_file" in llm.bound_tool_names
        # 但执行层拦截，func 未运行（否则会抛 AssertionError）
        blocked = [
            e
            for e in events
            if e.type == "tool_result" and "phase_blocked" in (e.result or "")
        ]
        assert len(blocked) == 1


class TestVerifyGate:
    async def test_applied_proposal_blocks_reannotation(self) -> None:
        """Keep All 后续跑：模型试图重复标注已落盘路径 → 拦截。"""
        states = [
            ProposalStateInput(path="data/2.jpg", kind="annotation", status="applied")
        ]
        ctx = derive_task_phase(states)
        assert ctx is not None and ctx.phase == TaskPhase.VERIFY

        llm = SequenceMockChat(
            [
                [
                    MockChunk(
                        tool_calls=[
                            {
                                "id": "c1",
                                "name": "auto_annotate",
                                "args": {
                                    "user_request": "补标",
                                    "paths": ["data/2.jpg"],
                                },
                            }
                        ]
                    )
                ],
                [MockChunk(content="已核对落盘结果，报告已生成。")],
            ]
        )
        events = await _collect(
            stream_assist(
                llm,
                [HumanMessage(content="补标并写报告")],
                [],
                settings=None,  # type: ignore[arg-type]
                max_tool_rounds=5,
                is_cancelled=_never_cancel,
                client_context=ClientContextInput(
                    workspace_root="/w", proposal_states=states
                ),
                user_content="补标并写报告",
                client_tool_results=[_auto_annotate_result()],
                task_phase_ctx=ctx,
            )
        )
        blocked = [
            e
            for e in events
            if e.type == "tool_result" and "phase_blocked" in (e.result or "")
        ]
        assert len(blocked) == 1
        assert "data/2.jpg" in (blocked[0].result or "")
        # 被拦截的标注调用不会发射 tool_pending
        assert not any(e.type == "tool_pending" for e in events)


class TestVerifyBypass:
    async def test_mutate_by_annotation_ids_allowed(self) -> None:
        """VERIFY：定向修正已落盘标注 id 放行，发射 tool_pending 交给前端。"""
        states = [
            ProposalStateInput(
                path="data/7.jpg",
                kind="annotation",
                status="applied",
                annotation_ids=["ann-1"],
            )
        ]
        ctx = derive_task_phase(states)
        assert ctx is not None and ctx.phase == TaskPhase.VERIFY

        llm = SequenceMockChat(
            [
                [
                    MockChunk(
                        tool_calls=[
                            {
                                "id": "m1",
                                "name": "mutate_annotation",
                                "args": {
                                    "user_request": "改标签",
                                    "annotation_ids": ["ann-1"],
                                },
                            }
                        ]
                    )
                ],
                [MockChunk(content="已生成修正提案，待用户确认。")],
            ]
        )
        events = await _collect(
            stream_assist(
                llm,
                [HumanMessage(content="修正标注")],
                [],
                settings=None,  # type: ignore[arg-type]
                max_tool_rounds=5,
                is_cancelled=_never_cancel,
                client_context=ClientContextInput(
                    workspace_root="/w", proposal_states=states
                ),
                user_content="修正标注",
                client_tool_results=[_auto_annotate_result()],
                task_phase_ctx=ctx,
            )
        )
        assert not any(
            e.type == "tool_result" and "phase_blocked" in (e.result or "")
            for e in events
        )
        assert any(e.type == "tool_pending" for e in events)


class TestLegacyCompatibility:
    async def test_no_proposal_states_no_gating(self) -> None:
        """旧客户端（无 proposal_states）：不启用门禁，写文件调用照常执行。"""
        llm = SequenceMockChat(
            [
                [
                    MockChunk(
                        tool_calls=[
                            {
                                "id": "w1",
                                "name": "write_workspace_file",
                                "args": {
                                    "relative_path": "reports/r.md",
                                    "content": "# 报告",
                                },
                            }
                        ]
                    )
                ],
                [MockChunk(content="报告已生成。")],
            ]
        )
        events = await _collect(
            stream_assist(
                llm,
                [HumanMessage(content="写报告")],
                [],
                settings=None,  # type: ignore[arg-type]
                max_tool_rounds=5,
                is_cancelled=_never_cancel,
                client_context=ClientContextInput(workspace_root="/w"),
                user_content="写报告",
                client_tool_results=[_auto_annotate_result()],
                task_phase_ctx=None,
            )
        )
        # 无门禁：write_workspace_file 进入执行（fn_map 未注册 → 未知工具错误，而非 phase_blocked）
        results = [e for e in events if e.type == "tool_result"]
        assert len(results) == 1
        assert "phase_blocked" not in (results[0].result or "")
