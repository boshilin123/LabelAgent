"""测试 ProposalStreamInterceptor 的 JSON 增量解析。"""

from app.agent.assist.proposal_streamer import (
    ProposalStreamInterceptor,
    _extract_json_string,
)


class TestExtractJsonString:
    def test_complete_string(self):
        buf = '{"relative_path": "reports/summary.md", "content": "hello"}'
        val, closed = _extract_json_string(buf, "relative_path")
        assert val == "reports/summary.md"
        assert closed is True

    def test_incomplete_string(self):
        buf = '{"relative_path": "reports/summary'
        val, closed = _extract_json_string(buf, "relative_path")
        assert val == "reports/summary"
        assert closed is False

    def test_key_not_present(self):
        buf = '{"other": "value"}'
        val, closed = _extract_json_string(buf, "relative_path")
        assert val is None
        assert closed is False

    def test_escaped_quotes(self):
        buf = '{"relative_path": "path/with\\"quote.jpg"}'
        val, closed = _extract_json_string(buf, "relative_path")
        assert val == 'path/with"quote.jpg'
        assert closed is True

    def test_content_extraction(self):
        buf = '{"content": "hello world"}'
        val, closed = _extract_json_string(buf, "content")
        assert val == "hello world"
        assert closed is True


class TestProposalStreamInterceptor:
    def _make_chunk(self, index, name, args):
        """构造一个 mock AIMessageChunk。"""
        class MockChunk:
            tool_call_chunks = []
        chunk = MockChunk()
        chunk.tool_call_chunks = [
            {"index": index, "name": name, "args": args, "id": None}
        ]
        return chunk

    def test_write_tool_starts_state(self):
        interceptor = ProposalStreamInterceptor()
        chunk = self._make_chunk(0, "write_workspace_file", '{"relative_path": "out.md')
        events = interceptor.on_chunk(chunk)
        # 路径尚未闭合，不应有 file_proposal_start
        assert len(events) == 0
        assert 0 in interceptor.fp_states

    def test_path_closed_emits_start(self):
        interceptor = ProposalStreamInterceptor()
        chunk = self._make_chunk(0, "write_workspace_file", '{"relative_path": "out.md"}')
        events = interceptor.on_chunk(chunk)
        assert any(e.type == "file_proposal_start" for e in events)

    def test_non_write_tool_ignored(self):
        interceptor = ProposalStreamInterceptor()
        chunk = self._make_chunk(1, "read_workspace_file", '{"relative_path": "x.txt"}')
        events = interceptor.on_chunk(chunk)
        assert len(events) == 0
        assert 1 not in interceptor.fp_states

    def test_collected_paths(self):
        interceptor = ProposalStreamInterceptor()
        chunk = self._make_chunk(0, "write_workspace_file", '{"relative_path": "a.md"}')
        interceptor.on_chunk(chunk)
        paths = interceptor.collected_paths()
        assert "a.md" in paths

    def test_lr_agent_path_does_not_emit_proposal(self):
        interceptor = ProposalStreamInterceptor()
        chunk = self._make_chunk(
            0,
            "write_workspace_file",
            '{"relative_path": ".lr-agent/annotations/files/a.json", "content": "{}"}',
        )
        events = interceptor.on_chunk(chunk)
        assert events == []
        assert interceptor.collected_paths() == set()

    def _make_chunk_with_id(self, index, name, args, call_id):
        class MockChunk:
            tool_call_chunks = []
        chunk = MockChunk()
        chunk.tool_call_chunks = [
            {"index": index, "name": name, "args": args, "id": call_id}
        ]
        return chunk

    def _stream_call(self, interceptor, index, call_id, rel_path, content, pieces=3):
        """把一次完整 write 调用按 pieces 个分片喂给拦截器，返回全部事件。

        模拟 OpenAI 风格流式：首块携带 name 与 tool_call id（args 为空），
        后续块为 args 增量且 id 为 None。
        """
        args = '{"relative_path": "%s", "content": "%s"}' % (rel_path, content)
        step = max(1, len(args) // pieces)
        events = interceptor.on_chunk(
            self._make_chunk_with_id(index, "write_workspace_file", "", call_id)
        )
        for start in range(0, len(args), step):
            events += interceptor.on_chunk(
                self._make_chunk_with_id(
                    index, "write_workspace_file", args[start : start + step], None
                )
            )
        return events

    def test_new_call_reusing_index_resets_state(self):
        """回归：同请求下一轮复用 tc_index 写另一个文件时，
        delta 必须归属新路径，且不能吞掉新内容前缀。

        历史故障：拦截器跨轮复用时残留上一轮的 rel_path 与
        content_sent_len，导致 A 文件提案被追加 B 文件内容。
        """
        interceptor = ProposalStreamInterceptor()
        # 第 1 轮：idx 0 写 a.md
        round1 = self._stream_call(
            interceptor, 0, "call_1", "a.md", "A" * 50
        )
        assert any(e.type == "file_proposal_start" and e.image_path == "a.md" for e in round1)

        # 第 2 轮：idx 0 复用，写 b.md（内容比 a.md 长）
        round2 = self._stream_call(
            interceptor, 0, "call_2", "b.md", "B" * 120
        )
        starts = [e for e in round2 if e.type == "file_proposal_start"]
        deltas = [e for e in round2 if e.type == "file_proposal_delta"]
        # 必须产生新的 start，且归属 b.md
        assert any(e.image_path == "b.md" for e in starts)
        # 所有 delta 都归属 b.md，不能错标成 a.md
        assert all(e.image_path == "b.md" for e in deltas)
        # delta 拼接必须等于完整内容（无前缀丢失）
        assert "".join(e.content for e in deltas) == "B" * 120

    def test_fresh_instance_per_round_production_pattern(self):
        """生产模式回归：assist_service 每轮新建拦截器，跨轮互不影响。"""
        # 第 1 轮
        first = ProposalStreamInterceptor()
        self._stream_call(first, 0, "call_1", "a.md", "A" * 50)
        # 第 2 轮
        second = ProposalStreamInterceptor()
        round2 = self._stream_call(second, 0, "call_2", "b.md", "B" * 120)
        deltas = [e for e in round2 if e.type == "file_proposal_delta"]
        assert all(e.image_path == "b.md" for e in deltas)
        assert "".join(e.content for e in deltas) == "B" * 120

    def test_duplicate_delivery_is_idempotent(self):
        interceptor = ProposalStreamInterceptor()
        events = interceptor.on_chunk(
            self._make_chunk_with_id(
                0, "write_workspace_file", '{"relative_path": "a.md", "content": "hel', None
            )
        )
        # 重复投递已见前缀
        events += interceptor.on_chunk(
            self._make_chunk_with_id(
                0, "write_workspace_file", '{"relative_path": "a.md", "content": "hel', None
            )
        )
        events += interceptor.on_chunk(
            self._make_chunk_with_id(0, "write_workspace_file", 'lo"}', None)
        )
        deltas = [e for e in events if e.type == "file_proposal_delta"]
        assert "".join(e.content for e in deltas) == "hello"

    def test_unicode_escape_in_content(self):
        val, closed = _extract_json_string(
            '{"content": "\\u4e2d\\u6587"}', "content"
        )
        assert val == "中文"
        assert closed is True

    def test_unicode_surrogate_pair(self):
        val, _ = _extract_json_string(
            '{"content": "\\ud83d\\ude00"}', "content"
        )
        assert val == "\U0001f600"

    def test_incomplete_unicode_escape_waits_for_more(self):
        # \u 转义被分片截断：解析应暂停，等更多数据后整体重解析
        val, closed = _extract_json_string('{"content": "\\u4e2', "content")
        assert closed is False
        val2, closed2 = _extract_json_string('{"content": "\\u4e2d"}', "content")
        assert val2 == "中"
        assert closed2 is True


class TestDisplayPathNormalization:
    """回归：流式事件与工具结果定稿事件必须产出同一条路径字符串。

    历史 bug：模型把 relative_path 写成绝对路径或带 ./ 前缀时，拦截器
    原样透传，而定稿事件用的是后端归一化后的显示路径，前端按路径匹配
    提案块失败，同一次提案裂成两张卡片，点击各开一个同名 tab。
    """

    def _interceptor(self, workspace_root):
        from app.schemas.agent import ClientContextInput

        return ProposalStreamInterceptor(
            ClientContextInput(workspace_root=str(workspace_root))
        )

    def _feed_write_args(self, interceptor, index, relative_path_value):
        from types import SimpleNamespace

        args = (
            '{"relative_path": "%s", "content": "hello"}' % relative_path_value
        )
        chunk = SimpleNamespace(
            tool_call_chunks=[
                {
                    "index": index,
                    "name": "write_workspace_file",
                    "args": args,
                    "id": "c1",
                }
            ]
        )
        events = interceptor.on_chunk(chunk)
        starts = [e for e in events if e.type == "file_proposal_start"]
        deltas = [e for e in events if e.type == "file_proposal_delta"]
        return starts, deltas

    def test_absolute_path_normalized(self, tmp_path):
        target = tmp_path / "sub"
        target.mkdir()
        interceptor = self._interceptor(tmp_path)
        # 真实模型输出的 JSON 中反斜杠必须转义为 \\
        absolute = str(target / "a.md")
        starts, deltas = self._feed_write_args(
            interceptor, 0, absolute.replace("\\", "\\\\")
        )
        assert len(starts) == 1
        assert starts[0].image_path == "sub/a.md"
        assert all(e.image_path == "sub/a.md" for e in deltas)
        assert interceptor.collected_paths() == {"sub/a.md"}

    def test_dot_slash_prefix_normalized(self, tmp_path):
        interceptor = self._interceptor(tmp_path)
        starts, _ = self._feed_write_args(interceptor, 0, "./a.md")
        assert len(starts) == 1
        assert starts[0].image_path == "a.md"
        assert interceptor.collected_paths() == {"a.md"}

    def test_plain_relative_path_unchanged(self, tmp_path):
        interceptor = self._interceptor(tmp_path)
        starts, _ = self._feed_write_args(interceptor, 0, "docs/a.md")
        assert len(starts) == 1
        assert starts[0].image_path == "docs/a.md"

    def test_no_client_context_falls_back_to_clean_relative(self):
        interceptor = ProposalStreamInterceptor()
        starts, _ = self._feed_write_args(interceptor, 0, ".\\\\docs\\\\a.md")
        assert len(starts) == 1
        assert starts[0].image_path == "docs/a.md"


class TestStrReplaceStreaming:
    """str_replace_workspace_file 的流式：start 提前出卡 + old/new 增量。"""

    def _make_chunk_with_id(self, index, name, args, call_id):
        class MockChunk:
            tool_call_chunks = []
        chunk = MockChunk()
        chunk.tool_call_chunks = [
            {"index": index, "name": name, "args": args, "id": call_id}
        ]
        return chunk

    def _stream_edit_call(
        self, interceptor, index, call_id, rel_path, old, new, pieces=5
    ):
        """把一次完整 str_replace 调用按分片喂给拦截器，返回全部事件。"""
        args = (
            '{"relative_path": "%s", "old_string": "%s", "new_string": "%s"}'
            % (rel_path, old, new)
        )
        step = max(1, len(args) // pieces)
        events = interceptor.on_chunk(
            self._make_chunk_with_id(index, "str_replace_workspace_file", "", call_id)
        )
        for start in range(0, len(args), step):
            events += interceptor.on_chunk(
                self._make_chunk_with_id(
                    index,
                    "str_replace_workspace_file",
                    args[start : start + step],
                    None,
                )
            )
        return events

    def test_start_emitted_with_edit_mode(self):
        interceptor = ProposalStreamInterceptor()
        events = self._stream_edit_call(
            interceptor, 0, "call_1", "a.py", "print(1)", "print(2)"
        )
        starts = [e for e in events if e.type == "file_proposal_start"]
        assert len(starts) == 1
        assert starts[0].image_path == "a.py"
        assert starts[0].mode == "edit"

    def test_old_new_deltas_reassemble(self):
        interceptor = ProposalStreamInterceptor()
        old = "def hello():\\n    print('hello')\\n"
        new = "def hello():\\n    print('hi')\\n"
        events = self._stream_edit_call(
            interceptor, 0, "call_1", "a.py", old, new
        )
        edits = [e for e in events if e.type == "file_edit_delta"]
        assert edits
        joined_old = "".join(e.old_delta or "" for e in edits)
        joined_new = "".join(e.new_delta or "" for e in edits)
        assert joined_old == old.replace("\\n", "\n")
        assert joined_new == new.replace("\\n", "\n")

    def test_collected_paths_and_call_id_map_cover_edits(self):
        interceptor = ProposalStreamInterceptor()
        self._stream_edit_call(
            interceptor, 0, "call_1", "a.py", "old", "new"
        )
        assert interceptor.collected_paths() == {"a.py"}
        assert interceptor.streamed_paths_by_call_id() == {"call_1": "a.py"}

    def test_new_edit_call_reusing_index_resets_state(self):
        """同请求下一轮复用 tc_index 编辑另一文件时不得串路径/吞前缀。"""
        interceptor = ProposalStreamInterceptor()
        self._stream_edit_call(interceptor, 0, "call_1", "a.py", "A" * 30, "B" * 10)
        events = self._stream_edit_call(
            interceptor, 0, "call_2", "b.py", "C" * 40, "D" * 20
        )
        starts = [e for e in events if e.type == "file_proposal_start"]
        assert any(e.image_path == "b.py" for e in starts)
        edits = [e for e in events if e.type == "file_edit_delta"]
        assert all(e.image_path == "b.py" for e in edits)
        assert "".join(e.old_delta or "" for e in edits) == "C" * 40
        assert "".join(e.new_delta or "" for e in edits) == "D" * 20

    def test_lr_agent_edit_suppressed(self):
        interceptor = ProposalStreamInterceptor()
        events = self._stream_edit_call(
            interceptor,
            0,
            "call_1",
            ".lr-agent/memory/progress.md",
            "old",
            "new",
        )
        assert events == []
        assert interceptor.collected_paths() == set()

