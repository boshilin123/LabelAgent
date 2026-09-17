from typing import Any, Literal

from pydantic import BaseModel, Field


class ChatToolCallInput(BaseModel):
    """OpenAI 兼容的 assistant tool_call，用于 resume 还原本轮工具对话。"""

    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=128)
    args: dict[str, Any] = Field(default_factory=dict)


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


class AnnotationProjectSnapshotInput(BaseModel):
    project_id: str = Field(min_length=1, max_length=64)
    name: str = ""
    modality: str = ""
    annotation_type: str = ""
    labels: list[dict[str, Any]] = Field(default_factory=list)
    detection_models: list[dict[str, Any]] = Field(default_factory=list)
    project_directory_path: str | None = None


class SkillCatalogEntryInput(BaseModel):
    """全局 Agent Skill 目录条目（catalog，仅 name + description 注入 prompt）。"""

    name: str = Field(min_length=1, max_length=128)
    description: str = Field(max_length=512)


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


class McpServerInput(BaseModel):
    """用户配置的远程 MCP Server（前端 userData/mcp.json 中已启用项，随 client_context 注入）。"""

    id: str = Field(min_length=1, max_length=64)
    url: str = Field(min_length=1)
    transport: Literal["streamable_http", "sse"] = "streamable_http"
    headers: dict[str, str] = Field(default_factory=dict)
    disabled_tools: list[str] = Field(default_factory=list)


class McpProbeRequest(BaseModel):
    """测试连接单个 MCP Server（配置页使用，不走 LLM）。"""

    url: str = Field(min_length=1)
    transport: Literal["streamable_http", "sse"] = "streamable_http"
    headers: dict[str, str] = Field(default_factory=dict)


class ClientContextInput(BaseModel):
    workspace_root: str | None = None
    active_file_path: str | None = None
    active_relative_path: str | None = None
    project_directory_path: str | None = None
    active_annotation_project_id: str | None = None
    annotation_project_modality: str | None = None
    annotation_project_type: str | None = None
    agent_mode: Literal["chat", "annotation"] | None = None
    work_mode: Literal["editor", "annotation"] | None = None
    selected_annotation_id: str | None = None
    selected_annotation_ids: list[str] = Field(default_factory=list)
    annotation_project_snapshot: AnnotationProjectSnapshotInput | None = None
    mcp_server_url: str | None = None
    mcp_server_token: str | None = None
    mcp_servers: list[McpServerInput] = Field(default_factory=list)
    project_instructions: str | None = None
    memory_index: str | None = None
    workspace_memory_enabled: bool = False
    skills_catalog: list[SkillCatalogEntryInput] = Field(default_factory=list)
    proposal_ledger: str | None = None
    proposal_states: list[ProposalStateInput] = Field(default_factory=list)


class ClientToolResult(BaseModel):
    """客户端执行工具后返回的结果，随下一轮 /chat/stream 请求一并发送。"""

    tool_call_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=128)
    result: str = Field(description="工具执行结果（JSON 序列化字符串）")


class LocalChatStreamRequest(BaseModel):
    """Lightweight chat/stream request — no DB dependency."""

    api_key: str = Field(min_length=1)
    base_url: str = Field(min_length=1)
    model: str = Field(min_length=1)
    supports_vision: bool = False
    # 辅助模型（子代理查阅等轻量调用）；三者齐全才生效，否则跟随主模型
    aux_model: str = ""
    aux_api_key: str = ""
    aux_base_url: str = ""
    messages: list[ChatMessageInput]
    user_content: str = Field(min_length=1)
    system_prompt: str | None = None
    context_summary: str | None = None
    context_summary_up_to_message_id: str | None = None
    client_context: ClientContextInput | None = None
    client_tool_results: list[ClientToolResult] = Field(default_factory=list)
    client_job_id: str = Field(min_length=1, max_length=64)


class ChatCancelRequest(BaseModel):
    client_job_id: str = Field(min_length=1, max_length=64)


class ClientToolCallPayload(BaseModel):
    """tool_pending SSE 事件中单个客户端工具调用的描述。"""

    tool_call_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class StreamEventPayload(BaseModel):
    """SSE 流事件载荷。"""

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
