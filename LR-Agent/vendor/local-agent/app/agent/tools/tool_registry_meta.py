# 学习导航：工具执行归属的统一登记处。SYNC/PROPOSAL/ASYNC 是业务分类，不是 Python def/async def 语法分类。
"""工具注册元数据：runner 类型、能力分类与副作用分类（Agent 调度单一真相源）。"""

from __future__ import annotations

from enum import Enum


# SYNC 由后端处理结果；PROPOSAL 由后端准备变更待确认；ASYNC 暂停回合交客户端执行。
class ToolRunner(str, Enum):
    """工具执行器类型。"""

    SYNC = "sync"  # 本轮在后端同步执行完毕
    PROPOSAL = "proposal"  # 后端校验并生成提案 SSE，落盘由 Electron 确认
    ASYNC = "async"  # 暂停 loop，由 Electron 执行后 resume


# 描述工具提供的能力，供本地与外部工具合并时参考。
class ToolCapability(str, Enum):
    """工具能力抽象——每个经典工具对应一个唯一能力，防止双轨制。"""

    READ_TEXT_FILE = "read_text_file"
    READ_DOCUMENT = "read_document"
    READ_IMAGE_VISION = "read_image_vision"
    READ_ANNOTATION_JSON = "read_annotation_json"
    WRITE_FILE = "write_file"
    STR_REPLACE_FILE = "str_replace_file"
    DELETE_FILE = "delete_file"
    MOVE_FILE = "move_file"
    AUTO_ANNOTATE = "auto_annotate"
    MUTATE_ANNOTATION = "mutate_annotation_cap"
    RUN_TERMINAL_COMMAND = "run_terminal_command"
    QUERY_CONTEXT = "query_context"
    GREP_WORKSPACE = "grep_workspace"
    GLOB_WORKSPACE = "glob_workspace"
    LIST_DIRECTORY = "list_directory"
    EXPLORE_READONLY = "explore_readonly"


# 内置工具 → 唯一能力映射
TOOL_CAPABILITY_MAP: dict[str, ToolCapability] = {
    "read_workspace_file": ToolCapability.READ_TEXT_FILE,
    "grep_workspace": ToolCapability.GREP_WORKSPACE,
    "glob_workspace": ToolCapability.GLOB_WORKSPACE,
    "list_workspace_directory": ToolCapability.LIST_DIRECTORY,
    "read_document_file": ToolCapability.READ_DOCUMENT,
    "read_image_for_vision": ToolCapability.READ_IMAGE_VISION,
    "read_file_annotation": ToolCapability.READ_ANNOTATION_JSON,
    "write_workspace_file": ToolCapability.WRITE_FILE,
    "str_replace_workspace_file": ToolCapability.STR_REPLACE_FILE,
    "delete_workspace_file": ToolCapability.DELETE_FILE,
    "move_workspace_file": ToolCapability.MOVE_FILE,
    "auto_annotate": ToolCapability.AUTO_ANNOTATE,
    "mutate_annotation": ToolCapability.MUTATE_ANNOTATION,
    "start_terminal_command": ToolCapability.RUN_TERMINAL_COMMAND,
    "get_account_summary": ToolCapability.QUERY_CONTEXT,
    "get_lr_agent_help": ToolCapability.QUERY_CONTEXT,
    "describe_client_context": ToolCapability.QUERY_CONTEXT,
    "describe_annotation_project": ToolCapability.QUERY_CONTEXT,
    "explore_readonly": ToolCapability.EXPLORE_READONLY,
}

# 所有内置工具的能力集合
CANONICAL_CAPABILITIES: frozenset[ToolCapability] = frozenset(TOOL_CAPABILITY_MAP.values())


# 内置工具 runner 映射（MCP 动态工具默认 SYNC，且不与下列重名注入）
TOOL_RUNNERS: dict[str, ToolRunner] = {
    "get_account_summary": ToolRunner.SYNC,
    "get_lr_agent_help": ToolRunner.SYNC,
    "describe_client_context": ToolRunner.SYNC,
    "describe_annotation_project": ToolRunner.SYNC,
    "read_file_annotation": ToolRunner.SYNC,
    "read_workspace_file": ToolRunner.SYNC,
    "grep_workspace": ToolRunner.SYNC,
    "glob_workspace": ToolRunner.SYNC,
    "list_workspace_directory": ToolRunner.SYNC,
    "read_image_for_vision": ToolRunner.SYNC,
    "read_document_file": ToolRunner.SYNC,
    "write_workspace_file": ToolRunner.PROPOSAL,
    "str_replace_workspace_file": ToolRunner.PROPOSAL,
    "delete_workspace_file": ToolRunner.PROPOSAL,
    "move_workspace_file": ToolRunner.PROPOSAL,
    "auto_annotate": ToolRunner.ASYNC,
    "mutate_annotation": ToolRunner.ASYNC,
    # 本地 MCP 的终端工具：执行前需用户聊天内批准，由 Electron pending→resume 驱动
    "start_terminal_command": ToolRunner.ASYNC,
    "explore_readonly": ToolRunner.SYNC,
}

# 不与 MCP 重复暴露的本地实现工具名
LOCAL_CANONICAL_TOOL_NAMES: frozenset[str] = frozenset(TOOL_RUNNERS.keys())

ASYNC_TOOL_NAMES: frozenset[str] = frozenset(
    name for name, runner in TOOL_RUNNERS.items() if runner is ToolRunner.ASYNC
)

# 向后兼容别名
CLIENT_TOOL_NAMES = ASYNC_TOOL_NAMES


# 按工具名查执行类型；未特别登记的动态工具默认按后端 SYNC 类处理。
def get_tool_runner(name: str) -> ToolRunner:
    return TOOL_RUNNERS.get(name, ToolRunner.SYNC)


# 判断工具是否需要 pending 给客户端；返回 True 不表示该 Python 函数只是一个普通协程。
def is_async_tool(name: str) -> bool:
    return get_tool_runner(name) is ToolRunner.ASYNC


# 判断工具是否只准备文件变更提案，便于轮末结束并等待确认。
def is_proposal_tool(name: str) -> bool:
    return get_tool_runner(name) is ToolRunner.PROPOSAL
