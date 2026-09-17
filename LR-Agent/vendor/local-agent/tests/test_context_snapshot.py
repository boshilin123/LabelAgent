"""系统提示与帮助文案：标注入口不泄漏存储路径。"""

from app.agent.context_snapshot import (
    build_assist_system_prompt,
    format_snapshot_for_prompt,
)
from app.agent.tools.help import get_lr_agent_help
from app.schemas.agent import (
    AnnotationProjectSnapshotInput,
    ClientContextInput,
    SkillCatalogEntryInput,
)


def _bbox_snapshot() -> AnnotationProjectSnapshotInput:
    return AnnotationProjectSnapshotInput(
        project_id="p1",
        name="faces",
        modality="image",
        annotation_type="bbox",
        labels=[{"id": "face", "name": "人脸"}],
    )


def _build_prompt(client_context: ClientContextInput) -> str:
    return build_assist_system_prompt(
        client_context,
        model="test-model",
        provider_label="测试",
        supports_vision=False,
    )


def test_snapshot_prompt_does_not_leak_annotation_storage_path() -> None:
    snap = format_snapshot_for_prompt(_bbox_snapshot())
    assert ".lr-agent/annotations" not in snap
    assert "list_workspace_directory" in snap


def test_project_system_prompt_routes_annotation_writes_to_tools() -> None:
    prompt = _build_prompt(
        ClientContextInput(
            workspace_root="/ws",
            agent_mode="annotation",
            annotation_project_snapshot=_bbox_snapshot(),
        )
    )
    assert ".lr-agent/annotations" not in prompt
    assert "auto_annotate" in prompt
    assert "mutate_annotation" in prompt
    assert "explore_readonly" in prompt
    assert "不要用写文件工具保存标注" in prompt
    assert "查已有标注 JSON" not in prompt


def test_annotation_call_guide_only_in_annotation_agent() -> None:
    """自动标注填参纪律只在标注 Agent 的 prompt 里（auto_annotate 也只在那里可用）。"""
    annotation = _build_prompt(
        ClientContextInput(
            workspace_root="/ws",
            agent_mode="annotation",
            annotation_project_snapshot=_bbox_snapshot(),
        )
    )
    assert "【标注调用纪律】" in annotation
    assert "all_files 仅在用户明确要求" in annotation
    assert "replace_matching" in annotation

    # 同一项目但 Ask（只读）：不注入
    ask = _build_prompt(
        ClientContextInput(
            workspace_root="/ws",
            annotation_project_snapshot=_bbox_snapshot(),
        )
    )
    assert "【标注调用纪律】" not in ask

    # 普通工作区：不注入
    workspace = _build_prompt(ClientContextInput(workspace_root="/ws"))
    assert "【标注调用纪律】" not in workspace


def test_fallback_prompt_formats_vision_hint() -> None:
    """兜底分支（无 client_context）也要格式化 vision_hint，不能漏字面量占位符。"""
    prompt = build_assist_system_prompt(
        None,
        model="test-model",
        provider_label="测试",
        supports_vision=False,
    )
    assert "{vision_hint}" not in prompt
    assert "read_image_for_vision" in prompt


def test_proposal_ledger_appended_to_system_prompt() -> None:
    ctx = ClientContextInput(
        workspace_root="/ws",
        proposal_ledger="【未确认提案】未 Keep All，未写盘。\n- annotation pending data/8.jpg append",
    )
    prompt = build_assist_system_prompt(
        ctx,
        model="test-model",
        provider_label="测试",
        supports_vision=False,
    )
    assert "【未确认提案】" in prompt
    assert "data/8.jpg" in prompt


def test_dynamic_blocks_sink_to_bottom_for_prefix_cache() -> None:
    """稳定块（指令、skills）在前，动态块（记忆、台账）沉底，保证前缀缓存命中。"""
    ctx = ClientContextInput(
        workspace_root="/ws",
        project_instructions="优先使用中文回答。",
        workspace_memory_enabled=True,
        memory_index="- progress.md: 标注进度",
        skills_catalog=[SkillCatalogEntryInput(name="demo", description="演示技能")],
        proposal_ledger="【未确认提案】未 Keep All，未写盘。",
    )
    prompt = _build_prompt(ctx)
    instructions_pos = prompt.index("【项目指令】")
    skills_pos = prompt.index("【可用 Skills】")
    memory_pos = prompt.index("【工作区记忆】")
    ledger_pos = prompt.index("【未确认提案】")
    assert instructions_pos < skills_pos < memory_pos < ledger_pos


def test_help_annotation_topic_does_not_leak_storage_path() -> None:
    text = get_lr_agent_help("标注")
    assert ".lr-agent/annotations" not in text
    assert "auto_annotate" in text
    assert "mutate_annotation" in text


def test_editor_ask_prompt_is_readonly() -> None:
    prompt = _build_prompt(
        ClientContextInput(
            workspace_root="/ws",
            work_mode="editor",
            agent_mode="chat",
        )
    )
    assert "编辑器 Ask" in prompt
    assert "禁止调用写文件" in prompt
    assert "write_workspace_file" not in prompt.split("【编辑器模式】")[-1]


def test_editor_agent_prompt_allows_file_writes() -> None:
    prompt = _build_prompt(
        ClientContextInput(
            workspace_root="/ws",
            work_mode="editor",
            agent_mode="annotation",
        )
    )
    assert "编辑器 Agent" in prompt
    assert "write_workspace_file" in prompt
    assert "禁止调用标注" in prompt
