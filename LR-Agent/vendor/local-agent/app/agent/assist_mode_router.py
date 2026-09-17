"""Assist 模式路由器：基于客户端上下文决定运行模式与工具集。

三种模式:
  - FULL:  完整工具集（标注、分析、写文件、读文件、视觉）— 标注项目内
  - LIGHT: 只读工具 + write_workspace_file（报告、文档、问答）— 编辑器 / 工作区
  - CHAT:  纯对话，无工具（由 chat_service 处理，不经过 assist）
"""

# 每种模式的工具白名单。
# get_account_summary / describe_client_context 不注入主 Agent：前者在本地应用里无用，
# 后者要的信息 system prompt 已注入，二者的 schema 只是白占前缀并诱发无关调用。
# 两者仍在 registry 注册，子代理 explore_readonly 内部可用（见 explore_readonly.py）。
LIGHT_TOOL_SET: frozenset[str] = frozenset({
    "read_workspace_file",
    "grep_workspace",
    "glob_workspace",
    "list_workspace_directory",
    "read_document_file",
    "read_image_for_vision",
    "write_workspace_file",
    "str_replace_workspace_file",
    "delete_workspace_file",
    "move_workspace_file",
    "get_lr_agent_help",
    "describe_annotation_project",
    "read_file_annotation",
    "explore_readonly",
})

FULL_TOOL_SET: frozenset[str] = frozenset({
    "read_workspace_file",
    "grep_workspace",
    "glob_workspace",
    "list_workspace_directory",
    "read_document_file",
    "read_image_for_vision",
    "write_workspace_file",
    "str_replace_workspace_file",
    "delete_workspace_file",
    "move_workspace_file",
    "auto_annotate",
    "mutate_annotation",
    "get_lr_agent_help",
    "describe_annotation_project",
    "read_file_annotation",
    "explore_readonly",
})

WRITE_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "auto_annotate",
        "mutate_annotation",
        "write_workspace_file",
        "str_replace_workspace_file",
        "delete_workspace_file",
        "move_workspace_file",
    }
)

# Ask 模式：有项目快照也只读，禁止标注写入与工作区写文件
ASK_TOOL_SET: frozenset[str] = FULL_TOOL_SET - WRITE_TOOL_NAMES


def resolve_assist_tool_set(
    *,
    has_project_snapshot: bool,
    agent_mode: str | None,
    is_editor: bool,
    has_workspace: bool,
) -> frozenset[str]:
    """Ask / 缺失模式一律只读；Agent 仅在标注任务（有快照且非编辑器）给完整工具。"""
    has_context = has_project_snapshot or is_editor or has_workspace
    if agent_mode != "annotation":
        return ASK_TOOL_SET if has_context else frozenset()
    if has_project_snapshot and not is_editor:
        return FULL_TOOL_SET
    if is_editor or has_workspace:
        return LIGHT_TOOL_SET
    return frozenset()
