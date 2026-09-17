import { DEFAULT_CHAT_CONTEXT_CONFIG, JobState } from '../../shared/agentTypes';
import type {
  AgentSession,
  ChatMessage,
  ClientContextPayload,
  ClientToolCall,
  ClientToolResult,
  StreamEvent,
} from '../../shared/agentTypes';
import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
  DetectionOverrides,
} from '../../shared/annotationAgentTypes';
import { ANNOTATION_BATCH_MAX_FILES } from '../../shared/annotationAgentTypes';
import { formatScopeTruncationNote } from './annotationAgent/scopePathUtil';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import { mockChatStream } from './agentStreamMock';
import { streamChatDirectly } from './localChatClient';
import {
  buildBackendMessages,
  streamChatViaBackend,
} from './backendChatClient';
import { startAnnotationBatchJob } from './annotationBatchJob';
import { startAnnotationMutationJob } from './annotationMutationBatchJob';
import {
  formatFileStatsText,
  type AnnotationProposalFileStat,
} from './annotationProposalStats';
import { createDebugLogger } from './agentDebugLogger';
import {
  TurnToolHistoryAccumulator,
  mergeResumeMessages,
} from './turnToolHistory';
import {
  cancelTerminalApproval,
  requestTerminalApproval,
} from './terminalApproval';

export type JobEventListener = (event: StreamEvent) => void;

interface RunningJob {
  controller: AbortController;
  listeners: Set<JobEventListener>;
  state: JobState;
  /** 所属会话（AwaitingConfirm 状态下按会话查找挂起 job） */
  sessionId?: string;
  /** 提案待确认时暂存的客户端工具结果，Keep All/Dismiss 后续跑使用 */
  pendingResumeResults?: ClientToolResult[];
  /** AwaitingConfirm 状态下的续跑入口 */
  resumeWithResults?: (results: ClientToolResult[]) => Promise<void>;
}

const runningJobs = new Map<string, RunningJob>();
/** Listeners registered before startChatJob creates the job entry */
const pendingListeners = new Map<string, Set<JobEventListener>>();

function attachPendingListeners(jobId: string, job: RunningJob): void {
  const pending = pendingListeners.get(jobId);
  if (!pending) return;
  pending.forEach((listener) => job.listeners.add(listener));
  pendingListeners.delete(jobId);
}

export function subscribeJobEvents(
  jobId: string,
  listener: JobEventListener,
): () => void {
  const job = runningJobs.get(jobId);
  if (job) {
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  let pending = pendingListeners.get(jobId);
  if (!pending) {
    pending = new Set();
    pendingListeners.set(jobId, pending);
  }
  pending.add(listener);
  return () => {
    pendingListeners.get(jobId)?.delete(listener);
  };
}

function emitJobEvent(jobId: string, event: StreamEvent): void {
  const job = runningJobs.get(jobId);
  if (!job) return;
  job.listeners.forEach((listener) => listener(event));
}

export function isJobRunning(jobId: string): boolean {
  return runningJobs.has(jobId);
}

export function getJobState(jobId: string): JobState | null {
  const job = runningJobs.get(jobId);
  return job ? job.state : null;
}

export function stopJob(jobId: string): void {
  const job = runningJobs.get(jobId);
  if (!job) return;
  job.controller.abort();
  runningJobs.delete(jobId);
  pendingListeners.delete(jobId);
}

/** 上下文参数：客户端工具执行时使用，无标注项目时为 null */
export interface ClientToolContext {
  project: AnnotationProjectSnapshot;
  detectionModels: PretrainedModelConfig[];
  currentFileAbsolutePath: string | null;
  /** 对话上下文 transcript，透传给 batch/mutation prepare API */
  conversationTranscript?: string;
  /** 当前会话未 Keep All 的标注提案 changes，供 mutate 叠到磁盘工作集 */
  pendingAnnotationChanges?: AnnotationBatchChange[];
}

/**
 * 执行单个客户端工具，收集结果摘要并转发 StreamEvent 到 jobId 监听者。
 * 返回 JSON 序列化的结果字符串（作为 ToolMessage 内容传回后端）。
 */
type ClientToolResultPayload = {
  status: 'completed' | 'error' | 'skipped';
  tool: string;
  user_request: string;
  summary: string;
  message?: string;
  file_written?: boolean;
  proposal_pending?: boolean;
  /** 提案逐文件明细（路径/增删改/标签），让模型写报告时引用真实数字 */
  files?: AnnotationProposalFileStat[];
  /** 终端命令专用：退出码 / job id / 输出尾部 */
  exit_code?: number;
  job_id?: string;
  output_tail?: string;
};

function formatClientToolResult(payload: ClientToolResultPayload): string {
  return JSON.stringify(payload);
}

/** 工具结果 JSON 中是否标记了待确认提案（决定 job 是否进入 AwaitingConfirm 断点）。 */
export function toolResultHasPendingProposal(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { proposal_pending?: unknown };
    return parsed.proposal_pending === true;
  } catch {
    return false;
  }
}

export function formatAnnotationToolResult(options: {
  status: 'completed' | 'error' | 'skipped';
  tool: 'auto_annotate' | 'mutate_annotation';
  userRequest: string;
  summary: string;
  hasProposal: boolean;
  fileStats?: AnnotationProposalFileStat[];
  omittedCount?: number;
  omittedPaths?: string[];
}): string {
  const pendingNote = options.hasProposal
    ? '已生成待确认提案（未写盘）。'
    : options.tool === 'mutate_annotation'
      ? '未生成提案，不要对用户说已删除或已修改。'
      : '未生成提案，不要对用户说已标注完成。';
  const fileStatsText = options.fileStats?.length
    ? ` ${formatFileStatsText(options.fileStats)}。`
    : '';
  const truncationNote = formatScopeTruncationNote(
    options.omittedCount,
    options.omittedPaths,
    ANNOTATION_BATCH_MAX_FILES,
  );
  const truncationText = truncationNote ? ` ${truncationNote}` : '';
  const summary = options.hasProposal
    ? `${pendingNote}${options.summary}${fileStatsText}${truncationText}`
    : `${options.summary} ${pendingNote}${truncationText}`;
  return formatClientToolResult({
    status: options.status,
    tool: options.tool,
    user_request: options.userRequest,
    summary: summary.trim(),
    message: summary.trim(),
    file_written: false,
    proposal_pending: options.hasProposal,
    files: options.fileStats,
  });
}

/** 直连 LLM 时后端无法注入摘要，把摘要拼入 systemPrompt */
function composeDirectSystemPrompt(
  systemPrompt: string | undefined,
  contextSummary: string | undefined,
): string | undefined {
  const summary = contextSummary?.trim();
  if (!summary) return systemPrompt;
  const summaryBlock = `【此前对话摘要】\n${summary}`;
  return systemPrompt ? `${systemPrompt}\n\n${summaryBlock}` : summaryBlock;
}

function pendingToolCallsFromEvent(
  event: StreamEvent,
): ClientToolCall[] | null {
  if (event.type === 'tool_pending') {
    const e = event as Record<string, unknown>;
    return (e.toolCalls ?? e.client_tool_calls) as ClientToolCall[] | null;
  }
  return null;
}

export function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
      } catch {
        // fall through to comma / single-value split
      }
    }
    return text
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseWriteMode(value: unknown): 'append' | 'replace_matching' {
  return value === 'replace_matching' ? 'replace_matching' : 'append';
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return undefined;
}

/** 解析 auto_annotate 透传的检测约束（与后端 AutoAnnotateArgs 对齐）。 */
export function parseDetectionOverrides(
  args: Record<string, unknown>,
): DetectionOverrides | undefined {
  const overrides: DetectionOverrides = {};
  const conf = parseOptionalNumber(args.conf_threshold);
  if (conf !== undefined)
    overrides.confThreshold = Math.min(Math.max(conf, 0), 1);
  const iou = parseOptionalNumber(args.iou_threshold);
  if (iou !== undefined) overrides.iouThreshold = Math.min(Math.max(iou, 0), 1);
  if (typeof args.model_id === 'string' && args.model_id.trim()) {
    overrides.modelId = args.model_id.trim();
  }
  const include = parseStringList(args.include_classes);
  if (include.length) overrides.includeClasses = include;
  const exclude = parseStringList(args.exclude_classes);
  if (exclude.length) overrides.excludeClasses = exclude;
  const vision = parseOptionalBoolean(args.use_vision_mapping);
  if (vision !== undefined) overrides.useVisionMapping = vision;
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

const ANNOTATION_CLIENT_TOOLS = new Set(['auto_annotate', 'mutate_annotation']);

/** 终端桥（preload terminal 段）最小类型 */
interface TerminalBridge {
  start: (payload: {
    command: string;
    args?: string[];
    timeoutMs?: number;
  }) => Promise<
    { ok: true; jobId: string } | { ok: false; error: string; message?: string }
  >;
  read: (jobId: string) => Promise<{
    ok: boolean;
    snapshot?: {
      output: string;
      truncated: boolean;
      status: string;
      exitCode: number | null;
    };
    error?: string;
  }>;
  kill: (jobId: string) => Promise<boolean>;
  onEvent: (callback: (payload: unknown) => void) => () => void;
}

function getTerminalBridge(): TerminalBridge | null {
  const terminal = (
    window as unknown as { electron?: { terminal?: TerminalBridge } }
  ).electron?.terminal;
  return terminal ?? null;
}

/** 结果回传给模型的输出尾部上限 */
const TERMINAL_OUTPUT_TAIL_CHARS = 4_000;

function terminalStartErrorMessage(error: string, message?: string): string {
  if (error === 'denied_command') return '命令命中安全拒绝清单，已阻止执行';
  if (error === 'shell_syntax_unsupported') {
    return (
      message ?? '终端执行不经 shell，不支持管道/重定向/命令组合，请拆成多步'
    );
  }
  if (error === 'no_workspace')
    return '未打开工作区，终端命令只能在打开的工作区内执行';
  if (error === 'too_many_jobs') return '并行终端任务已达上限，请稍后再试';
  return message || `命令未能启动: ${error}`;
}

/**
 * 受限终端命令：批准（聊天内确认条）→ 主进程执行 → 输出流式回显 → 终态。
 * 批准等待发生在 loop 已暂停的 ASYNC pending 阶段；拒绝时直接以 skipped
 * 结果 resume，不产生执行副作用。
 */
async function runTerminalCommandTool(
  toolCall: ClientToolCall,
  jobId: string,
  signal: AbortSignal,
  userRequest: string,
): Promise<string> {
  const respond = (
    payload: Omit<ClientToolResultPayload, 'tool' | 'user_request'>,
  ): string =>
    formatClientToolResult({
      tool: 'start_terminal_command',
      user_request: userRequest,
      ...payload,
    });

  const bridge = getTerminalBridge();
  if (!bridge) {
    return respond({
      status: 'error',
      summary: '终端执行桥接不可用',
      message: 'terminal_bridge_unavailable',
    });
  }

  const args = toolCall.arguments as {
    command?: unknown;
    args?: unknown;
    timeout_ms?: unknown;
  };
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const timeoutMs =
    typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
  if (!command) {
    return respond({
      status: 'error',
      summary: '缺少 command 参数，无法执行终端命令',
      message: 'missing_command',
    });
  }

  // 1. 聊天内确认（live-only 事件不持久化；job 取消时以拒绝收口防 promise 泄漏）
  emitJobEvent(jobId, {
    type: 'terminal_approval',
    toolCallId: toolCall.toolCallId,
  });
  const onAbortApproval = () => cancelTerminalApproval(toolCall.toolCallId);
  signal.addEventListener('abort', onAbortApproval);
  let approved = false;
  try {
    approved = await requestTerminalApproval(toolCall.toolCallId);
  } finally {
    signal.removeEventListener('abort', onAbortApproval);
    emitJobEvent(jobId, {
      type: 'terminal_approval_done',
      toolCallId: toolCall.toolCallId,
    });
  }
  if (signal.aborted) {
    return respond({
      status: 'skipped',
      summary: '已取消',
      message: 'cancelled',
    });
  }
  if (!approved) {
    return respond({
      status: 'skipped',
      summary: '用户拒绝执行该命令',
      message: 'terminal_command_rejected',
    });
  }

  // 2. 先订阅事件再启动，避免终态事件与订阅竞争（activeJobId 启动成功后置位）
  let activeJobId: string | null = null;
  let exitResolve:
    | ((state: {
        status: string;
        exitCode: number | null;
        output: string;
        truncated: boolean;
      }) => void)
    | null = null;
  const exitPromise = new Promise<{
    status: string;
    exitCode: number | null;
    output: string;
    truncated: boolean;
  }>((resolve) => {
    exitResolve = resolve;
  });
  const unsubscribe = bridge.onEvent((payload) => {
    const evt = payload as {
      type?: string;
      jobId?: string;
      chunk?: string;
      status?: string;
      exitCode?: number | null;
    };
    if (!activeJobId || evt?.jobId !== activeJobId) return;
    if (evt.type === 'output' && typeof evt.chunk === 'string') {
      emitJobEvent(jobId, {
        type: 'terminal_output',
        toolCallId: toolCall.toolCallId,
        chunk: evt.chunk,
      });
      return;
    }
    if (evt.type === 'exit') {
      void bridge.read(activeJobId).then((snap) => {
        exitResolve?.({
          status: evt.status ?? snap.snapshot?.status ?? 'exited',
          exitCode: evt.exitCode ?? snap.snapshot?.exitCode ?? null,
          output: snap.snapshot?.output ?? '',
          truncated: snap.snapshot?.truncated ?? false,
        });
      });
    }
  });

  // 3. 主进程执行（门禁二次校验 + cwd 锁定 workspace + no-shell spawn）
  let start:
    | { ok: true; jobId: string }
    | { ok: false; error: string; message?: string };
  try {
    start = await bridge.start({ command, args: commandArgs, timeoutMs });
  } catch (err) {
    unsubscribe();
    return respond({
      status: 'error',
      summary: `终端命令启动失败: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!start.ok) {
    unsubscribe();
    return respond({
      status: 'error',
      summary: terminalStartErrorMessage(start.error, start.message),
      message: start.error,
    });
  }
  activeJobId = start.jobId;

  const killOnAbort = () => {
    void bridge.kill(start.jobId);
  };
  signal.addEventListener('abort', killOnAbort);

  try {
    const finalState = await exitPromise;
    const statusText =
      finalState.status === 'timeout'
        ? '超时被强制终止'
        : finalState.status === 'killed'
          ? '已被终止'
          : finalState.status === 'failed'
            ? '启动失败'
            : '已完成';
    const tail =
      finalState.output.length > TERMINAL_OUTPUT_TAIL_CHARS
        ? `…（前段略）\n${finalState.output.slice(-TERMINAL_OUTPUT_TAIL_CHARS)}`
        : finalState.output;
    return respond({
      status: finalState.status === 'exited' ? 'completed' : 'error',
      summary: `${statusText}（exit ${finalState.exitCode ?? 'N/A'}）`,
      exit_code: finalState.exitCode ?? undefined,
      job_id: start.jobId,
      output_tail: tail || '(无输出)',
      message: `完整输出可用 read_terminal_output(job_id="${start.jobId}") 回读；需要中止用 kill_terminal_job`,
    });
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', killOnAbort);
  }
}

async function runClientTool(
  toolCall: ClientToolCall,
  jobId: string,
  providerId: string,
  sessionId: string | undefined,
  ctx: ClientToolContext | null,
  clientContext: ClientContextPayload | null | undefined,
  signal: AbortSignal,
  onPersistEvent?: (event: StreamEvent) => void,
  providerApiKey = '',
  providerBaseUrl = '',
  providerModel = '',
  providerSupportsVision = false,
): Promise<string> {
  const userRequest =
    (toolCall.arguments as { user_request?: string }).user_request?.trim() ||
    JSON.stringify(toolCall.arguments);

  const emit = (event: StreamEvent): void => {
    emitJobEvent(jobId, event);
    onPersistEvent?.(event);
  };

  if (
    clientContext?.workMode === 'editor' &&
    ANNOTATION_CLIENT_TOOLS.has(toolCall.name)
  ) {
    return formatClientToolResult({
      status: 'error',
      tool: toolCall.name,
      user_request: userRequest,
      summary: '编辑器模式下不可用标注工具',
      message: 'annotation_tools_disabled_in_editor_mode',
    });
  }

  if (
    clientContext?.agentMode !== 'annotation' &&
    ANNOTATION_CLIENT_TOOLS.has(toolCall.name)
  ) {
    return formatClientToolResult({
      status: 'error',
      tool: toolCall.name,
      user_request: userRequest,
      summary: 'Ask 模式下不可写入标注',
      message: 'annotation_tools_disabled_in_ask_mode',
    });
  }

  if (toolCall.name === 'auto_annotate') {
    if (!ctx) {
      return formatClientToolResult({
        status: 'error',
        tool: 'auto_annotate',
        user_request: userRequest,
        summary: '未绑定标注项目，无法执行自动标注',
        message: '未绑定标注项目，无法执行自动标注',
      });
    }
    const args = toolCall.arguments as Record<string, unknown> & {
      scope_hint?: string;
    };
    const scopePaths = parseStringList(args.paths);
    const scopeHint = args.scope_hint?.trim() || undefined;
    const allFiles = args.all_files === true;
    const writeMode = parseWriteMode(args.write_mode);
    const detectionOverrides = parseDetectionOverrides(args);
    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort());
    const onEvent = (event: StreamEvent): void => {
      emit(event);
    };
    try {
      const batchResult = await startAnnotationBatchJob({
        jobId,
        providerId,
        userRequest,
        preselectedPaths: [],
        sessionId,
        project: ctx.project,
        currentFileAbsolutePath: ctx.currentFileAbsolutePath,
        detectionModels: ctx.detectionModels,
        onEvent,
        signal: controller.signal,
        providerApiKey,
        providerBaseUrl,
        providerModel,
        providerSupportsVision,
        scopeHint,
        scopePaths,
        allFiles,
        writeMode,
        detectionOverrides,
      });
      return formatAnnotationToolResult({
        status:
          batchResult.status === 'completed' ? 'completed' : batchResult.status,
        tool: 'auto_annotate',
        userRequest,
        summary: batchResult.summary,
        hasProposal: batchResult.hasProposal,
        fileStats: batchResult.fileStats,
        omittedCount: batchResult.omittedCount,
        omittedPaths: batchResult.omittedPaths,
      });
    } catch {
      return formatAnnotationToolResult({
        status: 'error',
        tool: 'auto_annotate',
        userRequest,
        summary: '自动标注流水线执行失败',
        hasProposal: false,
      });
    }
  }

  if (toolCall.name === 'mutate_annotation') {
    if (!ctx) {
      return formatClientToolResult({
        status: 'error',
        tool: 'mutate_annotation',
        user_request: userRequest,
        summary: '未绑定标注项目，无法执行标注变更',
        message: '未绑定标注项目，无法执行标注变更',
      });
    }
    const mutateArgs = toolCall.arguments as {
      paths?: unknown;
      annotation_ids?: unknown;
    };
    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort());
    try {
      const mutateResult = await startAnnotationMutationJob({
        jobId,
        providerId,
        userRequest,
        sessionId,
        conversationTranscript: ctx.conversationTranscript,
        project: ctx.project,
        currentFileAbsolutePath: ctx.currentFileAbsolutePath,
        signal: controller.signal,
        onEvent: emit,
        paths: parseStringList(mutateArgs.paths),
        annotationIds: parseStringList(mutateArgs.annotation_ids),
        pendingAnnotationChanges: ctx.pendingAnnotationChanges,
        providerApiKey,
        providerBaseUrl,
        providerModel,
      });
      return formatAnnotationToolResult({
        status:
          mutateResult.status === 'completed'
            ? 'completed'
            : mutateResult.status,
        tool: 'mutate_annotation',
        userRequest,
        summary: mutateResult.summary,
        hasProposal: mutateResult.hasProposal,
        fileStats: mutateResult.fileStats,
      });
    } catch {
      return formatAnnotationToolResult({
        status: 'error',
        tool: 'mutate_annotation',
        userRequest,
        summary: '标注变更流水线执行失败',
        hasProposal: false,
      });
    }
  }

  if (toolCall.name === 'start_terminal_command') {
    return runTerminalCommandTool(toolCall, jobId, signal, userRequest);
  }

  return formatClientToolResult({
    status: 'error',
    tool: toolCall.name,
    user_request: userRequest,
    summary: `未知客户端工具: ${toolCall.name}`,
    message: `未知客户端工具: ${toolCall.name}`,
  });
}

export async function startChatJob(options: {
  jobId: string;
  session: AgentSession;
  messageIds: string[];
  sessionMessages: Record<string, ChatMessage>;
  providerId: string;
  providerBaseUrl: string;
  providerApiKey: string;
  providerModel: string;
  providerSupportsVision?: boolean;
  /** 辅助模型凭据（子代理查阅等轻量调用）；null/缺省时跟随会话模型 */
  auxiliaryProvider?: { baseUrl: string; apiKey: string; model: string } | null;
  userMessageId: string;
  assistantMessageId: string;
  userContent: string;
  truncateFromMessageId?: string | null;
  clientContext?: ClientContextPayload;
  systemPrompt?: string;
  /** 客户端工具执行所需上下文，有标注项目时传入 */
  clientToolContext?: ClientToolContext | null;
  onPersistEvent?: (event: StreamEvent) => void;
  /**
   * resume 前重建 clientContext（刷新提案台账/结构化状态）。
   * 提案确认状态在 job 启动后才会变化，resume 时必须取最新值，
   * 否则后端任务阶段机拿到的是过期状态。
   */
  refreshClientContext?: () => Promise<ClientContextPayload | null | undefined>;
}): Promise<void> {
  if (runningJobs.has(options.jobId)) return;

  const controller = new AbortController();
  const job: RunningJob = {
    controller,
    listeners: new Set(),
    state: JobState.Registered,
    sessionId: options.session.id,
  };
  runningJobs.set(options.jobId, job);
  attachPendingListeners(options.jobId, job);

  // 有工作区或标注项目上下文 → 需要工具 → 走后端 SSE
  // 纯文本无上下文 → 直连 LLM
  const needsTools = Boolean(
    options.clientContext?.workspaceRoot ||
    options.clientContext?.activeAnnotationProjectId ||
    options.session.annotationProjectId,
  );
  const useDirect = !needsTools && Boolean(options.providerApiKey);

  // ── Debug Logger ────────────────────────────────────────────────────────
  const debugLogger = createDebugLogger(options.jobId);
  debugLogger.logJobState(JobState.Registered);

  const priorMessages = buildBackendMessages(
    options.messageIds,
    options.sessionMessages,
    { excludeMessageIds: new Set([options.assistantMessageId]) },
  );
  const turnHistory = new TurnToolHistoryAccumulator();

  // Log send context once at entry
  debugLogger.logSendContext({
    jobId: options.jobId,
    providerId: options.providerId,
    sessionId: options.session.id,
    messages: priorMessages,
    userContent: options.userContent,
    clientContext: options.clientContext,
    clientToolResults: undefined,
  });

  // ── 内部：执行一轮 SSE 流并处理 tool_pending 的 resume 循环 ──────
  const runLoop = async (
    accumulatedResults: ClientToolResult[] = [],
  ): Promise<void> => {
    if (controller.signal.aborted) return;

    // 若携带累积结果，标记为 resume 状态并记录
    if (accumulatedResults.length > 0) {
      job.state = JobState.Resuming;
      debugLogger.logJobState(JobState.Resuming);
    }

    // resume 前刷新 clientContext：提案台账/结构化状态在 job 启动后可能已变化，
    // 过期状态会让后端任务阶段机做出错误门禁
    let clientContextForRequest = options.clientContext;
    if (accumulatedResults.length > 0 && options.refreshClientContext) {
      try {
        clientContextForRequest =
          (await options.refreshClientContext()) ?? options.clientContext;
      } catch {
        clientContextForRequest = options.clientContext;
      }
    }

    const resumeMessages =
      accumulatedResults.length > 0
        ? mergeResumeMessages(priorMessages, turnHistory.snapshot())
        : priorMessages;

    const stream = useDirect
      ? streamChatDirectly(
          {
            providerId: options.providerId,
            baseUrl: options.providerBaseUrl,
            apiKey: options.providerApiKey,
            model: options.providerModel,
            sessionId: options.session.id,
            userMessageId: options.userMessageId,
            assistantMessageId: options.assistantMessageId,
            messages: priorMessages,
            userContent: options.userContent,
            systemPrompt: composeDirectSystemPrompt(
              options.systemPrompt,
              options.session.contextSummary,
            ),
          },
          controller.signal,
        )
      : needsTools
        ? streamChatViaBackend(
            {
              providerId: options.providerId,
              sessionId: options.session.id,
              userMessageId: options.userMessageId,
              assistantMessageId: options.assistantMessageId,
              messages: resumeMessages,
              context: {
                summary: options.session.contextSummary,
                summaryUpToMessageId: options.session.summaryUpToMessageId,
                config: DEFAULT_CHAT_CONTEXT_CONFIG,
              },
              clientJobId: options.jobId,
              truncateFromMessageId: options.truncateFromMessageId,
              userContent: options.userContent,
              clientContext: clientContextForRequest,
              clientToolResults:
                accumulatedResults.length > 0 ? accumulatedResults : undefined,
              apiKey: options.providerApiKey,
              baseUrl: options.providerBaseUrl,
              model: options.providerModel,
              supportsVision: options.providerSupportsVision,
              systemPrompt: options.systemPrompt,
              auxiliary: options.auxiliaryProvider ?? null,
            },
            controller.signal,
          )
        : mockChatStream(options.userContent, controller.signal);

    let pendingToolCalls: ClientToolCall[] | null = null;
    let finished = false;

    // 累积本轮 LLM 输出的文本
    let accumulatedText = '';

    for await (const event of stream) {
      turnHistory.apply(event);
      emitJobEvent(options.jobId, event);
      options.onPersistEvent?.(event);

      // 收集 text_delta 文本用于最终汇总
      if (event.type === 'text_delta') {
        accumulatedText += event.content;
      }

      // 调试输出（text_delta/reasoning_delta 不逐条打印）
      if (event.type !== 'text_delta' && event.type !== 'reasoning_delta') {
        debugLogger.logEvent(event);
      }

      if (event.type === 'done') {
        job.state = JobState.Done;
        debugLogger.logJobState(JobState.Done);
        debugLogger.logTextOutput(accumulatedText);
        finished = true;
        break;
      }
      if (event.type === 'error' || controller.signal.aborted) {
        job.state = controller.signal.aborted
          ? JobState.Cancelled
          : JobState.Error;
        debugLogger.logJobState(job.state);
        debugLogger.logTextOutput(accumulatedText);
        break;
      }
      const pending = pendingToolCallsFromEvent(event);
      if (pending) {
        job.state = JobState.ToolPending;
        debugLogger.logJobState(JobState.ToolPending);
        debugLogger.logTextOutput(accumulatedText);
        pendingToolCalls = pending;
        break;
      }
    }

    if (controller.signal.aborted) return;

    // ── 有客户端工具需要执行：分派 → 收集结果 → resume ──────────────────
    if (pendingToolCalls && pendingToolCalls.length > 0) {
      const results: ClientToolResult[] = [];
      for (let i = 0; i < pendingToolCalls.length; i += 1) {
        const toolCall = pendingToolCalls[i];
        // 合成 tool_start：把该工具块从 queued 翻成 running。
        // arguments 置空串——store 的合并逻辑会保留派发时的完整参数；
        // 不进 turnHistory（resume 消息由真实 tool_start + 结果构成）。
        const started: StreamEvent = {
          type: 'tool_start',
          toolCallId: toolCall.toolCallId,
          name: toolCall.name,
          arguments: '',
        };
        emitJobEvent(options.jobId, started);
        options.onPersistEvent?.(started);
        // Debug: log client tool dispatch
        console.log(
          `%c[LR-Agent]%c ⚡ runClientTool %c${toolCall.name}`,
          'color: #ff9800; font-weight:bold;',
          '',
          'color: #4caf50;',
        );
        const result = await runClientTool(
          toolCall,
          options.jobId,
          options.providerId,
          options.session.id,
          options.clientToolContext ?? null,
          options.clientContext,
          controller.signal,
          options.onPersistEvent,
          options.providerApiKey,
          options.providerBaseUrl,
          options.providerModel,
          options.providerSupportsVision ?? false,
        );
        results.push({
          toolCallId: toolCall.toolCallId,
          name: toolCall.name,
          result,
        });
        console.log(
          `%c[LR-Agent]%c ⚡ clientToolResult %c${toolCall.name}%c → ${result.slice(0, 120)}`,
          'color: #ff9800; font-weight:bold;',
          '',
          'color: #4caf50;',
          '',
        );
        if (controller.signal.aborted) {
          // 取消时收掉尚未执行的排队工具块，避免 UI 永久「排队中」
          for (let j = i + 1; j < pendingToolCalls.length; j += 1) {
            const skipped = pendingToolCalls[j];
            const cancelled: StreamEvent = {
              type: 'tool_result',
              toolCallId: skipped.toolCallId,
              result: JSON.stringify({
                status: 'cancelled',
                summary: '已取消',
              }),
            };
            emitJobEvent(options.jobId, cancelled);
            options.onPersistEvent?.(cancelled);
          }
          return;
        }
      }
      const allResults = [...accumulatedResults, ...results];
      // 提案待确认 → HITL 断点：结束当前 turn，等 Keep All/Dismiss 后续跑。
      // 避免提案未落盘时自动 resume，模型读到磁盘旧态而自我审查、重复标注。
      if (results.some((r) => toolResultHasPendingProposal(r.result))) {
        job.state = JobState.AwaitingConfirm;
        job.pendingResumeResults = allResults;
        debugLogger.logJobState(JobState.AwaitingConfirm);
        debugLogger.logTextOutput(accumulatedText);
        emitJobEvent(options.jobId, { type: 'awaiting_confirmation' });
        return;
      }
      // 无待确认提案：携带累积的全部 client tool 结果立即 resume
      await runLoop(allResults);
      return;
    }

    if (!controller.signal.aborted && !finished) {
      emitJobEvent(options.jobId, { type: 'done' });
    }
  };

  const executeJob = async (
    initialResults: ClientToolResult[] = [],
  ): Promise<void> => {
    try {
      await runLoop(initialResults);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      const errorMsg = err instanceof Error ? err.message : '流式请求失败';
      console.log(
        `%c[LR-Agent]%c ❌ startChatJob error %c${errorMsg}`,
        'color: #ff9800; font-weight:bold;',
        '',
        'color: #f44336; font-weight:bold;',
      );
      emitJobEvent(options.jobId, {
        type: 'error',
        message: errorMsg,
      });
    } finally {
      // AwaitingConfirm：保留 job 注册与监听器，等待 Keep All/Dismiss 续跑
      if (job.state !== JobState.AwaitingConfirm) {
        runningJobs.delete(options.jobId);
        pendingListeners.delete(options.jobId);
      }
    }
  };

  job.resumeWithResults = async (results: ClientToolResult[]) => {
    if (job.state !== JobState.AwaitingConfirm) return;
    if (controller.signal.aborted) return;
    job.pendingResumeResults = undefined;
    await executeJob(results);
  };

  await executeJob();
}

/**
 * 提案确认/关闭后续跑挂起的 job（AwaitingConfirm → 异步 executeJob）。
 * 立即返回 jobId（续跑在后台进行）；无挂起 job 返回 null。
 */
export function resumeAwaitingConfirmation(sessionId: string): string | null {
  for (const [jobId, job] of runningJobs) {
    if (
      job.sessionId === sessionId &&
      job.state === JobState.AwaitingConfirm &&
      job.pendingResumeResults &&
      job.resumeWithResults
    ) {
      const results = job.pendingResumeResults;
      void job.resumeWithResults(results);
      return jobId;
    }
  }
  return null;
}

/**
 * 丢弃会话中挂起的 AwaitingConfirm job（用户发送新消息时调用，
 * 避免过期提案结果泄漏到后续任务）。
 */
export function discardAwaitingConfirmation(sessionId: string): void {
  for (const [jobId, job] of runningJobs) {
    if (job.sessionId === sessionId && job.state === JobState.AwaitingConfirm) {
      job.pendingResumeResults = undefined;
      job.controller.abort();
      runningJobs.delete(jobId);
      pendingListeners.delete(jobId);
    }
  }
}
