"""测试标注任务阶段状态机：阶段推导、工具级门禁、路径级门禁、阶段提示词。"""

from app.agent.assist.task_phase import (
    TaskPhase,
    blocked_tool_names,
    check_call_allowed,
    coerce_str_list,
    derive_task_phase,
    extract_call_paths,
    phase_prompt_block,
)
from app.schemas.agent import ProposalStateInput


def _state(
    path: str,
    *,
    kind: str = "annotation",
    status: str = "pending",
    operation: str = "append",
) -> ProposalStateInput:
    return ProposalStateInput(
        path=path,
        kind=kind,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        operation=operation,
    )


class TestDeriveTaskPhase:
    def test_none_states_returns_none(self) -> None:
        assert derive_task_phase(None) is None

    def test_empty_states_returns_none(self) -> None:
        assert derive_task_phase([]) is None

    def test_pending_annotation_returns_await_confirm(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg")])
        assert ctx is not None
        assert ctx.phase == TaskPhase.AWAIT_CONFIRM
        assert ctx.pending_annotation_paths == frozenset({"data/2.jpg"})
        assert ctx.gating_enabled

    def test_applied_annotation_returns_verify(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        assert ctx is not None
        assert ctx.phase == TaskPhase.VERIFY
        assert ctx.applied_annotation_paths == frozenset({"data/2.jpg"})
        assert ctx.gating_enabled

    def test_dismissed_only_returns_none(self) -> None:
        assert derive_task_phase([_state("data/2.jpg", status="dismissed")]) is None

    def test_undone_only_returns_none(self) -> None:
        assert derive_task_phase([_state("data/2.jpg", status="undone")]) is None

    def test_pending_file_proposal_ignored(self) -> None:
        """文件提案 pending 不触发标注阶段门禁。"""
        assert derive_task_phase([_state("reports/r.md", kind="file")]) is None

    def test_pending_wins_over_applied(self) -> None:
        ctx = derive_task_phase(
            [
                _state("data/2.jpg", status="applied"),
                _state("data/5.jpg", status="pending"),
            ]
        )
        assert ctx is not None
        assert ctx.phase == TaskPhase.AWAIT_CONFIRM
        assert ctx.pending_annotation_paths == frozenset({"data/5.jpg"})
        assert ctx.applied_annotation_paths == frozenset({"data/2.jpg"})

    def test_paths_normalized(self) -> None:
        ctx = derive_task_phase([_state("./data\\2.jpg")])
        assert ctx is not None
        assert ctx.pending_annotation_paths == frozenset({"data/2.jpg"})


class TestBlockedToolNames:
    def test_no_ctx_no_blocking(self) -> None:
        assert blocked_tool_names(None) == frozenset()

    def test_await_confirm_blocks_all_writes(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg")])
        blocked = blocked_tool_names(ctx)
        assert "auto_annotate" in blocked
        assert "mutate_annotation" in blocked
        assert "write_workspace_file" in blocked
        assert "str_replace_workspace_file" in blocked
        assert "delete_workspace_file" in blocked
        assert "read_file_annotation" not in blocked

    def test_verify_no_tool_level_blocking(self) -> None:
        """verify 阶段只做路径级拦截，不做工具级移除。"""
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        assert blocked_tool_names(ctx) == frozenset()


class TestCheckCallAllowed:
    def test_no_ctx_allows_everything(self) -> None:
        assert check_call_allowed("auto_annotate", {"paths": ["a.jpg"]}, None) is None

    def test_await_confirm_blocks_annotation_write(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg")])
        reason = check_call_allowed(
            "auto_annotate", {"paths": ["data/3.jpg"]}, ctx
        )
        assert reason is not None
        assert "Keep All" in reason

    def test_await_confirm_blocks_workspace_write(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg")])
        assert (
            check_call_allowed(
                "write_workspace_file",
                {"relative_path": "reports/r.md", "content": "x"},
                ctx,
            )
            is not None
        )

    def test_await_confirm_allows_reads(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg")])
        assert (
            check_call_allowed("read_file_annotation", {"relative_path": "data/2.jpg"}, ctx)
            is None
        )
        assert (
            check_call_allowed("read_image_for_vision", {"relative_path": "data/2.jpg"}, ctx)
            is None
        )

    def test_verify_blocks_reannotate_applied_path(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        reason = check_call_allowed(
            "auto_annotate",
            {"paths": ["data/2.jpg"], "user_request": "补标"},
            ctx,
        )
        assert reason is not None
        assert "data/2.jpg" in reason
        # 门禁反馈要求模型转述时给出不一致证据与确切下一步
        assert "不一致" in reason
        assert "重新标注" in reason

    def test_verify_allows_mutate_applied_path(self) -> None:
        """定向修正已落盘文件（带 paths）放行；整文件重标仍走 auto_annotate 拦截。"""
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        assert (
            check_call_allowed(
                "mutate_annotation", {"paths": ["data/2.jpg"]}, ctx
            )
            is None
        )

    def test_verify_allows_new_path_annotation(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        assert (
            check_call_allowed(
                "auto_annotate",
                {"paths": ["data/9.jpg"], "user_request": "补标"},
                ctx,
            )
            is None
        )

    def test_verify_blocks_all_files(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        assert (
            check_call_allowed(
                "auto_annotate",
                {"all_files": True, "user_request": "全量"},
                ctx,
            )
            is not None
        )

    def test_verify_blocks_auto_annotate_without_paths(self) -> None:
        """空 paths/scope_hint 视为未指明范围，拦截。"""
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        reason = check_call_allowed(
            "auto_annotate",
            {"user_request": "补标"},
            ctx,
        )
        assert reason is not None
        assert "paths" in reason

    def test_verify_blocks_mutate_without_paths_and_ids(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        reason = check_call_allowed("mutate_annotation", {"user_request": "改"}, ctx)
        assert reason is not None
        assert "paths" in reason or "annotation_ids" in reason

    def test_verify_allows_mutate_by_applied_annotation_ids(self) -> None:
        """定向修正已落盘标注 id（带 annotation_ids）放行。"""
        from app.schemas.agent import ProposalStateInput

        ctx = derive_task_phase(
            [
                ProposalStateInput(
                    path="data/7.jpg",
                    kind="annotation",
                    status="applied",
                    annotation_ids=["ann-1", "ann-2"],
                )
            ]
        )
        assert (
            check_call_allowed(
                "mutate_annotation",
                {"user_request": "改标签", "annotation_ids": ["ann-1"]},
                ctx,
            )
            is None
        )

    def test_verify_allows_mutate_by_unknown_ids_without_paths(self) -> None:
        """定向修正（annotation_ids 未命中 applied 也无 paths）放行，由前端按 id 落盘。"""
        from app.schemas.agent import ProposalStateInput

        ctx = derive_task_phase(
            [
                ProposalStateInput(
                    path="data/7.jpg",
                    kind="annotation",
                    status="applied",
                    annotation_ids=["ann-1"],
                )
            ]
        )
        assert (
            check_call_allowed(
                "mutate_annotation",
                {"user_request": "改标签", "annotation_ids": ["ann-unknown"]},
                ctx,
            )
            is None
        )

    def test_verify_allows_mutate_by_new_path(self) -> None:
        """用新 paths 修正未落盘文件，放行。"""
        from app.schemas.agent import ProposalStateInput

        ctx = derive_task_phase(
            [
                ProposalStateInput(
                    path="data/7.jpg",
                    kind="annotation",
                    status="applied",
                    annotation_ids=["ann-1"],
                )
            ]
        )
        assert (
            check_call_allowed(
                "mutate_annotation",
                {"user_request": "改标签", "paths": ["data/9.jpg"]},
                ctx,
            )
            is None
        )

    def test_verify_allows_mutate_string_path_not_in_applied(self) -> None:
        """模型把 paths 传成单个字符串时，未落盘文件仍应放行。"""
        ctx = derive_task_phase(
            [
                _state("data/2.jpg", status="applied"),
                _state("data/3.jpg", status="applied"),
                _state("data/7.jpg", status="applied"),
            ]
        )
        assert (
            check_call_allowed(
                "mutate_annotation",
                {"user_request": "修正 4.jpg", "paths": "data/4.jpg"},
                ctx,
            )
            is None
        )

    def test_verify_allows_mutate_json_string_paths_and_ids(self) -> None:
        """模型把 array 序列化成 JSON 字符串时，未落盘目标仍应放行。"""
        ctx = derive_task_phase(
            [
                _state("data/2.jpg", status="applied"),
                _state("data/3.jpg", status="applied"),
                _state("data/7.jpg", status="applied"),
            ]
        )
        assert (
            check_call_allowed(
                "mutate_annotation",
                {
                    "user_request": "修正 4.jpg",
                    "paths": '["data/4.jpg"]',
                    "annotation_ids": (
                        '["a1cf7b82-989e-4d91-b009-e83c0ddbfac0",'
                        ' "a5c8ab25-a442-4f1a-880e-fcf4332a3c18"]'
                    ),
                },
                ctx,
            )
            is None
        )

    def test_verify_allows_mutate_by_ids_with_new_path(self) -> None:
        """annotation_ids 未命中 applied 且带了新 paths，放行。"""
        from app.schemas.agent import ProposalStateInput

        ctx = derive_task_phase(
            [
                ProposalStateInput(
                    path="data/7.jpg",
                    kind="annotation",
                    status="applied",
                    annotation_ids=["ann-1"],
                )
            ]
        )
        assert (
            check_call_allowed(
                "mutate_annotation",
                {
                    "user_request": "改标签",
                    "annotation_ids": ["ann-unknown"],
                    "paths": ["data/9.jpg"],
                },
                ctx,
            )
            is None
        )

    def test_verify_allows_report_write(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        assert (
            check_call_allowed(
                "write_workspace_file",
                {"relative_path": "reports/r.md", "content": "x"},
                ctx,
            )
            is None
        )

    def test_verify_path_matching_normalized(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        assert (
            check_call_allowed(
                "auto_annotate",
                {"paths": ["./data\\2.jpg"], "user_request": "补标"},
                ctx,
            )
            is not None
        )


class TestPhasePromptBlock:
    def test_no_ctx_empty_block(self) -> None:
        assert phase_prompt_block(None) == ""

    def test_await_confirm_block_mentions_paths_and_forbidden(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg")])
        block = phase_prompt_block(ctx)
        assert "data/2.jpg" in block
        assert "禁止" in block
        assert "Keep All" in block

    def test_verify_block_mentions_applied_and_report_rule(self) -> None:
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        block = phase_prompt_block(ctx)
        assert "data/2.jpg" in block
        assert "落盘" in block
        assert "禁止估算" in block
        # 禁止过时的确认引导 + 收尾约束（治 Keep All 后的奇怪措辞）
        assert "禁止再要求用户确认" in block
        assert "不要重复输出报告全文" in block


class TestExtractCallPaths:
    def test_paths_list(self) -> None:
        assert extract_call_paths({"paths": ["a.jpg", " b.jpg "]}) == frozenset(
            {"a.jpg", "b.jpg"}
        )

    def test_scope_hint_fallback(self) -> None:
        assert extract_call_paths({"scope_hint": "data/, a.jpg"}) == frozenset(
            {"data/", "a.jpg"}
        )

    def test_empty_arguments(self) -> None:
        assert extract_call_paths({}) == frozenset()

    def test_all_files_string_blocked(self) -> None:
        """模型把 all_files 传成字符串 \"true\" 时同样拦截全量重标。"""
        ctx = derive_task_phase([_state("data/2.jpg", status="applied")])
        reason = check_call_allowed(
            "auto_annotate",
            {"all_files": "true", "user_request": "全量"},
            ctx,
        )
        assert reason is not None
        assert "all_files" in reason

    def test_json_string_array(self) -> None:
        assert extract_call_paths({"paths": '["data/4.jpg"]'}) == frozenset(
            {"data/4.jpg"}
        )

    def test_single_path_string(self) -> None:
        assert extract_call_paths({"paths": "data/4.jpg"}) == frozenset(
            {"data/4.jpg"}
        )


class TestCoerceStrList:
    def test_list_passthrough(self) -> None:
        assert coerce_str_list([" a ", "b"]) == ["a", "b"]

    def test_json_array_string(self) -> None:
        assert coerce_str_list('["data/4.jpg", "data/5.jpg"]') == [
            "data/4.jpg",
            "data/5.jpg",
        ]

    def test_single_string(self) -> None:
        assert coerce_str_list("data/4.jpg") == ["data/4.jpg"]

    def test_does_not_split_uuid_string_into_chars(self) -> None:
        uid = "a1cf7b82-989e-4d91-b009-e83c0ddbfac0"
        assert coerce_str_list(uid) == [uid]

    def test_none_and_empty(self) -> None:
        assert coerce_str_list(None) == []
        assert coerce_str_list("") == []
        assert coerce_str_list("  ") == []
