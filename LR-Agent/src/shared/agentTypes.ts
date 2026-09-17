import type { AnnotationBatchProposal } from './annotationAgentTypes';
import type { McpRemoteServerPayload } from './mcpTypes';

/** Agent 流水线类型：与 UI 标题、阶段标签一一对应 */
export type PipelineKind = 'batch' | 'mutation' | 'report';

/** Agent 任务生命周期状态（与后端 JobState 一致）。 */
export enum JobState {
  Registered = 'registered',
  Streaming = 'streaming',
  ToolPending = 'tool_pending',
  Resuming = 'resuming',
  /** 提案已生成、等待用户 Keep All/Dismiss；确认后自动续跑 */
  AwaitingConfirm = 'awaiting_confirm',
  Done = 'done',
  Error = 'error',
  Cancelled = 'cancelled',
}

export interface LlmProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  /** 主进程 API 视觉探针结果（图文 chat/completions，HTTP 2xx 视为多模态） */
  supportsVision: boolean;
  visionProbedAt: number | null;
  visionProbeDetail: string;
  /** 模型上下文窗口（tokens）；null 表示未知。来源见 contextWindowSource */
  contextWindowTokens: number | null;
  /** '' | 'manual'（用户手填，探测不覆盖）| 'probe'（/models 探测）| 'heuristic'（名称对照表） */
  contextWindowSource: '' | 'manual' | 'probe' | 'heuristic';
  createdAt: number;
  updatedAt: number;
}

export type ProposalBlockStatus =
  'pending' | 'applied' | 'dismissed' | 'undone';

export type MessageBlock =
  | { type: 'text'; content: string }
  | {
      type: 'reasoning';
      content: string;
      collapsed: boolean;
    }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: string;
      /** queued：客户端异步工具已派发、等待串行执行（tool_pending 队列） */
      status: 'queued' | 'running' | 'done' | 'error';
      result?: string;
      collapsed: boolean;
      /** 终端命令等待用户聊天内批准（live-only，批准/拒绝后清除） */
      awaitingApproval?: boolean;
      /** 终端命令流式输出累积（live-only，随 terminal_output 事件追加） */
      terminalOutput?: string;
    }
  | {
      type: 'annotation_proposal';
      proposal: AnnotationBatchProposal;
      status: ProposalBlockStatus;
      /** Apply 时成功写入改前快照后为 true；无快照不显示 Undo */
      hasCheckpoint?: boolean;
      /** 提案来源流水线（批量标注/标注修改），用于卡片标注来源 */
      sourceKind?: PipelineKind;
    }
  | {
      type: 'annotation_pipeline';
      collapsed: boolean;
      steps: AnnotationPipelineStep[];
      /** 流水线类型，默认 batch */
      pipelineKind?: PipelineKind;
    }
  | {
      type: 'file_proposal';
      title: string;
      content: string;
      suggestedRelativePath: string;
      status: ProposalBlockStatus;
      hasCheckpoint?: boolean;
      operation?: 'write' | 'delete' | 'rename';
      /** rename 提案的原路径 */
      oldPath?: string;
      additions?: number;
      deletions?: number;
      /** 全量 content 事件已定稿；此后同路径的 delta（无新 start 重置）应丢弃 */
      contentFinalized?: boolean;
      /** str_replace 流式期间累积的 old_string / new_string，定稿后清除 */
      oldString?: string;
      newString?: string;
    }
  | {
      /** @deprecated 历史消息兼容，加载时 normalize 为 file_proposal */
      type: 'document_proposal';
      title: string;
      content: string;
      suggestedRelativePath: string;
      status: ProposalBlockStatus;
      hasCheckpoint?: boolean;
      operation?: 'write' | 'delete' | 'rename';
      oldPath?: string;
      additions?: number;
      deletions?: number;
      /** 全量 content 事件已定稿；此后同路径的 delta（无新 start 重置）应丢弃 */
      contentFinalized?: boolean;
      oldString?: string;
      newString?: string;
    }
  | {
      type: 'subagent';
      id: string;
      query: string;
      focusPath?: string;
      status: 'running' | 'done' | 'error';
      steps: SubagentStep[];
      /** 与主对话对齐的 text / tool_call 时间线；历史消息可能缺失 */
      innerBlocks?: MessageBlock[];
      summary: string;
      startedAt: number;
      finishedAt?: number;
    };

export interface SubagentStep {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: 'running' | 'done' | 'error';
}

export type AgentPanelTab =
  | { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; runId: string; sessionId: string };

export type AnnotationPipelineStepStatus =
  'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface AnnotationPipelineStep {
  stage: string;
  label: string;
  message: string;
  status: AnnotationPipelineStepStatus;
  detail?: string;
  /** 图片相对路径，用于批量明细按图聚合 */
  imagePath?: string;
}

/**
 * 标注任务卡中的客户端工具任务项（渲染层从 tool_call 块派生，不持久化）：
 * 同一条 assistant 消息内的 auto_annotate / mutate_annotation 调用按队列展示。
 */
export interface AnnotationPipelineTask {
  /** 对应 tool_call 块的 toolCallId */
  id: string;
  name: string;
  label: string;
  status: 'queued' | 'running' | 'done' | 'error';
}

export type ChatMessageStatus =
  | 'pending'
  | 'streaming'
  | 'done'
  | 'stopped'
  | 'error'
  /** 提案待用户确认（HITL 断点），Keep All/Dismiss 后同一消息续跑 */
  | 'awaiting_confirmation';

/** 流式阶段提示（瞬态，不持久化）：首 token 前向用户展示等待原因 */
export type ChatStreamPhase =
  | 'preparing-context'
  | 'summarizing'
  | 'waiting-model'
  /** Keep All 后正在落盘变更（awaiting → resume 之间的空窗） */
  | 'applying-changes'
  /** Undo 后正在放弃提案（awaiting → resume 之间的空窗） */
  | 'discarding-changes';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  blocks: MessageBlock[];
  status: ChatMessageStatus;
  /** 流式空窗期的阶段提示；收到首个内容事件后清空 */
  streamPhase?: ChatStreamPhase | null;
  /** 该轮 UI 模式：chat=Ask，annotation=Agent */
  interactionMode?: AgentInteractionMode | null;
  providerId: string;
  model: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** 本轮结束时刻（done/stopped/error）；hydrate 时用 updatedAt 回填 */
  finishedAt?: number;
}

export interface ChatContextConfig {
  maxContextTokens: number;
  maxTurnsInWindow: number;
  summarizeTriggerRatio: number;
  minTurnsBeforeSummarize: number;
}

export const DEFAULT_CHAT_CONTEXT_CONFIG: ChatContextConfig = {
  maxContextTokens: 12_000,
  maxTurnsInWindow: 20,
  summarizeTriggerRatio: 0.85,
  // 必须 ≥ 摘要时保留的轮数（ceil(maxTurnsInWindow/2) = 10），
  // 否则触发条件可能通过但没有可驱逐的内容，摘要永远不会执行。
  minTurnsBeforeSummarize: 10,
};

export type AgentInteractionMode = 'chat' | 'annotation';

export interface ProjectAgentUiState {
  openTabIds: string[];
  activeSessionId: string | null;
  agentMode: AgentInteractionMode;
}

export const WORKSPACE_AGENT_UI_KEY = '__workspace';

export interface AgentSession {
  id: string;
  title: string;
  /** 绑定标注任务；null 表示工作区通用会话 */
  annotationProjectId?: string | null;
  interactionMode?: 'chat' | 'annotation' | null;
  providerId: string;
  model: string;
  messageIds: string[];
  messageCount?: number;
  lastMessagePreview?: string;
  hasMoreMessagesBefore?: boolean;
  activeJobId?: string;
  /** 被窗口挤出历史的压缩摘要 */
  contextSummary?: string;
  /** 摘要已覆盖到的最后一条消息 id */
  summaryUpToMessageId?: string;
  lastContextTokenEstimate?: number;
  createdAt: number;
  updatedAt: number;
}

export type StreamEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | {
      type: 'tool_start';
      toolCallId: string;
      name: string;
      arguments: string;
    }
  | { type: 'tool_result'; toolCallId: string; result: string }
  | { type: 'preparing'; stage: 'summarize' | 'streaming' | 'build_messages' }
  | {
      type: 'context_updated';
      summary: string;
      summaryUpToMessageId: string;
      tokenEstimate?: number;
    }
  | {
      type: 'route_decided';
      mode: 'chat' | 'assist';
      domain: string;
    }
  | {
      type: 'annotation_progress';
      stage: string;
      message: string;
      status?: AnnotationPipelineStepStatus;
      detail?: string;
      imagePath?: string;
      pipelineKind?: PipelineKind;
    }
  | { type: 'annotation_proposal'; proposal: AnnotationBatchProposal }
  | {
      type: 'file_proposal_start';
      title: string;
      suggestedRelativePath: string;
      detail: string;
      operation?: 'write' | 'delete' | 'rename';
      oldPath?: string;
    }
  | {
      type: 'file_proposal_delta';
      content: string;
      /** 所属文件相对路径，用于多文件场景下匹配对应的 file_proposal 块 */
      suggestedRelativePath?: string;
    }
  | {
      /** str_replace 流式期间 old_string / new_string 的增量片段 */
      type: 'file_edit_delta';
      oldDelta?: string;
      newDelta?: string;
      /** 所属文件相对路径，用于匹配对应的 file_proposal 块 */
      suggestedRelativePath?: string;
    }
  | {
      type: 'file_proposal';
      title: string;
      content: string;
      suggestedRelativePath: string;
      status?: ProposalBlockStatus;
      operation?: 'write' | 'delete' | 'rename';
      oldPath?: string;
    }
  | {
      /** @deprecated 旧 SSE 事件 */
      type: 'document_proposal';
      title: string;
      content: string;
      suggestedRelativePath: string;
      status?: ProposalBlockStatus;
    }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | {
      type: 'tool_pending';
      toolCalls: ClientToolCall[];
    }
  | {
      /** 客户端工具已生成待确认提案，job 暂停等待 Keep All/Dismiss */
      type: 'awaiting_confirmation';
    }
  | {
      /** 终端命令等待用户批准（渲染层合成，live-only，不持久化） */
      type: 'terminal_approval';
      toolCallId: string;
    }
  | {
      /** 终端命令批准/拒绝已提交（渲染层合成，live-only） */
      type: 'terminal_approval_done';
      toolCallId: string;
    }
  | {
      /** 终端命令输出增量（渲染层合成，live-only） */
      type: 'terminal_output';
      toolCallId: string;
      chunk: string;
    }
  | {
      type: 'subagent_start';
      toolCallId: string;
      query: string;
      focusPath?: string;
    }
  | {
      type: 'subagent_tool_start';
      toolCallId: string;
      name: string;
      arguments: string;
      innerToolCallId: string;
    }
  | {
      type: 'subagent_tool_result';
      toolCallId: string;
      result: string;
      innerToolCallId: string;
      status?: 'running' | 'done' | 'error';
    }
  | { type: 'subagent_text_delta'; toolCallId: string; content: string }
  | {
      type: 'subagent_done';
      toolCallId: string;
      summary: string;
      status: 'done' | 'error';
    };

/** 异步工具调用描述（来自 tool_pending 事件）。 */
export interface ClientToolCall {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 客户端异步工具集合：经 tool_pending 由前端串行执行，排队期间块状态为 queued。 */
export const CLIENT_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>([
  'auto_annotate',
  'mutate_annotation',
  'start_terminal_command',
]);

/** 客户端工具 → 其产出的标注流水线类型。 */
export function clientToolPipelineKind(name: string): PipelineKind | null {
  if (name === 'auto_annotate') return 'batch';
  if (name === 'mutate_annotation') return 'mutation';
  return null;
}

/** 客户端工具执行结果，随 resume 请求一并发送给后端。 */
export interface ClientToolResult {
  toolCallId: string;
  name: string;
  result: string;
}

/** 会话中单个提案变更的结构化状态（注入 client_context，供后端任务阶段机推导）。 */
export interface ProposalStateEntry {
  path: string;
  kind: 'annotation' | 'file';
  status: 'pending' | 'applied' | 'dismissed' | 'undone';
  operation?: string | null;
  /** 该提案涉及的标注实例 id（append/replace 的 annotations、delete 的 deleteIds、patch 的 patches） */
  annotationIds?: string[];
}

/** 全局 Agent Skill 目录条目（catalog，name 为目录名，注入 prompt）。 */
export interface AgentSkillEntry {
  name: string;
  description: string;
  /** 预留来源字段：目前仅 'user'（~/.agents/skills），未来支持项目级 */
  scope: 'user';
}

/** hidden：用户在本应用内停用（不注入 prompt，且技能工具拒读）；disabled：frontmatter 声明禁用模型调用 */
export type AgentSkillStatus = 'available' | 'disabled' | 'hidden' | 'invalid';

/** 面板用 Skill 清单（含未注入项与附属文件列表）。 */
export interface AgentSkillInventoryItem {
  dirName: string;
  name: string;
  description: string;
  scope: 'user';
  status: AgentSkillStatus;
  reason?: string;
  files: string[];
  path: string;
}

export interface ClientContextPayload {
  workspaceRoot?: string | null;
  activeFilePath?: string | null;
  activeRelativePath?: string | null;
  projectDirectoryPath?: string | null;
  activeAnnotationProjectId?: string | null;
  annotationProjectModality?: string | null;
  annotationProjectType?: string | null;
  agentMode?: AgentInteractionMode | null;
  workMode?: 'editor' | 'annotation' | null;
  selectedAnnotationId?: string | null;
  selectedAnnotationIds?: string[];
  /** 本地 MCP Server 地址（Electron 启动时分配，如 "http://127.0.0.1:PORT"） */
  mcpServerUrl?: string | null;
  /** 本地 MCP Server 访问 token（仅注入本机 MCP 连接，禁止打日志） */
  mcpServerToken?: string | null;
  /** 用户启用的远程 MCP Server（userData/mcp.json；含 headers，禁止打日志） */
  mcpServers?: McpRemoteServerPayload[] | null;
  /** 项目级指令（.lragent/INSTRUCTIONS.md 内容，注入 system prompt） */
  projectInstructions?: string | null;
  /** 工作区记忆索引（MEMORY.md 截断内容，注入 system prompt） */
  memoryIndex?: string | null;
  /** 当前标注任务是否启用工作区记忆（空目录也要暴露创建工具） */
  workspaceMemoryEnabled?: boolean;
  /** 全局 Agent Skills catalog（~/.agents/skills 扫描结果，注入 system prompt） */
  skillsCatalog?: AgentSkillEntry[] | null;
  /** 未 Keep All 的提案台账（短文本，注入 system prompt） */
  proposalLedger?: string | null;
  /** 提案结构化状态（注入 client_context，供后端任务阶段机推导门禁） */
  proposalStates?: ProposalStateEntry[] | null;
  annotationProjectSnapshot?: {
    projectId: string;
    name: string;
    directoryPath?: string;
    modality: string;
    annotationType: string;
    annotationTypeLabel?: string;
    labels: Array<{ id: string; name: string; color?: string }>;
    detectionModels: Array<{ id: string; name: string; isDefault?: boolean }>;
    keypointTemplateId?: string;
  } | null;
}

export interface AgentChatPersistedState {
  sessions: Record<string, AgentSession>;
  sessionOrder: string[];
  openTabIds: string[];
  activeSessionId: string | null;
  messagesBySession: Record<string, Record<string, ChatMessage>>;
}

export function createAgentId(prefix = 'agent'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 3)}****${apiKey.slice(-4)}`;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function buildSessionTitle(content: string): string {
  const line = content.trim().replace(/\s+/g, ' ');
  if (!line) return '新对话';
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

export type FileProposalLikeBlock =
  | Extract<MessageBlock, { type: 'file_proposal' }>
  | Extract<MessageBlock, { type: 'document_proposal' }>;

export function isFileProposalBlock(
  block: MessageBlock,
): block is FileProposalLikeBlock {
  return block.type === 'file_proposal' || block.type === 'document_proposal';
}

/** 将历史 document_proposal 块统一为 file_proposal。 */
export function normalizeHistoricalBlocks(
  blocks: MessageBlock[],
): MessageBlock[] {
  return blocks.map((block) => {
    if (block.type === 'document_proposal') {
      return { ...block, type: 'file_proposal' as const };
    }
    return block;
  });
}
