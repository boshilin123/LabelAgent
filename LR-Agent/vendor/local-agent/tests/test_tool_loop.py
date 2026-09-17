"""测试 ToolLoopRunner：单轮/多轮 mock LLM，含 tool call 解析与执行。"""

import pytest
from app.agent.assist.tool_loop import ToolLoopRunner
from app.agent.assist.proposal_streamer import ProposalStreamInterceptor


# ── Helpers ──────────────────────────────────────────────────────────────

class MockChatOpenAI:
    """Mock ChatOpenAI，astream 返回预设 chunk 序列。"""
    def __init__(self, chunks):
        self._chunks = chunks

    def bind_tools(self, tools, tool_choice=None):
        return self

    async def astream(self, messages):
        for chunk in self._chunks:
            yield chunk

    async def ainvoke(self, messages):
        # tool_choice="any" retry 使用
        return self._chunks[-1] if self._chunks else type("MockMsg", (), {"tool_calls": [], "content": ""})()


class MockChunk:
    """Mock AIMessageChunk。"""
    def __init__(self, content="", tool_call_chunks=None, tool_calls=None, additional_kwargs=None):
        self.content = content
        self.tool_call_chunks = tool_call_chunks or []
        self.tool_calls = tool_calls
        self.additional_kwargs = additional_kwargs or {}

    def __add__(self, other):
        # merge tool_calls
        merged_tool_calls = (self.tool_calls or []) + (other.tool_calls or [])
        return MockChunk(
            content=(self.content or "") + (other.content or ""),
            tool_call_chunks=self.tool_call_chunks + other.tool_call_chunks,
            tool_calls=merged_tool_calls,
            additional_kwargs={**self.additional_kwargs, **other.additional_kwargs},
        )


async def _collect_events(async_iter):
    return [e async for e in async_iter]


async def _never_cancel() -> bool:
    """取消检查桩：会话永不取消。"""
    return False


# ── Tests ───────────────────────────────────────────────────────────────

class TestToolLoopStreamChunks:
    async def test_stream_chunks_yields_text_delta(self):
        """LLM 返回纯文本，应产出 text_delta。"""
        llm = MockChatOpenAI([MockChunk(content="hello")])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        interceptor = ProposalStreamInterceptor()

        events = await _collect_events(loop.stream_chunks([], interceptor))
        text_events = [e for e in events if e.type == "text_delta"]
        assert len(text_events) == 1
        assert text_events[0].content == "hello"

    async def test_stream_chunks_respects_cancellation(self):
        cancelled = [False]

        async def check_cancel():
            cancelled[0] = True
            return True

        llm = MockChatOpenAI([MockChunk(content="hello")])
        loop = ToolLoopRunner(llm, [], {}, None, check_cancel, "test")
        interceptor = ProposalStreamInterceptor()

        events = await _collect_events(loop.stream_chunks([], interceptor))
        assert len(events) == 0  # 第一个 chunk 前就被取消了

    async def test_stream_chunks_yields_reasoning_delta(self):
        llm = MockChatOpenAI([
            MockChunk(content="", additional_kwargs={"reasoning_content": "thinking..."})
        ])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        interceptor = ProposalStreamInterceptor()

        events = await _collect_events(loop.stream_chunks([], interceptor))
        reasoning_events = [e for e in events if e.type == "reasoning_delta"]
        assert len(reasoning_events) >= 1

    async def test_stream_chunks_does_not_emit_placeholder_reasoning(self):
        llm = MockChatOpenAI([
            MockChunk(
                content="",
                tool_call_chunks=[{"name": "read_workspace_file", "args": ""}],
            )
        ])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        interceptor = ProposalStreamInterceptor()

        events = await _collect_events(loop.stream_chunks([], interceptor))
        reasoning_events = [e for e in events if e.type == "reasoning_delta"]
        assert reasoning_events == []
        assert all(
            "正在分析需求" not in (e.content or "")
            for e in events
        )


class TestToolLoopExecuteRound:
    def _make_gathered(self, tool_calls=None, content=""):
        return MockChunk(content=content, tool_calls=tool_calls)

    async def test_no_tool_calls_returns_empty(self):
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        gather = self._make_gathered(tool_calls=[])
        interceptor = ProposalStreamInterceptor()

        events = await _collect_events(
            loop.execute_round(gather, "hello", [], interceptor)
        )
        assert len(events) == 0

    async def test_execute_round_runs_coroutine_only_tool(self):
        """MCP 风格工具只有 coroutine：执行层必须 await，不能报未知工具。"""
        import json

        from langchain_core.tools import StructuredTool

        from app.agent.tools.registry import tool_fn_map

        async def memory_create(
            topic_file: str, content: str, index_line: str
        ) -> str:
            return json.dumps(
                {"ok": True, "created": True, "topic_file": topic_file},
                ensure_ascii=False,
            )

        tool = StructuredTool(
            name="memory_create",
            description="create topic",
            coroutine=memory_create,
            args_schema={
                "type": "object",
                "properties": {
                    "topic_file": {"type": "string"},
                    "content": {"type": "string"},
                    "index_line": {"type": "string"},
                },
            },
        )
        fn_map = tool_fn_map([tool])
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [tool], fn_map, None, _never_cancel, "test")
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "c1",
                    "name": "memory_create",
                    "args": {
                        "topic_file": "annotated-files.md",
                        "content": "# x",
                        "index_line": "- [已标文件](topics/annotated-files.md)",
                    },
                }
            ]
        )
        interceptor = ProposalStreamInterceptor()
        events = await _collect_events(
            loop.execute_round(gather, "", [], interceptor)
        )
        results = [e for e in events if e.type == "tool_result"]
        assert len(results) == 1
        assert "未知工具" not in (results[0].result or "")
        payload = json.loads(results[0].result or "{}")
        assert payload.get("ok") is True
        assert payload.get("topic_file") == "annotated-files.md"

    async def test_execute_round_unwraps_mcp_content_and_artifact(self):
        import json

        from langchain_core.tools import StructuredTool

        from app.agent.tools.registry import tool_fn_map

        async def memory_create(
            topic_file: str, content: str, index_line: str
        ):
            payload = json.dumps(
                {"ok": True, "created": True, "topic_file": topic_file},
                ensure_ascii=False,
            )
            return (
                [{"type": "text", "text": payload}],
                {"structured_content": None},
            )

        tool = StructuredTool(
            name="memory_create",
            description="create topic",
            coroutine=memory_create,
            args_schema={
                "type": "object",
                "properties": {
                    "topic_file": {"type": "string"},
                    "content": {"type": "string"},
                    "index_line": {"type": "string"},
                },
            },
            response_format="content_and_artifact",
        )
        loop = ToolLoopRunner(
            MockChatOpenAI([]),
            [tool],
            tool_fn_map([tool]),
            None,
            _never_cancel,
            "test",
        )
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "c1",
                    "name": "memory_create",
                    "args": {
                        "topic_file": "annotated-files.md",
                        "content": "# x",
                        "index_line": "- idx",
                    },
                }
            ]
        )
        events = await _collect_events(
            loop.execute_round(gather, "", [], ProposalStreamInterceptor())
        )
        results = [e for e in events if e.type == "tool_result"]
        assert len(results) == 1
        payload = json.loads(results[0].result or "{}")
        assert payload.get("ok") is True
        assert payload.get("topic_file") == "annotated-files.md"

    async def test_execute_round_already_completed_appends_stub_and_continues(self):
        import json

        from app.agent.assist.tool_loop import TOOL_CALLS_ALREADY_COMPLETED

        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        loop.mark_completed({"a1"})
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "a1",
                    "name": "auto_annotate",
                    "args": {"user_request": "标注"},
                }
            ],
            content="现在执行自动标注。",
        )
        messages: list = []
        events = await _collect_events(
            loop.execute_round(gather, "", messages, ProposalStreamInterceptor())
        )
        assert [e.type for e in events] == [TOOL_CALLS_ALREADY_COMPLETED]
        assert not any(e.type == "tool_start" for e in events)
        assert len(messages) == 2
        payload = json.loads(messages[1].content)
        assert payload["status"] == "already_completed"
        assert payload["tool"] == "auto_annotate"


class TestToolLoopPhaseGate:
    """阶段门禁：await_confirm 禁止写入；verify 禁止重复标注已落盘路径。"""

    def _make_gathered(self, tool_calls=None, content=""):
        return MockChunk(content=content, tool_calls=tool_calls)

    async def test_await_confirm_blocks_auto_annotate(self):
        import json

        from app.agent.assist.task_phase import derive_task_phase
        from app.schemas.agent import ProposalStateInput

        ctx = derive_task_phase(
            [ProposalStateInput(path="data/2.jpg", kind="annotation", status="pending")]
        )
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(
            llm, [], {}, None, _never_cancel, "test", task_phase_ctx=ctx
        )
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "c1",
                    "name": "auto_annotate",
                    "args": {"user_request": "补标", "paths": ["data/3.jpg"]},
                }
            ]
        )
        messages: list = []
        events = await _collect_events(
            loop.execute_round(gather, "", messages, ProposalStreamInterceptor())
        )
        # 被门禁拦截：tool_start + tool_result(phase_blocked)，不发射 tool_pending
        assert [e.type for e in events] == ["tool_start", "tool_result"]
        result_event = next(e for e in events if e.type == "tool_result")
        payload = json.loads(result_event.result or "{}")
        assert payload["status"] == "phase_blocked"
        assert "Keep All" in payload["summary"]
        # AIMessage + 错误 ToolMessage 都已入列，供下一轮模型调整
        assert len(messages) == 2

    async def test_verify_blocks_reannotate_applied_path(self):
        import json

        from app.agent.assist.task_phase import derive_task_phase
        from app.schemas.agent import ProposalStateInput

        ctx = derive_task_phase(
            [ProposalStateInput(path="data/2.jpg", kind="annotation", status="applied")]
        )
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(
            llm, [], {}, None, _never_cancel, "test", task_phase_ctx=ctx
        )
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "c1",
                    "name": "auto_annotate",
                    "args": {"user_request": "补标", "paths": ["data/2.jpg"]},
                }
            ]
        )
        events = await _collect_events(
            loop.execute_round(gather, "", [], ProposalStreamInterceptor())
        )
        assert [e.type for e in events] == ["tool_start", "tool_result"]
        result_event = next(e for e in events if e.type == "tool_result")
        payload = json.loads(result_event.result or "{}")
        assert payload["status"] == "phase_blocked"
        assert "data/2.jpg" in payload["summary"]

    async def test_verify_allows_new_path_annotation(self):
        from app.agent.assist.task_phase import derive_task_phase
        from app.schemas.agent import ProposalStateInput

        ctx = derive_task_phase(
            [ProposalStateInput(path="data/2.jpg", kind="annotation", status="applied")]
        )
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(
            llm, [], {}, None, _never_cancel, "test", task_phase_ctx=ctx
        )
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "c1",
                    "name": "auto_annotate",
                    "args": {"user_request": "补标", "paths": ["data/9.jpg"]},
                }
            ]
        )
        events = await _collect_events(
            loop.execute_round(gather, "", [], ProposalStreamInterceptor())
        )
        # 新路径放行：发射 tool_pending
        assert any(e.type == "tool_pending" for e in events)


class TestToolLoopPseudoRetry:
    """正文伪代码兜底：模型写了 auto_annotate(...) 文本但没发起真实 tool_call。"""

    def _make_gathered(self, tool_calls=None, content=""):
        return MockChunk(content=content, tool_calls=tool_calls)

    async def test_pseudo_text_triggers_forced_tool_call(self):
        from langchain_core.tools import StructuredTool

        def _auto_annotate_stub(user_request: str) -> str:
            return "stub"

        tool = StructuredTool.from_function(
            func=_auto_annotate_stub,
            name="auto_annotate",
            description="自动标注",
        )
        # ainvoke（tool_choice="any" 强制重试）返回携带 tool_calls 的 chunk
        forced_chunk = MockChunk(
            tool_calls=[
                {
                    "id": "forced-1",
                    "name": "auto_annotate",
                    "args": {"user_request": "补标", "paths": ["data/2.jpg"]},
                }
            ]
        )
        llm = MockChatOpenAI([forced_chunk])
        loop = ToolLoopRunner(llm, [tool], {}, None, _never_cancel, "补标")
        # 正文写了伪代码但 gathered 无 tool_calls
        gather = self._make_gathered(
            tool_calls=[], content="现在调用 auto_annotate(paths=['data/2.jpg']) 补标。"
        )
        messages: list = []
        events = await _collect_events(
            loop.execute_round(
                gather,
                "现在调用 auto_annotate(paths=['data/2.jpg']) 补标。",
                messages,
                ProposalStreamInterceptor(),
            )
        )
        # 强制重试成功：发射 tool_pending
        assert any(e.type == "tool_pending" for e in events)
        # 合成的 AIMessage 携带 tool_calls 入列，保证 ToolMessage 归属
        from langchain_core.messages import AIMessage

        ai_msgs = [m for m in messages if isinstance(m, AIMessage)]
        assert ai_msgs and ai_msgs[0].tool_calls[0]["name"] == "auto_annotate"

    async def test_plain_text_without_tool_mention_not_forced(self):
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        gather = self._make_gathered(tool_calls=[], content="你好")
        events = await _collect_events(
            loop.execute_round(gather, "你好", [], ProposalStreamInterceptor())
        )
        assert events == []
        assert loop.tool_choice_retries == 0


class TestToolLoopAsyncDedupe:
    """同一轮内多个 auto_annotate 合并为一次批量；mutate_annotation 同范围去重。"""

    def _make_gathered(self, tool_calls=None, content=""):
        return MockChunk(content=content, tool_calls=tool_calls)

    async def test_same_paths_auto_annotate_coalesced(self):
        """同 paths 的重复 auto_annotate 先被合并（coalesced），只发一次 pending。"""
        import json

        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "c1",
                    "name": "auto_annotate",
                    "args": {"user_request": "补标", "paths": ["data/2.jpg"]},
                },
                {
                    "id": "c2",
                    "name": "auto_annotate",
                    "args": {"user_request": "补标", "paths": ["data/2.jpg"]},
                },
            ]
        )
        messages: list = []
        events = await _collect_events(
            loop.execute_round(gather, "", messages, ProposalStreamInterceptor())
        )
        pending = [e for e in events if e.type == "tool_pending"]
        assert len(pending) == 1
        assert len(pending[0].client_tool_calls or []) == 1
        dup_results = [
            e for e in events if e.type == "tool_result" and e.tool_call_id == "c2"
        ]
        assert len(dup_results) == 1
        payload = json.loads(dup_results[0].result or "{}")
        assert payload["status"] == "coalesced"

    async def test_multiple_auto_annotate_merged_into_one(self):
        """5 个不同 paths 的 auto_annotate 合并为一次批量，其余回 coalesced。"""
        import json

        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": f"c{i}",
                    "name": "auto_annotate",
                    "args": {"user_request": "补标", "paths": [f"data/{i}.jpg"]},
                }
                for i in (2, 4, 5, 6, 7)
            ]
        )
        messages: list = []
        events = await _collect_events(
            loop.execute_round(gather, "", messages, ProposalStreamInterceptor())
        )
        pending = [e for e in events if e.type == "tool_pending"]
        assert len(pending) == 1
        calls = pending[0].client_tool_calls or []
        assert len(calls) == 1
        merged_args = calls[0].arguments
        assert merged_args["paths"] == [
            "data/2.jpg",
            "data/4.jpg",
            "data/5.jpg",
            "data/6.jpg",
            "data/7.jpg",
        ]
        assert merged_args["all_files"] is False
        coalesced = [
            e
            for e in events
            if e.type == "tool_result" and "coalesced" in (e.result or "")
        ]
        assert len(coalesced) == 4

    async def test_mutate_annotation_same_scope_deduped(self):
        """mutate_annotation 不合并，但同范围重复仍去重。"""
        import json

        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "m1",
                    "name": "mutate_annotation",
                    "args": {"user_request": "改标签", "paths": ["data/7.jpg"]},
                },
                {
                    "id": "m2",
                    "name": "mutate_annotation",
                    "args": {"user_request": "改标签", "paths": ["data/7.jpg"]},
                },
            ]
        )
        events = await _collect_events(
            loop.execute_round(gather, "", [], ProposalStreamInterceptor())
        )
        pending = [e for e in events if e.type == "tool_pending"]
        assert len(pending) == 1
        assert len(pending[0].client_tool_calls or []) == 1
        dup = [
            e for e in events if e.type == "tool_result" and e.tool_call_id == "m2"
        ]
        assert len(dup) == 1
        payload = json.loads(dup[0].result or "{}")
        assert payload["status"] == "duplicate_call"


class TestToolLoopSameRoundGate:
    """同轮顺序不变量：标注写入与工作区写入不能同轮。"""

    def _make_gathered(self, tool_calls=None, content=""):
        return MockChunk(content=content, tool_calls=tool_calls)

    async def test_write_and_annotate_same_round_write_blocked(self):
        import json

        from langchain_core.tools import StructuredTool

        def _write_stub(relative_path: str, content: str) -> str:
            return "stub"

        write_tool = StructuredTool.from_function(
            func=_write_stub,
            name="write_workspace_file",
            description="写文件",
        )
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(
            llm, [write_tool], {"write_workspace_file": _write_stub}, None, _never_cancel, "test"
        )
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "w1",
                    "name": "write_workspace_file",
                    "args": {"relative_path": "reports/r.md", "content": "# r"},
                },
                {
                    "id": "a1",
                    "name": "auto_annotate",
                    "args": {"user_request": "补标", "paths": ["data/2.jpg"]},
                },
            ]
        )
        messages: list = []
        events = await _collect_events(
            loop.execute_round(gather, "", messages, ProposalStreamInterceptor())
        )
        # 文件写入被拦，标注发出 tool_pending
        blocked = [
            e
            for e in events
            if e.type == "tool_result" and e.tool_call_id == "w1"
        ]
        assert len(blocked) == 1
        payload = json.loads(blocked[0].result or "{}")
        assert payload["status"] == "phase_blocked"
        assert "Keep All" in payload["summary"]
        assert any(e.type == "tool_pending" for e in events)

    async def test_write_alone_not_blocked(self):
        from langchain_core.tools import StructuredTool

        def _write_stub(relative_path: str, content: str) -> str:
            return "stub"

        write_tool = StructuredTool.from_function(
            func=_write_stub,
            name="write_workspace_file",
            description="写文件",
        )
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(
            llm, [write_tool], {"write_workspace_file": _write_stub}, None, _never_cancel, "test"
        )
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "w1",
                    "name": "write_workspace_file",
                    "args": {"relative_path": "reports/r.md", "content": "# r"},
                }
            ]
        )
        events = await _collect_events(
            loop.execute_round(gather, "", [], ProposalStreamInterceptor())
        )
        # 无标注写入时，文件写入正常执行（未知工具错误，而非 phase_blocked）
        results = [e for e in events if e.type == "tool_result"]
        assert len(results) == 1
        assert "phase_blocked" not in (results[0].result or "")


class TestParallelExploreReadonly:
    def _make_gathered(self, tool_calls=None, content=""):
        return MockChunk(content=content, tool_calls=tool_calls)

    async def test_same_round_explores_overlap_and_keep_tool_ids(self):
        import asyncio

        from app.schemas.agent import StreamEventPayload

        class OverlapRunner:
            def __init__(self):
                self.active = 0
                self.max_active = 0

            async def stream(self, *, query, focus_path, parent_tool_id):
                self.active += 1
                self.max_active = max(self.max_active, self.active)
                await asyncio.sleep(0.05)
                yield StreamEventPayload(
                    type="subagent_start",
                    tool_call_id=parent_tool_id,
                    query=query,
                    focus_path=focus_path,
                )
                yield StreamEventPayload(
                    type="subagent_done",
                    tool_call_id=parent_tool_id,
                    summary=f"ok:{query}",
                    status="done",
                )
                self.active -= 1

        runner = OverlapRunner()
        loop = ToolLoopRunner(
            MockChatOpenAI([]),
            [],
            {"explore_readonly": runner},
            None,
            _never_cancel,
            "test",
        )
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "e1",
                    "name": "explore_readonly",
                    "args": {"query": "查 A"},
                },
                {
                    "id": "e2",
                    "name": "explore_readonly",
                    "args": {"query": "查 B"},
                },
            ]
        )
        messages: list = []
        events = await _collect_events(
            loop.execute_round(gather, "", messages, ProposalStreamInterceptor())
        )
        assert runner.max_active == 2
        starts = [e for e in events if e.type == "subagent_start"]
        dones = [e for e in events if e.type == "subagent_done"]
        results = [e for e in events if e.type == "tool_result"]
        assert {e.tool_call_id for e in starts} == {"e1", "e2"}
        assert {e.tool_call_id for e in dones} == {"e1", "e2"}
        assert [e.tool_call_id for e in results] == ["e1", "e2"]
        assert len(messages) == 3
        assert [m.tool_call_id for m in messages[1:]] == ["e1", "e2"]


class TestProposalDismissedOnToolError:
    """工具报错但拦截器已为该路径出卡时，必须补发 dismissed 终态收卡。"""

    async def _run(self, streamed_call_id: str | None):
        import json

        from langchain_core.tools import StructuredTool

        from app.agent.tools.registry import tool_fn_map

        async def str_replace_stub(
            relative_path: str = "",
            old_string: str = "",
            new_string: str = "",
            replace_all: bool = False,
        ) -> str:
            return json.dumps(
                {
                    "ok": False,
                    "tool": "str_replace_workspace_file",
                    "status": "error",
                    "summary": "未找到 old_string",
                },
                ensure_ascii=False,
            )

        tool = StructuredTool(
            name="str_replace_workspace_file",
            description="edit stub",
            coroutine=str_replace_stub,
            args_schema={
                "type": "object",
                "properties": {
                    "relative_path": {"type": "string"},
                    "old_string": {"type": "string"},
                    "new_string": {"type": "string"},
                    "replace_all": {"type": "boolean"},
                },
            },
        )
        fn_map = tool_fn_map([tool])
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [tool], fn_map, None, _never_cancel, "test")

        interceptor = ProposalStreamInterceptor()
        if streamed_call_id:
            # 模拟流式期间拦截器已为该调用发出 file_proposal_start
            class _StartChunk:
                tool_call_chunks = [
                    {
                        "index": 0,
                        "name": "str_replace_workspace_file",
                        "args": '{"relative_path": "a.py"}',
                        "id": streamed_call_id,
                    }
                ]
            interceptor.on_chunk(_StartChunk())

        gather = MockChunk(
            content="",
            tool_calls=[
                {
                    "id": "c1",
                    "name": "str_replace_workspace_file",
                    "args": {
                        "relative_path": "a.py",
                        "old_string": "x",
                        "new_string": "y",
                    },
                }
            ],
        )
        messages: list = []
        return await _collect_events(
            loop.execute_round(gather, "", messages, interceptor)
        )

    async def test_streamed_then_error_emits_dismissed(self):
        events = await self._run("c1")
        finals = [e for e in events if e.type == "file_proposal"]
        assert len(finals) == 1
        assert finals[0].status == "dismissed"
        assert finals[0].image_path == "a.py"

    async def test_not_streamed_error_emits_no_final(self):
        events = await self._run(None)
        assert [e for e in events if e.type == "file_proposal"] == []
