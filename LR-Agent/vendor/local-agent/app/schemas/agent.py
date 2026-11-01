# 学习导航：聊天 Agent 的输入/输出数据结构。BaseModel 负责字段解析与校验，本文件本身不调用模型。
# 建议先看 LocalChatStreamRequest → ClientContextInput → StreamEventPayload，再对照 HTTP 与运行时使用位置。
from typing import Any, Literal

from pydantic import BaseModel, Field


# 历史 AI 消息中的一次工具调用，id 用来与后续工具结果配对，name 用来定位工具，args 是参数。
class ChatToolCallInput(BaseModel):
    """OpenAI 兼容的 assistant tool_call，用于 resume 还原本轮工具对话。"""

    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=128)
    # default_factory 为每个请求对象新建字典，避免不同对象意外共用同一个可变容器。
    args: dict[str, Any] = Field(default_factory=dict)


# 一条请求历史消息；role 决定转换成哪种 LangChain 消息，tool 角色需要 tool_call_id。
class ChatMessageInput(BaseModel):
    role: Literal["user", "assistant", "system", "tool"]
    content: str = ""
    message_id: str | None = None
    interaction_mode: Literal["chat", "annotation"] | None = None
    tool_calls: list[ChatToolCallInput] | None = None
    tool_call_id: str | None = Field(
        default=None,
        description="role=tool 时对应的 tool_call id。",
    )


# 本次请求附带的项目快照，提供任务类型、标签及可用检测模型，不在本地服务查云端项目表。
class AnnotationProjectSnapshotInput(BaseModel):
    project_id: str = Field(min_length=1, max_length=64)
    name: str = ""
    modality: str = ""
    annotation_type: str = ""
    labels: list[dict[str, Any]] = Field(default_factory=list)
    detection_models: list[dict[str, Any]] = Field(default_factory=list)
    project_directory_path: str | None = None


# 技能目录的简要条目，只包含名称和简介，完整技能内容按需获取。
class SkillCatalogEntryInput(BaseModel):
    """全局 Agent Skill 目录条目（catalog，仅 name + description 注入 prompt）。"""

    name: str = Field(min_length=1, max_length=128)
    description: str = Field(max_length=512)


# 客户端回传的单个提案状态，后端据此推导等待确认或核验阶段。
class ProposalStateInput(BaseModel):
    """会话中单个提案变更的结构化状态（由前端消息块构建，随请求发送）。"""

    path: str = Field(min_length=1, description="提案涉及的相对路径")
    kind: Literal["annotation", "file"] = "annotation"
    status: Literal["pending", "applied", "dismissed", "undone"] = "pending"
    operation: str | None = None
    annotation_ids: list[str] = Field(
        default_factory=list,
        description="该提案涉及的标注实例 id（append/replace 的 annotations、delete 的 deleteIds、patch 的 patches）",
    )


# 一个远程 MCP 连接的配置，包含端点、协议、请求头与禁用工具名。
class McpServerInput(BaseModel):
    """用户配置的远程 MCP Server（前端 userData/mcp.json 中已启用项，随 client_context 注入）。"""

    id: str = Field(min_length=1, max_length=64)
    url: str = Field(min_length=1)
    transport: Literal["streamable_http", "sse"] = "streamable_http"
    headers: dict[str, str] = Field(default_factory=dict)
    disabled_tools: list[str] = Field(default_factory=list)


# 测试 MCP 连接所需参数，不需要聊天模型配置。
class McpProbeRequest(BaseModel):
    """测试连接单个 MCP Server（配置页使用，不走 LLM）。"""

    url: str = Field(min_length=1)
    transport: Literal["streamable_http", "sse"] = "streamable_http"
    headers: dict[str, str] = Field(default_factory=dict)


# 客户端当前工作区与标注背景，以及项目说明、技能、记忆开关和提案状态。
class ClientContextInput(BaseModel):
    # 这些路径描述调用方当前工作环境；真正读取前还要经过工作区路径校验。
    workspace_root: str | None = None
    active_file_path: str | None = None
    active_relative_path: str | None = None
    project_directory_path: str | None = None
    active_annotation_project_id: str | None = None
    annotation_project_modality: str | None = None
    annotation_project_type: str | None = None
    # agent_mode 控制聊天/标注工具范围，work_mode 描述编辑器或标注界面场景。
    agent_mode: Literal["chat", "annotation"] | None = None
    work_mode: Literal["editor", "annotation"] | None = None
    selected_annotation_id: str | None = None
    selected_annotation_ids: list[str] = Field(default_factory=list)
    annotation_project_snapshot: AnnotationProjectSnapshotInput | None = None
    # mcp_server_url/token 是本机 MCP 配置，mcp_servers 是独立的远程服务列表。
    mcp_server_url: str | None = None
    mcp_server_token: str | None = None
    mcp_servers: list[McpServerInput] = Field(default_factory=list)
    project_instructions: str | None = None
    memory_index: str | None = None
    # 工作区记忆是经工具访问的业务内容，不等于 LangGraph 的 Store 或运行检查点。
    workspace_memory_enabled: bool = False
    skills_catalog: list[SkillCatalogEntryInput] = Field(default_factory=list)
    proposal_ledger: str | None = None
    proposal_states: list[ProposalStateInput] = Field(default_factory=list)


# 客户端完成一次工具调用后的结果；通过 tool_call_id 对应原调用，随下一次请求续跑。
class ClientToolResult(BaseModel):
    """客户端执行工具后返回的结果，随下一轮 /chat/stream 请求一并发送。"""

    tool_call_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=128)
    result: str = Field(description="工具执行结果（JSON 序列化字符串）")


# 一次聊天流请求的完整输入：模型配置、历史消息、当前背景、客户端工具结果和可取消任务 ID。
class LocalChatStreamRequest(BaseModel):
    """Lightweight chat/stream request — no DB dependency."""

    # 本地服务按本次请求中的配置创建模型；这些字段不要写入普通调试日志。
    api_key: str = Field(min_length=1)
    base_url: str = Field(min_length=1)
    model: str = Field(min_length=1)
    supports_vision: bool = False
    # 辅助模型（子代理查阅等轻量调用）；三者齐全才生效，否则跟随主模型
    aux_model: str = ""
    aux_api_key: str = ""
    aux_base_url: str = ""
    # messages 是实际对话历史；user_content 还供图片路径解析、任务准备等逻辑读取本次需求文字。
    messages: list[ChatMessageInput]
    user_content: str = Field(min_length=1)
    system_prompt: str | None = None
    context_summary: str | None = None
    context_summary_up_to_message_id: str | None = None
    client_context: ClientContextInput | None = None
    # 非空表示带回客户端工具结果，默认运行时据此构造续跑消息。
    client_tool_results: list[ClientToolResult] = Field(default_factory=list)
    # 整次流任务的取消标识；与每条工具调用自己的 tool_call_id 分开。
    client_job_id: str = Field(min_length=1, max_length=64)


# 取消接口只需要 client_job_id，后端用它查找当前流任务。
class ChatCancelRequest(BaseModel):
    client_job_id: str = Field(min_length=1, max_length=64)


# tool_pending 中交给客户端执行的一条调用，arguments 已经是参数字典。
class ClientToolCallPayload(BaseModel):
    """tool_pending SSE 事件中单个客户端工具调用的描述。"""

    tool_call_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


# 统一的业务事件结构；type 决定如何理解其余字段，不要求每种事件填满全部字段。
class StreamEventPayload(BaseModel):
    """SSE 流事件载荷。"""

    # 常见事件包括 preparing、text_delta、tool_start、tool_result 和 tool_pending。
    type: str
    content: str | None = None
    stage: str | None = None
    status: str | None = None
    detail: str | None = None
    proposal: dict[str, Any] | None = None
    summary: str | None = None
    summary_up_to_message_id: str | None = None
    token_estimate: int | None = None
    tool_call_id: str | None = None
    name: str | None = None
    arguments: str | None = None
    result: str | None = None
    message: str | None = None
    image_path: str | None = None
    mode: str | None = None
    domain: str | None = None
    target: str | None = None
    reason: str | None = None
    client_tool_calls: list[ClientToolCallPayload] | None = None
    query: str | None = None
    focus_path: str | None = None
    inner_tool_call_id: str | None = None
    # file_edit_delta：str_replace 流式期间 old_string / new_string 的增量片段
    old_delta: str | None = None
    new_delta: str | None = None
    # rename 提案：原路径（relative_path 为新路径）
    old_path: str | None = None

    # 手工转换成对外事件字典，跳过 None 字段，并按既有协议映射部分字段名称。
    def to_sse_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"type": self.type}
        if self.content is not None:
            data["content"] = self.content
        if self.stage is not None:
            data["stage"] = self.stage
        if self.status is not None:
            data["status"] = self.status
        if self.detail is not None:
            data["detail"] = self.detail
        if self.proposal is not None:
            data["proposal"] = self.proposal
        if self.summary is not None:
            data["summary"] = self.summary
        if self.summary_up_to_message_id is not None:
            data["summaryUpToMessageId"] = self.summary_up_to_message_id
        if self.token_estimate is not None:
            data["tokenEstimate"] = self.token_estimate
        if self.tool_call_id is not None:
            data["toolCallId"] = self.tool_call_id
        if self.name is not None:
            data["name"] = self.name
        if self.arguments is not None:
            data["arguments"] = self.arguments
        if self.result is not None:
            data["result"] = self.result
        if self.message is not None:
            data["message"] = self.message
        if self.image_path is not None:
            if self.type in ("file_proposal_start", "file_proposal_delta", "file_proposal", "document_proposal"):
                data["suggestedRelativePath"] = self.image_path
            else:
                data["imagePath"] = self.image_path
        if self.type in ("file_proposal_start", "file_proposal", "document_proposal"):
            if self.summary is not None:
                data["title"] = self.summary
            if self.detail is not None and "title" not in data:
                data["title"] = self.detail
        if self.mode is not None:
            data["mode"] = self.mode
            if self.type in (
                "file_proposal_start",
                "file_proposal_delta",
                "file_proposal",
                "document_proposal",
            ):
                data["operation"] = self.mode
        if self.old_path is not None and self.type in (
            "file_proposal_start",
            "file_proposal",
        ):
            data["oldPath"] = self.old_path
        if self.domain is not None:
            data["domain"] = self.domain
        if self.target is not None:
            data["target"] = self.target
        if self.reason is not None:
            data["reason"] = self.reason
        if self.query is not None:
            data["query"] = self.query
        if self.focus_path is not None:
            data["focusPath"] = self.focus_path
        if self.inner_tool_call_id is not None:
            data["innerToolCallId"] = self.inner_tool_call_id
        if self.old_delta is not None:
            data["oldDelta"] = self.old_delta
        if self.new_delta is not None:
            data["newDelta"] = self.new_delta
        if self.client_tool_calls is not None:
            serialized = [
                {
                    "toolCallId": call.tool_call_id,
                    "name": call.name,
                    "arguments": call.arguments,
                }
                for call in self.client_tool_calls
            ]
            data["clientToolCalls"] = serialized
            data["toolCalls"] = serialized
        return data
