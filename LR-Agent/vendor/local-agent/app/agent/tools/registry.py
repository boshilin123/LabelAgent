"""Assist 模式工具注册表。

由 orchestrator 调用 build_tools_p1 构建工具列表，assist_service 通过 tool_fn_map 按名称执行。
工具分三类：
  - 上下文查询：账户、帮助、界面状态、标注项目快照
  - 文件读取/写入：文本/代码、文档、图片（视觉）、已有标注 JSON、写文件提案
  - 异步工具（ASYNC_TOOL_NAMES）：由前端 Electron 执行；调度器发出 tool_pending SSE 并暂停 loop
"""

import json
from collections.abc import Callable
from typing import Any, Literal

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.agent.tools.tool_registry_meta import (
    TOOL_CAPABILITY_MAP,
    ToolCapability,
)

from app.agent.annotation.annotation_doc_reader import read_file_annotation_doc
from app.agent.context_helpers import project_directory
from app.agent.context_snapshot import format_snapshot_for_prompt
from app.agent.tools.help import get_lr_agent_help
from app.agent.tools.workspace_file_reader import (
    read_document_file,
    read_image_for_vision_tool,
    read_workspace_text_file,
    str_replace_workspace_file_tool,
    delete_workspace_file_tool,
    move_workspace_file_tool,
    write_workspace_file_tool,
)
from app.agent.tools.workspace_search import (
    glob_workspace,
    grep_workspace,
    list_workspace_directory,
)
from app.core.config import Settings
from app.models.user import User
from app.schemas.agent import ClientContextInput

ANNOTATION_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "describe_annotation_project",
        "read_file_annotation",
        "auto_annotate",
        "mutate_annotation",
    }
)


# Pydantic args_schema for client tools — forces LLM to include user_request as a required param
def _strip_titles(node: Any) -> Any:
    """递归剥掉 JSON schema 里的 title：pydantic 自动生成，键名已表达同一语义。"""
    if isinstance(node, dict):
        node.pop("title", None)
        for value in node.values():
            _strip_titles(value)
    elif isinstance(node, list):
        for value in node:
            _strip_titles(value)
    return node


class SlimArgsModel(BaseModel):
    """工具参数基类：schema 不带 title（每字段省 ~30 字符的工具前缀）。"""

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict:
        return _strip_titles(super().model_json_schema(*args, **kwargs))


# 字段描述只写参数语义；「何时填」的行为纪律在标注模式的系统提示块里
# （context_snapshot.ANNOTATION_CALL_GUIDE），避免为每个工具调用重复携带。
class AutoAnnotateArgs(SlimArgsModel):
    user_request: str = Field(
        min_length=1,
        description="本轮标注任务说明（按用户意图归纳）",
    )
    paths: list[str] = Field(
        default_factory=list,
        description="要标注的相对路径，取自 list_workspace_directory 的 relativePath；目录以 / 结尾",
    )
    all_files: bool = Field(
        default=False,
        description="是否标注整个项目全部文件（仅用户明确要求时为 true）",
    )
    write_mode: Literal["append", "replace_matching"] = Field(
        default="append",
        description="append 追加新标注；replace_matching 替换同类型已有标注",
    )
    scope_hint: str | None = Field(
        default=None,
        description="兼容旧参数：逗号分隔的相对路径，优先使用 paths",
    )
    conf_threshold: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="检测置信度阈值（0-1），用户明确给出时填",
    )
    iou_threshold: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="检测 NMS IoU 阈值（0-1），用户明确给出时填",
    )
    model_id: str | None = Field(
        default=None,
        description="指定检测模型 id，仅用户点名模型时填",
    )
    include_classes: list[str] | None = Field(
        default=None,
        description='只保留这些检测类名的框（如 ["person"]）',
    )
    exclude_classes: list[str] | None = Field(
        default=None,
        description="排除这些检测类名的框",
    )
    use_vision_mapping: bool | None = Field(
        default=None,
        description="是否用视觉模型把检测框映射到项目标签；留空由系统决定",
    )


class MutateAnnotationArgs(SlimArgsModel):
    user_request: str = Field(min_length=1, description="必须原样传递用户的原始请求")
    paths: list[str] | None = Field(
        default=None,
        description="要修改的文件相对路径。有明确文件时必须填写。",
    )
    annotation_ids: list[str] | None = Field(
        default=None,
        description="画布选中或用户指定的标注 id。",
    )


class StrReplaceArgs(SlimArgsModel):
    relative_path: str = Field(min_length=1, description="要修改的相对路径")
    old_string: str = Field(min_length=1, description="文件中必须唯一出现的原文片段")
    new_string: str = Field(description="替换后的文本")
    replace_all: bool = Field(
        default=False,
        description="为 true 时替换全部出现；默认要求 old_string 只出现一次",
    )


class DeleteWorkspaceFileArgs(SlimArgsModel):
    relative_path: str = Field(min_length=1, description="要删除的相对路径")


class MoveWorkspaceFileArgs(SlimArgsModel):
    relative_path: str = Field(min_length=1, description="原相对路径")
    new_relative_path: str = Field(
        min_length=1,
        description="新相对路径（同目录改名为重命名，跨目录为移动）",
    )


class ExploreReadonlyArgs(SlimArgsModel):
    query: str = Field(min_length=1, description="要查阅的问题或目标")
    focus_path: str | None = Field(
        default=None,
        description="可选，优先查阅的相对路径或目录",
    )


def _explore_readonly_stub(query: str, focus_path: str | None = None) -> str:
    return json.dumps(
        {
            "ok": False,
            "tool": "explore_readonly",
            "status": "error",
            "summary": "explore_readonly 必须由编排层执行",
        },
        ensure_ascii=False,
    )


def _client_tool_stub(tool_name: str) -> StructuredTool:
    """返回一个客户端工具的 schema 存根（func 不会被本地调用）。"""
    # assist_service 在执行工具前会先检测 CLIENT_TOOL_NAMES，拦截并发出 tool_pending
    def _unreachable(**_kwargs: object) -> str:  # noqa: ANN001
        return f"[{tool_name}] 此工具应由前端执行，本地调用不应发生。"
    _unreachable.__name__ = tool_name
    return _unreachable


def build_tools_p1(
    user: User,
    client_context: ClientContextInput | None,
    *,
    settings: Settings,
    provider_is_vision: bool = False,
) -> list[StructuredTool]:
    """构建完整工具集（向后兼容别名）。"""
    return _build_all_tools(user, client_context, settings=settings, provider_is_vision=provider_is_vision)


def build_tools_by_name_set(
    user: User,
    client_context: ClientContextInput | None,
    tool_set: frozenset[str],
    *,
    settings: Settings,
    provider_is_vision: bool = False,
) -> list[StructuredTool]:
    """构建指定名称的工具子集。"""
    all_tools = _build_all_tools(user, client_context, settings=settings, provider_is_vision=provider_is_vision)
    return [t for t in all_tools if t.name in tool_set]


def _build_all_tools(
    user: User,
    client_context: ClientContextInput | None,
    *,
    settings: Settings,
    provider_is_vision: bool = False,
) -> list[StructuredTool]:
    """构建工具集：只读工具 + 写文件提案工具 + 客户端工具 schema 存根。"""
    # 本轮请求内未落盘提案的内容接力（见 workspace_file_reader.PendingProposalContents），
    # 工具集每次请求重建，缓存生命周期即一轮。
    pending_proposals: dict[str, tuple[str | None, str]] = {}

    def account_summary() -> str:
        # 本地无状态模式（agent.py 注入匿名用户）：如实说明，不展示占位账户
        if user.username == "anonymous" and str(user.email).endswith("@local"):
            return (
                "本地模式：LR-Agent 本地服务无云端账户体系，"
                "对话、标注与配置均保存在本机。"
            )
        verified = "已验证" if user.email_verified else "未验证"
        name = user.display_name or user.username or "未设置"
        return (
            f"邮箱: {user.email} ({verified})\n"
            f"显示名: {name}\n"
            f"用户名: {user.username or '未设置'}"
        )

    def describe_context() -> str:
        if client_context is None:
            return "客户端未提供当前界面上下文。"
        parts: list[str] = []
        if client_context.workspace_root:
            parts.append(f"工作区根目录: {client_context.workspace_root}")
        if client_context.active_file_path:
            parts.append(f"当前打开文件: {client_context.active_file_path}")
        if client_context.active_relative_path:
            parts.append(f"当前打开文件（相对路径）: {client_context.active_relative_path}")
        if client_context.active_annotation_project_id:
            parts.append(f"当前标注项目 ID: {client_context.active_annotation_project_id}")
        if client_context.annotation_project_modality:
            parts.append(f"任务模态: {client_context.annotation_project_modality}")
        if client_context.annotation_project_type:
            parts.append(f"标注类型: {client_context.annotation_project_type}")
        if client_context.agent_mode:
            parts.append(f"交互模式: {client_context.agent_mode}")
        if client_context.work_mode:
            parts.append(f"工作模式: {client_context.work_mode}")
        if not parts:
            return "工作区已连接，但未打开具体文件或标注项目。"
        return "\n".join(parts)

    def describe_annotation_project() -> str:
        if client_context is None or client_context.annotation_project_snapshot is None:
            return "当前未绑定标注项目快照。请确认用户已在标注任务中打开项目。"
        return format_snapshot_for_prompt(client_context.annotation_project_snapshot)

    def help_tool(topic: str | None = None) -> str:
        return get_lr_agent_help(topic)

    def read_file_annotation(
        relative_path: str,
        annotation_offset: int = 0,
        annotation_limit: int = 200,
    ) -> str:
        project_dir = project_directory(client_context)
        if not project_dir:
            return "无法读取标注：未绑定项目目录。请确认已在标注任务中打开项目。"
        doc, err = read_file_annotation_doc(project_dir, relative_path)
        if doc is None:
            return err or "未找到标注。"

        note = ""
        annotations = doc.get("annotations")
        if isinstance(annotations, list):
            total = len(annotations)
            start = max(0, annotation_offset)
            limit = max(1, min(annotation_limit, 500))
            end = min(start + limit, total)
            if start > 0 or end < total:
                doc = {**doc, "annotations": annotations[start:end]}
                note = (
                    f"（共 {total} 条标注，当前返回第 {start + 1}-{end} 条；"
                    "可用 annotation_offset/annotation_limit 分页读取其余）\n"
                )

        text = json.dumps(doc, ensure_ascii=False, indent=2)
        if len(text) > 40_000:
            text = (
                text[:40_000]
                + "\n…[结果已截断，请用 annotation_offset/annotation_limit 分页读取]"
            )
        return note + text

    def read_workspace_file(
        relative_path: str = "",
        start_line: int | None = None,
        end_line: int | None = None,
    ) -> str:
        return read_workspace_text_file(
            client_context,
            relative_path,
            settings=settings,
            start_line=start_line,
            end_line=end_line,
        )

    def grep_tool(
        pattern: str,
        path: str = "",
        glob_pattern: str = "*",
        case_insensitive: bool = False,
    ) -> str:
        return grep_workspace(
            client_context,
            pattern,
            path=path,
            glob_pattern=glob_pattern,
            case_insensitive=case_insensitive,
            settings=settings,
        )

    def list_directory_tool(relative_dir: str = "") -> str:
        return list_workspace_directory(
            client_context,
            relative_dir,
            settings=settings,
        )

    def glob_tool(glob_pattern: str, relative_dir: str = "") -> str:
        return glob_workspace(
            client_context,
            glob_pattern,
            relative_dir=relative_dir,
            settings=settings,
        )

    def read_image_for_vision(relative_path: str = "") -> str:
        return read_image_for_vision_tool(
            client_context,
            relative_path,
            provider_is_vision=provider_is_vision,
        )

    def read_document(relative_path: str = "") -> str:
        return read_document_file(client_context, relative_path, settings=settings)

    def write_file(relative_path: str, content: str) -> str:
        return write_workspace_file_tool(
            client_context, relative_path, content, pending_proposals
        )

    def str_replace_file(
        relative_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> str:
        return str_replace_workspace_file_tool(
            client_context,
            relative_path,
            old_string,
            new_string,
            replace_all=replace_all,
            pending_proposals=pending_proposals,
        )

    def delete_file(relative_path: str) -> str:
        return delete_workspace_file_tool(
            client_context, relative_path, pending_proposals
        )

    def move_file(relative_path: str, new_relative_path: str) -> str:
        return move_workspace_file_tool(
            client_context, relative_path, new_relative_path, pending_proposals
        )

    # Phase 1 工具集（只读 + 写文件提案）
    tools = [
        StructuredTool.from_function(
            func=account_summary,
            name="get_account_summary",
            description="获取当前登录用户的账户摘要（邮箱、验证状态、显示名）",
        ),
        StructuredTool.from_function(
            func=help_tool,
            name="get_lr_agent_help",
            description="获取 LR-Agent 应用功能说明，可选 topic 关键词",
        ),
        StructuredTool.from_function(
            func=describe_context,
            name="describe_client_context",
            description="描述用户当前 Electron 客户端界面上下文（工作区、打开文件、标注项目）",
        ),
        StructuredTool.from_function(
            func=describe_annotation_project,
            name="describe_annotation_project",
            description="获取当前标注项目的标签树、任务类型、模态与可用检测模型列表",
        ),
        StructuredTool.from_function(
            func=read_file_annotation,
            name="read_file_annotation",
            description=(
                "读取项目中某文件的已有标注（相对路径，如 data/2.jpg）。"
                "标注较多时可用 annotation_offset/annotation_limit 分页（默认返回前 200 条）。"
                "只读查询，不要用写文件工具回写。"
            ),
        ),
        StructuredTool.from_function(
            func=read_workspace_file,
            name="read_workspace_file",
            description=(
                "读取工作区或项目内的文本/代码文件内容（如 .py .ts .md .json .yaml .txt）。"
                "relative_path 为空时使用当前打开文件。"
                "可选 start_line / end_line（1-indexed，含首尾）读取指定行范围。"
                "返回内容带行号前缀（如 `    12|code`）。"
                "找代码时建议先用 grep_workspace 或 glob_workspace 定位，再读本工具读具体行。"
            ),
        ),
        StructuredTool.from_function(
            func=grep_tool,
            name="grep_workspace",
            description=(
                "在工作区内按正则搜索代码/文本，返回 path:line: content 格式。"
                "找定义、引用、符号时优先使用；命中后再对具体文件调用 read_workspace_file。"
                "pattern 为正则；path 为相对目录或文件（空=整个工作区）；"
                "glob_pattern 可选如 *.py、*.ts。"
            ),
        ),
        StructuredTool.from_function(
            func=glob_tool,
            name="glob_workspace",
            description=(
                "按 glob 递归列出工作区文件（如 **/*.py、src/**/*.ts）。"
                "relative_dir 为空时从工作区根开始。跳过 .git / node_modules / .lr-agent。"
                "找文件路径时优先于反复 list_workspace_directory。"
            ),
        ),
        StructuredTool.from_function(
            func=list_directory_tool,
            name="list_workspace_directory",
            description=(
                "列出工作区目录下的文件与子目录（name | kind | relativePath）。"
                "relative_dir 为空时列出工作区根；用于了解项目结构。"
            ),
        ),
        StructuredTool.from_function(
            func=read_image_for_vision,
            name="read_image_for_vision",
            description=(
                "加载图片并在调用成功后由系统注入附图，供你直接根据像素回答"
                "（场景、物体、人数、文字 OCR、外观等）。relative_path 为空时使用当前打开的图片。"
                "需视觉探针通过；查已有标注请用 read_file_annotation，勿用本工具代替。"
            ),
        ),
        StructuredTool.from_function(
            func=read_document,
            name="read_document_file",
            description=(
                "提取 PDF 或 DOCX 文档正文。"
                "relative_path 为空时使用当前打开的文件。"
            ),
        ),
        StructuredTool.from_function(
            func=write_file,
            name="write_workspace_file",
            description=(
                "在工作区内创建或覆写文本/代码文件（如 .md .py .ts）。"
                "生成提案，用户 Keep All 后才落盘。"
                "只用于工作区文档与代码，不能用来保存标注。"
                "删文件请用 delete_workspace_file，不要写入空内容；"
                "移动/重命名文件请用 move_workspace_file。"
            ),
        ),
        StructuredTool.from_function(
            func=str_replace_file,
            name="str_replace_workspace_file",
            description=(
                "对已有文本/代码文件做精确片段替换。"
                "old_string 必须在文件中唯一出现，除非 replace_all=true。"
                "改局部代码时优先用本工具。不能用来改标注。"
            ),
            args_schema=StrReplaceArgs,
        ),
        StructuredTool.from_function(
            func=delete_file,
            name="delete_workspace_file",
            description=(
                "删除工作区内的文本/代码文件，生成删除提案。"
                "用户确认 Keep All 后才从磁盘移除。不能删除标注。"
            ),
            args_schema=DeleteWorkspaceFileArgs,
        ),
        StructuredTool.from_function(
            func=move_file,
            name="move_workspace_file",
            description=(
                "移动或重命名工作区内的文本/代码文件，生成移动提案。"
                "用户确认 Keep All 后才在磁盘执行。"
                "禁止用「读出内容再写到新路径」来移动文件。"
            ),
            args_schema=MoveWorkspaceFileArgs,
        ),
        # ── 客户端工具（schema 存根，实现体在前端 Electron 进程）────────────
        StructuredTool.from_function(
            func=_client_tool_stub("auto_annotate"),
            name="auto_annotate",
            description=(
                "新增或重写当前项目的自动标注（检测、预标注、生成 caption 等）；"
                "改已有框/标签用 mutate_annotation。填参规则见系统提示的标注调用纪律。"
            ),
            args_schema=AutoAnnotateArgs,
        ),
        StructuredTool.from_function(
            func=_client_tool_stub("mutate_annotation"),
            name="mutate_annotation",
            description=(
                "修改或删除已有标注（改标签、删框、改 caption 等）。"
                "不含新增；新增请用 auto_annotate。"
            ),
            args_schema=MutateAnnotationArgs,
        ),
        StructuredTool.from_function(
            func=_explore_readonly_stub,
            name="explore_readonly",
            description=(
                "只读查阅子代理：在工作区内搜索/阅读代码与文档"
                "（标注任务还可读已有标注），返回中文摘要。"
                "大范围摸底时使用。query 描述要查什么；focus_path 可选，缩小范围。"
                "本工具不会改文件或写标注；标注与写文件必须由你直接调用对应工具。"
            ),
            args_schema=ExploreReadonlyArgs,
        ),
    ]

    if client_context and client_context.work_mode == "editor":
        tools = [tool for tool in tools if tool.name not in ANNOTATION_TOOL_NAMES]

    # 断言：每个工具对应唯一 capability（防御 MCP 或 registry 错误注入同一能力多次）
    _capability_seen: set[str] = set()
    for t in tools:
        cap = TOOL_CAPABILITY_MAP.get(t.name)
        if cap is not None:
            # QUERY_CONTEXT 允许多个工具（账户、帮助、上下文查询共享）
            if cap != ToolCapability.QUERY_CONTEXT:
                assert cap not in _capability_seen, (
                    f"工具能力冲突: {t.name} 的能力 {cap.value} 已由另一工具提供"
                )
                _capability_seen.add(cap)

    return tools


def _async_structured_caller(tool: StructuredTool) -> Callable[..., Any]:
    """MCP 等仅有 coroutine 的工具：经 ainvoke 执行，保留 content_and_artifact 处理。"""

    async def _call(**kwargs: Any) -> Any:
        return await tool.ainvoke(kwargs)

    _call.__name__ = tool.name
    return _call


def tool_fn_map(tools: list[StructuredTool]) -> dict[str, Callable[..., Any]]:
    """将 StructuredTool 列表转为 name → 可调用映射，供 assist_service 本地执行。

    本地工具走 sync ``func``；langchain-mcp-adapters 转换的工具只有 ``coroutine``，
    仍需纳入映射，否则 bind_tools 可见、执行时变成「未知工具」。
    """
    mapping: dict[str, Callable[..., Any]] = {}
    for tool in tools:
        if tool.func is not None:
            mapping[tool.name] = tool.func
        elif tool.coroutine is not None:
            mapping[tool.name] = _async_structured_caller(tool)
    return mapping
