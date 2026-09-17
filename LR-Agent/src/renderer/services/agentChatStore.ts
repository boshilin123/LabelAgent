import type {
  AgentChatPersistedState,
  AgentInteractionMode,
  AgentSession,
  ChatMessage,
  MessageBlock,
  PipelineKind,
  ProjectAgentUiState,
  ProposalBlockStatus,
  StreamEvent,
} from '../../shared/agentTypes';
import {
  CLIENT_TOOL_NAME_SET,
  clientToolPipelineKind,
  isFileProposalBlock,
  normalizeHistoricalBlocks,
  WORKSPACE_AGENT_UI_KEY,
} from '../../shared/agentTypes';
import { isLrAgentRelativePath } from '../../shared/workspacePathGuards';
import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';
import { normalizePipelineKindsInBlocks } from './annotationAgent/pipelineKinds';
import {
  upsertPipelineSteps,
  buildPipelineStepFromProgressEvent,
} from './annotationAgent/pipelineStepAccumulator';
import {
  summarizeToolArgumentsForDisplay,
  summarizeToolResultForDisplay,
} from './toolDisplayUtils';

const STORAGE_KEY = 'lr-agent:agentChatState';
const UI_STORAGE_KEY = 'lr-agent:agentChatUi';

export interface AgentChatUiStateV2 {
  byProject: Record<string, ProjectAgentUiState>;
  /** @deprecated migrated into byProject[WORKSPACE_AGENT_UI_KEY] */
  openTabIds?: string[];
  activeSessionId?: string | null;
}

export function normalizeAgentMode(mode: unknown): AgentInteractionMode {
  if (mode === 'annotation' || mode === 'annotate') return 'annotation';
  return 'chat';
}

export function createEmptyProjectUi(
  agentMode: AgentInteractionMode = 'chat',
): ProjectAgentUiState {
  return { openTabIds: [], activeSessionId: null, agentMode };
}

export function createEmptyUiStateV2(): AgentChatUiStateV2 {
  return {
    byProject: {
      [WORKSPACE_AGENT_UI_KEY]: createEmptyProjectUi(),
    },
  };
}

export function projectUiKey(
  annotationProjectId: string | null | undefined,
): string {
  return annotationProjectId ?? WORKSPACE_AGENT_UI_KEY;
}

export function loadAgentChatUiState(): AgentChatUiStateV2 {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return createEmptyUiStateV2();
    const parsed = JSON.parse(raw) as AgentChatUiStateV2 & {
      openTabIds?: string[];
      activeSessionId?: string | null;
    };
    if (parsed.byProject && typeof parsed.byProject === 'object') {
      const byProject: Record<string, ProjectAgentUiState> = {};
      for (const [key, slice] of Object.entries(parsed.byProject)) {
        if (!slice || typeof slice !== 'object') continue;
        byProject[key] = {
          openTabIds: slice.openTabIds ?? [],
          activeSessionId: slice.activeSessionId ?? null,
          agentMode: normalizeAgentMode(slice.agentMode),
        };
      }
      return {
        byProject: {
          ...createEmptyUiStateV2().byProject,
          ...byProject,
        },
      };
    }
    return {
      byProject: {
        [WORKSPACE_AGENT_UI_KEY]: {
          openTabIds: parsed.openTabIds ?? [],
          activeSessionId: parsed.activeSessionId ?? null,
          agentMode: normalizeAgentMode(
            (parsed as { agentMode?: unknown }).agentMode,
          ),
        },
      },
    };
  } catch {
    return createEmptyUiStateV2();
  }
}

export function getProjectUi(
  state: AgentChatUiStateV2,
  annotationProjectId: string | null | undefined,
): ProjectAgentUiState {
  const key = projectUiKey(annotationProjectId);
  const slice = state.byProject[key];
  if (!slice) return createEmptyProjectUi();
  return {
    ...slice,
    agentMode: normalizeAgentMode(slice.agentMode),
  };
}

export function setProjectUi(
  state: AgentChatUiStateV2,
  annotationProjectId: string | null | undefined,
  slice: ProjectAgentUiState,
): AgentChatUiStateV2 {
  const key = projectUiKey(annotationProjectId);
  return {
    byProject: {
      ...state.byProject,
      [key]: slice,
    },
  };
}

let uiPersistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingUiPersist: AgentChatUiStateV2 | null = null;

/** 立即把挂起的 UI 态写入 localStorage（页面卸载前调用）。 */
export function flushAgentChatUiState(): void {
  if (uiPersistTimer != null) {
    clearTimeout(uiPersistTimer);
    uiPersistTimer = null;
  }
  if (!pendingUiPersist) return;
  const state = pendingUiPersist;
  pendingUiPersist = null;
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[agentChatStore] UI 态写入失败，已忽略', err);
  }
}

export function persistAgentChatUiState(state: AgentChatUiStateV2): void {
  // 与 persistAgentChatState 同理：调用点在流式期间非常高，节流 + 容错。
  pendingUiPersist = state;
  if (uiPersistTimer != null) return;
  uiPersistTimer = setTimeout(() => {
    uiPersistTimer = null;
    flushAgentChatUiState();
  }, PERSIST_THROTTLE_MS);
}

export function createEmptyChatState(): AgentChatPersistedState {
  return {
    sessions: {},
    sessionOrder: [],
    openTabIds: [],
    activeSessionId: null,
    messagesBySession: {},
  };
}

export function loadAgentChatState(): AgentChatPersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyChatState();
    const parsed = JSON.parse(raw) as AgentChatPersistedState;
    if (!parsed || typeof parsed !== 'object') return createEmptyChatState();
    return {
      sessions: parsed.sessions ?? {},
      sessionOrder: parsed.sessionOrder ?? [],
      openTabIds: parsed.openTabIds ?? [],
      activeSessionId: parsed.activeSessionId ?? null,
      messagesBySession: parsed.messagesBySession ?? {},
    };
  } catch {
    return createEmptyChatState();
  }
}

const PERSIST_THROTTLE_MS = 500;

/** 终端输出在 tool_call 块内的展示缓冲上限（字符） */
const MAX_TERMINAL_OUTPUT_CHARS = 60_000;

let statePersistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingStatePersist: AgentChatPersistedState | null = null;

/** 立即把挂起的会话缓存写入 localStorage（页面卸载前调用）。 */
export function flushAgentChatState(): void {
  if (statePersistTimer != null) {
    clearTimeout(statePersistTimer);
    statePersistTimer = null;
  }
  if (!pendingStatePersist) return;
  const state = pendingStatePersist;
  pendingStatePersist = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // QuotaExceededError 等不应打断流式渲染；SQLite 才是事实来源。
    console.warn('[agentChatStore] 会话缓存写入失败，已忽略', err);
  }
}

export function persistAgentChatState(state: AgentChatPersistedState): void {
  // localStorage 只作为崩溃恢复缓存；流式输出每个 token 都会调用这里，
  // 因此做尾沿节流并容错，避免每 token 全量序列化 + 写爆配额。
  pendingStatePersist = state;
  if (statePersistTimer != null) return;
  statePersistTimer = setTimeout(() => {
    statePersistTimer = null;
    flushAgentChatState();
  }, PERSIST_THROTTLE_MS);
}

function markRunningToolsTerminal(
  inner: MessageBlock[],
  terminalStatus: 'done' | 'error',
): MessageBlock[] {
  return inner.map((block) =>
    block.type === 'tool_call' && block.status === 'running'
      ? { ...block, status: terminalStatus }
      : block,
  );
}

export function finalizeSubagentBlocks(
  blocks: MessageBlock[],
  terminalStatus: 'done' | 'error' = 'error',
): MessageBlock[] {
  return blocks.map((block) => {
    if (block.type !== 'subagent') {
      return block;
    }
    const innerBlocks = markRunningToolsTerminal(
      block.innerBlocks ?? [],
      terminalStatus,
    );
    if (block.status !== 'running') {
      return { ...block, innerBlocks };
    }
    return {
      ...block,
      status: terminalStatus,
      summary:
        block.summary ||
        (terminalStatus === 'error' ? '已停止' : block.summary),
      finishedAt: block.finishedAt ?? Date.now(),
      steps: block.steps.map((step) =>
        step.status === 'running' ? { ...step, status: terminalStatus } : step,
      ),
      innerBlocks,
    };
  });
}

export function finalizeAnnotationPipelineBlock(
  block: Extract<MessageBlock, { type: 'annotation_pipeline' }>,
  terminalStatus: 'done' | 'error' = 'done',
): Extract<MessageBlock, { type: 'annotation_pipeline' }> {
  return {
    ...block,
    collapsed: true,
    steps: block.steps.map((step) =>
      step.status === 'running' ? { ...step, status: terminalStatus } : step,
    ),
  };
}

/**
 * 历史兼容：不再把标注卡挪到消息尾，保持工具 → 提案 → 后续叙述的时间顺序。
 */
export function normalizeAnnotationCardOrder(
  blocks: MessageBlock[],
): MessageBlock[] {
  return blocks;
}

/** 历史会话加载时修正残留的 streaming / pipeline running 状态。 */
export function normalizeHistoricalAssistantMessage(
  message: ChatMessage,
): ChatMessage {
  if (message.role !== 'assistant') return message;

  const hasProposal = message.blocks.some(
    (block) => block.type === 'annotation_proposal',
  );
  const isTerminal =
    message.status === 'done' ||
    message.status === 'stopped' ||
    message.status === 'error' ||
    message.status === 'awaiting_confirmation' ||
    (hasProposal && message.status === 'streaming');

  if (!isTerminal) return message;

  let next = message;
  if (message.status === 'streaming') {
    next = {
      ...next,
      status: hasProposal ? 'done' : 'stopped',
      updatedAt: Date.now(),
    };
  }
  // 暂停待确认的 job 不跨重启存活：历史加载时落为 done
  // （提案块状态保留，Keep All 栏仍可用，只是不再续跑）
  if (next.status === 'awaiting_confirmation') {
    next = {
      ...next,
      status: 'done',
      updatedAt: Date.now(),
    };
  }

  const needsPipelineFix = next.blocks.some(
    (block) =>
      block.type === 'annotation_pipeline' &&
      block.steps.some((step) => step.status === 'running'),
  );
  const needsSubagentFix = next.blocks.some(
    (block) => block.type === 'subagent' && block.status === 'running',
  );
  let { blocks } = next;
  if (needsPipelineFix) {
    const terminalStatus = next.status === 'error' ? 'error' : 'done';
    blocks = blocks.map((block) =>
      block.type === 'annotation_pipeline'
        ? finalizeAnnotationPipelineBlock(block, terminalStatus)
        : block,
    );
  }
  if (needsSubagentFix) {
    blocks = finalizeSubagentBlocks(blocks, 'error');
  }

  return ensureFinishedAt({
    ...next,
    blocks: normalizeAnnotationCardOrder(
      normalizePipelineKindsInBlocks(blocks),
    ),
  });
}

function ensureFinishedAt(message: ChatMessage): ChatMessage {
  if (message.finishedAt != null) return message;
  if (
    message.status !== 'done' &&
    message.status !== 'stopped' &&
    message.status !== 'error' &&
    message.status !== 'awaiting_confirmation'
  ) {
    return message;
  }
  return { ...message, finishedAt: message.updatedAt };
}

export function normalizeHistoricalMessages(
  messages: Record<string, ChatMessage>,
): Record<string, ChatMessage> {
  const next: Record<string, ChatMessage> = {};
  for (const [id, message] of Object.entries(messages)) {
    next[id] = normalizeHistoricalAssistantMessage(message);
  }
  return next;
}

function inferAnnotationProposalKind(
  proposal: AnnotationBatchProposal,
): 'batch' | 'mutation' {
  const mutationOps = new Set(['delete', 'patch']);
  if (
    proposal.changes.length > 0 &&
    proposal.changes.every((change) => mutationOps.has(change.operation))
  ) {
    return 'mutation';
  }
  return 'batch';
}

function applyAnnotationProgressToBlocks(
  blocks: MessageBlock[],
  event: Extract<StreamEvent, { type: 'annotation_progress' }>,
): MessageBlock[] {
  const next = [...blocks];
  const pipelineKind = event.pipelineKind ?? 'batch';
  const pipelineIdx = next.findIndex(
    (b) =>
      b.type === 'annotation_pipeline' &&
      (b.pipelineKind ?? 'batch') === pipelineKind,
  );
  const incoming = buildPipelineStepFromProgressEvent(event, pipelineKind);

  if (pipelineIdx < 0) {
    const block: MessageBlock = {
      type: 'annotation_pipeline',
      collapsed: false,
      steps: [incoming],
      pipelineKind,
    };
    // 防御性兜底：正常情况 pipeline 先于 proposal 到达；若 proposal 已存在则插入其前
    if (pipelineKind === 'batch') {
      const proposalIdx = next.findIndex(
        (b) => b.type === 'annotation_proposal',
      );
      if (proposalIdx >= 0) {
        next.splice(proposalIdx, 0, block);
        return next;
      }
    }
    next.push(block);
    return next;
  }

  const block = next[pipelineIdx];
  if (block.type !== 'annotation_pipeline') return next;
  next[pipelineIdx] = {
    ...block,
    pipelineKind,
    steps: upsertPipelineSteps(block.steps, event, pipelineKind),
  };
  return next;
}

/** 合并远端 session 元数据，避免列表 API 用空 messageIds 覆盖本地完整列表。 */
export function mergeSessionFromRemote(
  existing: AgentSession | undefined,
  incoming: AgentSession,
): AgentSession {
  const existingIds = existing?.messageIds ?? [];
  const incomingIds = incoming.messageIds ?? [];
  const messageIds =
    incomingIds.length >= existingIds.length ? incomingIds : existingIds;
  return {
    ...incoming,
    messageIds,
    activeJobId: existing?.activeJobId ?? incoming.activeJobId,
  };
}

/** 合并远端消息与本地缓存（同 id 以 updatedAt 较新者为准；blocks 更完整者优先）。 */
export function mergeMessagesFromRemote(
  existing: Record<string, ChatMessage>,
  incoming: Record<string, ChatMessage>,
): Record<string, ChatMessage> {
  const merged = { ...existing };
  for (const [id, msg] of Object.entries(incoming)) {
    const prev = merged[id];
    const normalized = {
      ...msg,
      blocks: normalizeHistoricalBlocks(msg.blocks),
    };
    if (!prev) {
      merged[id] = normalized;
      continue;
    }
    const prevBlocks = normalizeHistoricalBlocks(prev.blocks);
    const incomingRicher = normalized.blocks.length > prevBlocks.length;
    const prevRicher = prevBlocks.length > normalized.blocks.length;
    if (normalized.updatedAt > prev.updatedAt) {
      merged[id] =
        prevRicher && !incomingRicher
          ? { ...normalized, blocks: prevBlocks }
          : normalized;
    } else if (normalized.updatedAt < prev.updatedAt) {
      merged[id] =
        incomingRicher && !prevRicher
          ? { ...prev, blocks: normalized.blocks }
          : prev;
    } else if (incomingRicher) {
      merged[id] = { ...prev, blocks: normalized.blocks };
    } else {
      merged[id] = prev;
    }
  }
  return merged;
}

/** 兼容 model_dump 与 to_sse_dict 两种 SSE 字段名。 */
export function resolveFileProposalPath(
  event: Record<string, unknown>,
): string {
  const path =
    event.suggestedRelativePath ??
    event.image_path ??
    event.relative_path ??
    event.relativePath;
  return typeof path === 'string' ? path : '';
}

export function resolveFileProposalTitle(
  event: Record<string, unknown>,
  fallback = '文件',
): string {
  const title = event.title ?? event.summary ?? event.detail;
  return typeof title === 'string' && title.trim() ? title : fallback;
}

function normalizeProposalRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function toolCallRelativePath(
  block: Extract<MessageBlock, { type: 'tool_call' }>,
): string {
  try {
    const parsed = JSON.parse(block.arguments) as Record<string, unknown>;
    const path = parsed.relative_path ?? parsed.relativePath ?? parsed.path;
    return typeof path === 'string' ? normalizeProposalRelPath(path) : '';
  } catch {
    return '';
  }
}

function messageHasMatchingDeleteTool(
  blocks: MessageBlock[],
  relativePath: string,
): boolean {
  const target = normalizeProposalRelPath(relativePath);
  if (!target) return false;
  return blocks.some((block) => {
    if (block.type !== 'tool_call' || block.name !== 'delete_workspace_file') {
      return false;
    }
    return toolCallRelativePath(block) === target;
  });
}

function preserveDeleteOperation(
  resolved: 'write' | 'delete' | 'rename',
  existing: MessageBlock | undefined,
): 'write' | 'delete' | 'rename' {
  if (resolved === 'delete') return 'delete';
  if (resolved === 'rename') return 'rename';
  if (
    existing &&
    isFileProposalBlock(existing) &&
    existing.operation === 'delete'
  ) {
    return 'delete';
  }
  if (
    existing &&
    isFileProposalBlock(existing) &&
    existing.operation === 'rename'
  ) {
    return 'rename';
  }
  return 'write';
}

function isProposalLikeBlock(
  block: MessageBlock | undefined,
): block is Extract<
  MessageBlock,
  { type: 'annotation_proposal' | 'file_proposal' | 'document_proposal' }
> {
  return Boolean(
    block &&
    (block.type === 'annotation_proposal' || isFileProposalBlock(block)),
  );
}

/** Keep All 后的 status / hasCheckpoint 不能被后续同块 SSE 冲掉。 */
function preserveAppliedProposalMeta<
  T extends { status: ProposalBlockStatus; hasCheckpoint?: boolean },
>(block: T, existing: MessageBlock | undefined, alwaysKeepStatus = false): T {
  if (!isProposalLikeBlock(existing)) return block;
  const keepStatus = alwaysKeepStatus || existing.status !== 'pending';
  if (!keepStatus) return block;
  return {
    ...block,
    status: existing.status,
    hasCheckpoint: existing.hasCheckpoint,
  };
}

export function resolveFileProposalOperation(
  event: Record<string, unknown>,
  blocks: MessageBlock[] = [],
): 'write' | 'delete' | 'rename' {
  const raw = event.operation ?? event.mode;
  if (raw === 'delete') return 'delete';
  if (raw === 'rename') return 'rename';

  const path = resolveFileProposalPath(event);
  if (path && messageHasMatchingDeleteTool(blocks, path)) {
    return 'delete';
  }

  const content = typeof event.content === 'string' ? event.content : '';
  const title = resolveFileProposalTitle(event, '');
  if (
    !content.trim() &&
    (/删除/.test(title) || /^\s*deleted?(\s|$)/i.test(title))
  ) {
    return 'delete';
  }

  return 'write';
}

function resolveFileProposalOldPath(
  event: Record<string, unknown>,
): string | undefined {
  const raw = event.oldPath ?? event.old_path;
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}

const EXPLORE_READONLY_TOOL = 'explore_readonly';

function eventToolCallId(event: StreamEvent | Record<string, unknown>): string {
  const rec = event as Record<string, unknown>;
  return (
    (rec.toolCallId as string | undefined) ??
    (rec.tool_call_id as string | undefined) ??
    ''
  );
}

function parseExploreReadonlyArgs(argsJson: string): {
  query: string;
  focusPath?: string;
} {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    const query = String(parsed.query ?? '').trim();
    const focus = String(parsed.focus_path ?? parsed.focusPath ?? '').trim();
    return { query, focusPath: focus || undefined };
  } catch {
    return { query: argsJson.trim() };
  }
}

function parseToolResultSummary(result: string | undefined): string {
  if (!result?.trim()) return '';
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const { summary } = parsed;
    if (typeof summary === 'string' && summary.trim()) {
      return summary;
    }
  } catch {
    // plain text tool_result
  }
  return result.trim();
}

function upsertSubagentBlock(
  blocks: MessageBlock[],
  id: string,
  patch: Partial<Extract<MessageBlock, { type: 'subagent' }>>,
): MessageBlock[] {
  const next = [...blocks];
  const idx = next.findIndex(
    (block) => block.type === 'subagent' && block.id === id,
  );
  if (idx >= 0) {
    const current = next[idx];
    if (current.type === 'subagent') {
      next[idx] = { ...current, ...patch, id: current.id };
    }
    return next;
  }
  next.push({
    type: 'subagent',
    id,
    query: patch.query ?? '',
    focusPath: patch.focusPath,
    status: patch.status ?? 'running',
    steps: patch.steps ?? [],
    innerBlocks: patch.innerBlocks ?? [],
    summary: patch.summary ?? '',
    startedAt: patch.startedAt ?? Date.now(),
    finishedAt: patch.finishedAt,
  });
  return next;
}

function currentInnerBlocks(block: MessageBlock | undefined): MessageBlock[] {
  return block?.type === 'subagent' ? [...(block.innerBlocks ?? [])] : [];
}

function asSubagent(
  block: MessageBlock | undefined,
): Extract<MessageBlock, { type: 'subagent' }> | undefined {
  return block?.type === 'subagent' ? block : undefined;
}

function appendInnerText(
  inner: MessageBlock[],
  content: string,
): MessageBlock[] {
  const next = [...inner];
  const last = next[next.length - 1];
  if (last?.type === 'text') {
    next[next.length - 1] = { ...last, content: last.content + content };
    return next;
  }
  next.push({ type: 'text', content });
  return next;
}

function upsertInnerToolCall(
  inner: MessageBlock[],
  tool: Extract<MessageBlock, { type: 'tool_call' }>,
): MessageBlock[] {
  const next = [...inner];
  const idx = next.findIndex(
    (block) => block.type === 'tool_call' && block.id === tool.id,
  );
  if (idx >= 0 && next[idx].type === 'tool_call') {
    next[idx] = { ...next[idx], ...tool, collapsed: next[idx].collapsed };
    return next;
  }
  next.push(tool);
  return next;
}

export function applyStreamEventToBlocks(
  blocks: MessageBlock[],
  event: StreamEvent,
): MessageBlock[] {
  const next = [...blocks];

  if (event.type === 'text_delta') {
    const last = next[next.length - 1];
    if (last?.type === 'text') {
      next[next.length - 1] = {
        ...last,
        content: last.content + event.content,
      };
      return next;
    }
    next.push({ type: 'text', content: event.content });
    return next;
  }

  if (event.type === 'reasoning_delta') {
    const last = next[next.length - 1];
    if (last?.type === 'reasoning') {
      next[next.length - 1] = {
        ...last,
        content: last.content + event.content,
      };
      return next;
    }
    next.push({
      type: 'reasoning',
      content: event.content,
      collapsed: false,
    });
    return next;
  }

  if (event.type === 'subagent_start') {
    const toolCallId = eventToolCallId(event);
    if (!toolCallId) return next;
    return upsertSubagentBlock(next, toolCallId, {
      query: event.query,
      focusPath: event.focusPath,
      status: 'running',
    });
  }

  if (event.type === 'subagent_tool_start') {
    const toolCallId = eventToolCallId(event);
    if (!toolCallId) return next;
    const existing = next.find(
      (block) => block.type === 'subagent' && block.id === toolCallId,
    );
    const steps =
      existing && existing.type === 'subagent' ? [...existing.steps] : [];
    const stepIdx = steps.findIndex(
      (step) => step.id === event.innerToolCallId,
    );
    const step = {
      id: event.innerToolCallId,
      name: event.name,
      arguments: event.arguments,
      status: 'running' as const,
    };
    if (stepIdx >= 0) {
      steps[stepIdx] = { ...steps[stepIdx], ...step };
    } else {
      steps.push(step);
    }
    const current = asSubagent(existing);
    const keepRunning = !current || current.status === 'running';
    const innerBlocks = upsertInnerToolCall(currentInnerBlocks(existing), {
      type: 'tool_call',
      id: event.innerToolCallId,
      name: event.name,
      arguments: event.arguments,
      status: 'running',
      collapsed: true,
    });
    return upsertSubagentBlock(next, toolCallId, {
      steps,
      innerBlocks,
      status: keepRunning ? 'running' : current.status,
    });
  }

  if (event.type === 'subagent_tool_result') {
    const toolCallId = eventToolCallId(event);
    if (!toolCallId) return next;
    const existing = next.find(
      (block) => block.type === 'subagent' && block.id === toolCallId,
    );
    if (!existing || existing.type !== 'subagent') {
      return upsertSubagentBlock(next, toolCallId, {
        steps: [
          {
            id: event.innerToolCallId,
            name: '',
            arguments: '',
            result: event.result,
            status: event.status ?? 'done',
          },
        ],
        innerBlocks: [
          {
            type: 'tool_call',
            id: event.innerToolCallId,
            name: '',
            arguments: '',
            result: event.result,
            status: event.status ?? 'done',
            collapsed: true,
          },
        ],
      });
    }
    const steps = existing.steps.map((step) =>
      step.id === event.innerToolCallId
        ? {
            ...step,
            result: event.result,
            status: event.status ?? 'done',
          }
        : step,
    );
    if (!steps.some((step) => step.id === event.innerToolCallId)) {
      steps.push({
        id: event.innerToolCallId,
        name: '',
        arguments: '',
        result: event.result,
        status: event.status ?? 'done',
      });
    }
    const innerBlocks = upsertInnerToolCall(currentInnerBlocks(existing), {
      type: 'tool_call',
      id: event.innerToolCallId,
      name:
        existing.steps.find((step) => step.id === event.innerToolCallId)
          ?.name ?? '',
      arguments:
        existing.steps.find((step) => step.id === event.innerToolCallId)
          ?.arguments ?? '',
      result: event.result,
      status: event.status ?? 'done',
      collapsed: true,
    });
    return upsertSubagentBlock(next, toolCallId, { steps, innerBlocks });
  }

  if (event.type === 'subagent_text_delta') {
    const toolCallId = eventToolCallId(event);
    if (!toolCallId) return next;
    const existing = next.find(
      (block) => block.type === 'subagent' && block.id === toolCallId,
    );
    const current = asSubagent(existing);
    const prev = current ? current.summary : '';
    const keepRunning = !current || current.status === 'running';
    return upsertSubagentBlock(next, toolCallId, {
      summary: keepRunning ? prev + event.content : prev,
      innerBlocks: keepRunning
        ? appendInnerText(currentInnerBlocks(existing), event.content)
        : currentInnerBlocks(existing),
      status: keepRunning ? 'running' : current.status,
    });
  }

  if (event.type === 'subagent_done') {
    const toolCallId = eventToolCallId(event);
    if (!toolCallId) return next;
    const existing = next.find(
      (block) => block.type === 'subagent' && block.id === toolCallId,
    );
    const prevSummary =
      existing && existing.type === 'subagent' ? existing.summary : '';
    const terminal: 'done' | 'error' =
      event.status === 'error' ? 'error' : 'done';
    const summary = event.summary || prevSummary;
    let innerBlocks = markRunningToolsTerminal(
      currentInnerBlocks(existing),
      terminal,
    );
    const streamedText = innerBlocks
      .filter(
        (block): block is Extract<MessageBlock, { type: 'text' }> =>
          block.type === 'text',
      )
      .map((block) => block.content)
      .join('');
    if (summary.trim() && !streamedText.includes(summary.trim())) {
      innerBlocks = [...innerBlocks, { type: 'text', content: summary }];
    }
    const steps = (
      existing && existing.type === 'subagent' ? existing.steps : []
    ).map((step) =>
      step.status === 'running' ? { ...step, status: terminal } : step,
    );
    return upsertSubagentBlock(next, toolCallId, {
      status: event.status,
      summary,
      steps,
      innerBlocks,
      finishedAt: Date.now(),
    });
  }

  if (event.type === 'tool_start') {
    const toolCallId = eventToolCallId(event);
    if (event.name === EXPLORE_READONLY_TOOL) {
      const parsed = parseExploreReadonlyArgs(event.arguments);
      return upsertSubagentBlock(next, toolCallId, {
        query: parsed.query,
        focusPath: parsed.focusPath,
        status: 'running',
        startedAt: Date.now(),
      });
    }
    const existingIdx = next.findIndex(
      (block) => block.type === 'tool_call' && block.id === toolCallId,
    );
    if (existingIdx >= 0) {
      const block = next[existingIdx];
      if (block.type === 'tool_call') {
        // 仅当已有 arguments 为合法 JSON 且非空对象时才合并；否则直接覆盖
        let argsValid = false;
        try {
          const parsed = JSON.parse(block.arguments);
          argsValid =
            typeof parsed === 'object' &&
            parsed !== null &&
            Object.keys(parsed as Record<string, unknown>).length > 0;
        } catch {
          // block.arguments 已损坏，不合并
        }
        const resolved = argsValid
          ? block.arguments + event.arguments
          : event.arguments;
        next[existingIdx] = {
          ...block,
          arguments: summarizeToolArgumentsForDisplay(block.name, resolved),
          // 客户端异步工具：重复的 tool_start 表示开始执行（queued → running）
          ...(block.status === 'queued' ? { status: 'running' as const } : {}),
        };
      }
      return next;
    }
    const toolBlock: MessageBlock = {
      type: 'tool_call',
      id: toolCallId,
      name: event.name,
      arguments: summarizeToolArgumentsForDisplay(event.name, event.arguments),
      // 客户端异步工具经 tool_pending 串行执行，派发时先排队
      status: CLIENT_TOOL_NAME_SET.has(event.name) ? 'queued' : 'running',
      collapsed: true,
    };
    next.push(toolBlock);
    return next;
  }

  if (event.type === 'tool_result') {
    const toolCallId = eventToolCallId(event);
    const subIdx = next.findIndex(
      (block) => block.type === 'subagent' && block.id === toolCallId,
    );
    if (subIdx >= 0) {
      const block = next[subIdx];
      if (block.type === 'subagent') {
        if (block.status !== 'running' && block.summary) {
          return next;
        }
        next[subIdx] = {
          ...block,
          summary: block.summary || parseToolResultSummary(event.result),
          status: block.status === 'running' ? 'done' : block.status,
          finishedAt: block.finishedAt ?? Date.now(),
        };
      }
      return next;
    }
    const idx = next.findIndex(
      (block) => block.type === 'tool_call' && block.id === toolCallId,
    );
    if (idx >= 0) {
      const block = next[idx];
      if (block.type === 'tool_call') {
        next[idx] = {
          ...block,
          result: summarizeToolResultForDisplay(block.name, event.result),
          status: 'done',
          collapsed: true,
        };
        // 标注工具出结果（含 phase_blocked）时收掉对应 pipeline 的 running step，
        // 避免没有 annotation_proposal 时卡片一直转圈。
        if (
          block.name === 'auto_annotate' ||
          block.name === 'mutate_annotation'
        ) {
          const kind: PipelineKind =
            block.name === 'mutate_annotation' ? 'mutation' : 'batch';
          const terminal = /phase_blocked|"status"\s*:\s*"error"/.test(
            event.result ?? '',
          )
            ? 'error'
            : 'done';
          for (let i = 0; i < next.length; i += 1) {
            const b = next[i];
            if (
              b.type === 'annotation_pipeline' &&
              (b.pipelineKind ?? 'batch') === kind
            ) {
              next[i] = {
                ...b,
                steps: b.steps.map((s) =>
                  s.status === 'running' || s.status === 'pending'
                    ? { ...s, status: terminal }
                    : s,
                ),
              };
            }
          }
        }
      }
    }
    return next;
  }

  // ── 终端命令 live-only 事件（渲染层合成，不持久化、不进 turnHistory）──
  if (event.type === 'terminal_approval') {
    const idx = next.findIndex(
      (block) => block.type === 'tool_call' && block.id === event.toolCallId,
    );
    if (idx >= 0 && next[idx].type === 'tool_call') {
      next[idx] = { ...next[idx], awaitingApproval: true };
    }
    return next;
  }

  if (event.type === 'terminal_approval_done') {
    const idx = next.findIndex(
      (block) => block.type === 'tool_call' && block.id === event.toolCallId,
    );
    if (idx >= 0 && next[idx].type === 'tool_call') {
      next[idx] = { ...next[idx], awaitingApproval: false };
    }
    return next;
  }

  if (event.type === 'terminal_output') {
    const idx = next.findIndex(
      (block) => block.type === 'tool_call' && block.id === event.toolCallId,
    );
    if (idx >= 0 && next[idx].type === 'tool_call') {
      const block = next[idx];
      // 渲染层展示缓冲上限：与主进程环形缓冲独立，防止高频输出撑爆内存
      const merged = (block.terminalOutput ?? '') + event.chunk;
      next[idx] = {
        ...block,
        terminalOutput:
          merged.length > MAX_TERMINAL_OUTPUT_CHARS
            ? merged.slice(merged.length - MAX_TERMINAL_OUTPUT_CHARS)
            : merged,
      };
    }
    return next;
  }

  if (event.type === 'annotation_progress') {
    return applyAnnotationProgressToBlocks(next, event);
  }

  if (event.type === 'annotation_proposal') {
    const proposalKind = inferAnnotationProposalKind(event.proposal);
    for (let i = 0; i < next.length; i += 1) {
      const b = next[i];
      if (b.type === 'annotation_pipeline') {
        next[i] = {
          ...b,
          collapsed: true,
          steps: b.steps.map((s) =>
            s.status === 'running' ? { ...s, status: 'done' } : s,
          ),
        };
      }
      // 提案已生成 = 对应客户端工具执行完毕：收掉其 queued/running 工具块
      if (
        b.type === 'tool_call' &&
        (b.status === 'queued' || b.status === 'running') &&
        clientToolPipelineKind(b.name) === proposalKind
      ) {
        next[i] = { ...b, status: 'done', collapsed: true };
      }
    }
    const incoming = {
      type: 'annotation_proposal' as const,
      proposal: event.proposal,
      status: 'pending' as const,
      sourceKind: proposalKind as PipelineKind,
    };
    const existingIdx = next.findIndex(
      (b) =>
        b.type === 'annotation_proposal' && b.proposal.id === event.proposal.id,
    );
    if (existingIdx >= 0) {
      const existing = next[existingIdx];
      next[existingIdx] = preserveAppliedProposalMeta(incoming, existing, true);
      return next;
    }
    const pipelineIdx = next.findIndex(
      (b) =>
        b.type === 'annotation_pipeline' &&
        (b.pipelineKind ?? 'batch') === proposalKind,
    );
    if (pipelineIdx >= 0) {
      next.splice(pipelineIdx + 1, 0, incoming);
    } else {
      next.push(incoming);
    }
    return next;
  }

  if (event.type === 'file_proposal_start') {
    const raw = event as Record<string, unknown>;
    const suggestedRelativePath = resolveFileProposalPath(raw);
    if (isLrAgentRelativePath(suggestedRelativePath)) {
      return next;
    }
    const normalizedPath = normalizeProposalRelPath(suggestedRelativePath);
    const existingIdx = next.findIndex(
      (b) =>
        (b.type === 'file_proposal' || b.type === 'document_proposal') &&
        normalizeProposalRelPath(b.suggestedRelativePath) === normalizedPath,
    );
    const existing = existingIdx >= 0 ? next[existingIdx] : undefined;
    // file_proposal_start 表示新一轮提案：同路径旧块即使已 applied /
    // dismissed 也必须重置为 pending，否则同一文件的后续修改提案出生即
    // applied，Keep All 不会再收集它，落盘静默失效（历史 bug）。
    // applied 状态在 final 事件处仍受 preserveAppliedProposalMeta 保护，
    // 防止同一提案生命周期内迟到的重复 SSE 冲掉已应用状态。
    const previousCheckpoint =
      existing && isFileProposalBlock(existing)
        ? existing.hasCheckpoint
        : undefined;
    const block = {
      type: 'file_proposal' as const,
      title: resolveFileProposalTitle(raw),
      content: '',
      suggestedRelativePath: normalizedPath,
      status: 'pending' as ProposalBlockStatus,
      contentFinalized: false,
      hasCheckpoint: previousCheckpoint,
      oldPath:
        resolveFileProposalOldPath(raw) ??
        (existing && isFileProposalBlock(existing)
          ? existing.oldPath
          : undefined),
      operation: preserveDeleteOperation(
        resolveFileProposalOperation(raw, next),
        existing,
      ),
    };
    if (existingIdx >= 0) {
      next[existingIdx] = block;
    } else {
      next.push(block);
    }
    return next;
  }

  if (event.type === 'file_proposal_delta') {
    const deltaPath = resolveFileProposalPath(event as Record<string, unknown>);
    if (deltaPath && isLrAgentRelativePath(deltaPath)) {
      return next;
    }
    const normalizedDelta = deltaPath
      ? normalizeProposalRelPath(deltaPath)
      : '';
    for (let i = 0; i < next.length; i += 1) {
      const candidate = next[i];
      if (!isFileProposalBlock(candidate)) continue;
      // 若 delta 携带路径，归一化后精确匹配；否则匹配最后一个 file_proposal（兼容旧 SSE）
      if (
        normalizedDelta &&
        normalizeProposalRelPath(candidate.suggestedRelativePath) !==
          normalizedDelta
      ) {
        continue;
      }
      // 全量 content 事件已定稿后，同路径再来的 delta（中间没有新 start 重置）
      // 是流式拦截器状态错乱的残留分片；追加会把别的文件内容串进本提案，
      // 用户 Keep All 后原样落盘。直接丢弃，等工具结果的全量事件定稿。
      if (candidate.contentFinalized) continue;
      next[i] = {
        ...candidate,
        content: candidate.content + (event.content ?? ''),
      };
      return next;
    }
    return next;
  }

  if (event.type === 'file_edit_delta') {
    const raw = event as Record<string, unknown>;
    const deltaPath = resolveFileProposalPath(raw);
    if (deltaPath && isLrAgentRelativePath(deltaPath)) {
      return next;
    }
    if (!raw.oldDelta && !raw.newDelta) return next;
    const normalizedDelta = deltaPath
      ? normalizeProposalRelPath(deltaPath)
      : '';
    for (let i = 0; i < next.length; i += 1) {
      const candidate = next[i];
      if (!isFileProposalBlock(candidate)) continue;
      if (
        normalizedDelta &&
        normalizeProposalRelPath(candidate.suggestedRelativePath) !==
          normalizedDelta
      ) {
        continue;
      }
      // 定稿后迟到的 edit delta 是拦截器残留分片，丢弃
      if (candidate.contentFinalized) continue;
      next[i] = {
        ...candidate,
        oldString: (candidate.oldString ?? '') + (raw.oldDelta ?? ''),
        newString: (candidate.newString ?? '') + (raw.newDelta ?? ''),
      };
      return next;
    }
    return next;
  }

  if (event.type === 'file_proposal' || event.type === 'document_proposal') {
    for (let i = 0; i < next.length; i += 1) {
      const b = next[i];
      if (
        b.type === 'annotation_pipeline' &&
        (b.pipelineKind ?? 'batch') === 'report'
      ) {
        next[i] = {
          ...b,
          collapsed: true,
          steps: b.steps.map((s) =>
            s.status === 'running' ? { ...s, status: 'done' } : s,
          ),
        };
      }
    }
    const raw = event as Record<string, unknown>;
    const rawPath = resolveFileProposalPath(raw);
    if (rawPath && isLrAgentRelativePath(rawPath)) {
      return next;
    }
    let path = rawPath ? normalizeProposalRelPath(rawPath) : '';
    let existingIdx = -1;
    if (path) {
      existingIdx = next.findIndex(
        (b) =>
          (b.type === 'file_proposal' || b.type === 'document_proposal') &&
          normalizeProposalRelPath(b.suggestedRelativePath) === path,
      );
    } else {
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const candidate = next[i];
        if (!isFileProposalBlock(candidate)) continue;
        existingIdx = i;
        path = normalizeProposalRelPath(candidate.suggestedRelativePath);
        break;
      }
    }
    const existing = existingIdx >= 0 ? next[existingIdx] : undefined;
    const previousCheckpoint =
      existing && isFileProposalBlock(existing)
        ? existing.hasCheckpoint
        : undefined;
    const block = preserveAppliedProposalMeta(
      {
        type: 'file_proposal' as const,
        title: resolveFileProposalTitle(raw),
        content: event.content ?? '',
        suggestedRelativePath: path,
        status: (event.status ?? 'pending') as ProposalBlockStatus,
        contentFinalized: true,
        hasCheckpoint: previousCheckpoint,
        oldPath:
          resolveFileProposalOldPath(raw) ??
          (existing && isFileProposalBlock(existing)
            ? existing.oldPath
            : undefined),
        operation: preserveDeleteOperation(
          resolveFileProposalOperation(raw, next),
          existing,
        ),
      },
      existing,
    );
    if (existingIdx >= 0) {
      next[existingIdx] = block;
    } else {
      next.push(block);
    }
    return next;
  }

  return next;
}

export function getUserTextFromMessage(message: ChatMessage): string {
  if (message.role !== 'user') return '';
  return message.blocks
    .filter(
      (block): block is Extract<MessageBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.content)
    .join('\n');
}

export { resolveUserMessageIdForJob } from './userMessageIdForJob';

export function sessionHasHistoryContent(
  sessionId: string,
  state: Pick<AgentChatPersistedState, 'sessions' | 'messagesBySession'>,
): boolean {
  const session = state.sessions[sessionId];
  if (!session) return false;
  if ((session.messageCount ?? 0) > 0) return true;
  const messages = state.messagesBySession[sessionId];
  return Boolean(messages && Object.keys(messages).length > 0);
}

export function sessionBelongsToProject(
  session: { annotationProjectId?: string | null },
  annotationProjectId: string | null | undefined,
): boolean {
  const sid = session.annotationProjectId ?? null;
  const pid = annotationProjectId ?? null;
  return sid === pid;
}

/** 解析会话消息 id 顺序；messageIds 为空时从 messages 推断。 */
export function resolveSessionMessageIds(
  session: AgentSession | undefined,
  messages: Record<string, ChatMessage>,
): string[] {
  const fromSession = session?.messageIds ?? [];
  if (fromSession.length > 0) {
    return fromSession.filter((id) => messages[id]);
  }
  return Object.values(messages)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => m.id);
}
