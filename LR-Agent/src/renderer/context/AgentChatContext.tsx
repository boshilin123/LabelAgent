import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { buildClientContextPayload } from '../services/agentClientContextBuilder';
import {
  buildProposalLedger,
  buildProposalStates,
  collectPendingAnnotationChanges,
} from '../services/proposalLedger';
import {
  buildSessionTitle,
  CLIENT_TOOL_NAME_SET,
  createAgentId,
  isFileProposalBlock,
  type AgentChatPersistedState,
  type AgentInteractionMode,
  type AgentSession,
  type AgentPanelTab,
  type ChatMessage,
  type ChatStreamPhase,
  type ClientContextPayload,
  type MessageBlock,
} from '../../shared/agentTypes';
import type { McpServerConfig } from '../../shared/mcpTypes';
import {
  deleteAgentSessionRemote,
  fetchAgentSessionDetail,
  fetchAgentSessionsPage,
  loadLocalAgentChatStateForProject,
  backfillLegacyUserIdLocally,
  patchAgentSessionRemote,
  createSessionLocally,
  createMessageLocally,
  updateMessageLocally,
  deleteMessagesAfterLocally,
  deleteMessagesAfterIdLocally,
  cleanupStreamingLocally,
  patchAgentMessageBlockRemote,
} from '../services/agentChatApi';
import {
  applyStreamEventToBlocks,
  createEmptyChatState,
  createEmptyProjectUi,
  finalizeAnnotationPipelineBlock,
  finalizeSubagentBlocks,
  getUserTextFromMessage,
  mergeMessagesFromRemote,
  mergeSessionFromRemote,
  normalizeHistoricalMessages,
  resolveSessionMessageIds,
  resolveUserMessageIdForJob,
  getProjectUi,
  loadAgentChatState,
  loadAgentChatUiState,
  flushAgentChatState,
  flushAgentChatUiState,
  persistAgentChatState,
  persistAgentChatUiState,
  sessionBelongsToProject,
  sessionHasHistoryContent,
  setProjectUi,
} from '../services/agentChatStore';
import {
  applyAllPendingProposals,
  applyProposalRefs,
  collectPendingProposals,
  countPendingProposals,
  dismissPendingProposals,
} from '../services/agentProposalApply';
import { dispatchMutationsAppliedEvent } from '../services/annotationProposalApply';
import {
  clearFilePreviewSession,
  markWorkspaceTextFilesChanged,
} from '../services/agentFilePreviewStore';
import {
  annotationPathsFromBlock,
  collectAppliedProposalRefs,
  collectUndoneProposalRefs,
  confirmDirtyWorkspaceIfNeeded,
  decideEditRollback,
  formatRestoreError,
  messageCanReapply,
  messageCanUndo,
  restoreAppliedCheckpoints,
} from '../services/turnCheckpoint';
import {
  reconcileAppliedFileProposals,
  reconcileAppliedAnnotationProposals,
} from '../services/agentProposalReconcile';
import {
  createDraftSession,
  mergeProjectSessionsIntoState,
  normalizeProjectTabs,
} from '../services/agentProjectBootstrap';
import { shouldApplyBootstrapResult } from '../services/agentChatBootstrap';
import { buildAnnotationProjectSnapshot } from '../services/buildProjectSnapshot';
import { useAuth } from './AuthContext';
import {
  discardAwaitingConfirmation,
  isJobRunning,
  resumeAwaitingConfirmation,
  startChatJob,
  stopJob,
  subscribeJobEvents,
  type ClientToolContext,
} from '../services/agentJobRegistry';
import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';
import type { AnnotationProject } from '../types/annotation';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import { usePretrainedModels } from './PretrainedModelsContext';
import { shouldClearSummaryOnEdit } from '../services/chatContextUtils';
import { prepareChatContext } from '../services/contextPreparer';
import { summarizeConversation } from '../services/contextSummarizer';
import { loadProjectInstructions } from '../services/projectInstructions';
import {
  computeMemoryScopeKey,
  loadMemoryIndex,
  setWorkspaceMemoryActive,
} from '../services/agentMemory';
import { syncWorkspaceFactMemory } from '../services/workspaceFactMemory';
import { loadSkillsCatalog } from '../services/agentSkills';
import { buildTurnContextFromState } from '../services/turnContext';
import { useAnnotation } from './AnnotationContext';
import { useWorkMode } from './WorkModeContext';
import { useApp } from './AppContext';
import { useLlmProviders } from './LlmProvidersContext';
import { useToast } from './ToastContext';
import { findSubagentBlock, isSamePanelTab } from '../services/subagentBlocks';
import { ApiError } from '../types/auth';
import translateError, {
  isAuthError,
  resolveErrorMessage,
} from '../utils/errors';

interface AgentChatContextValue {
  sessions: Record<string, AgentSession>;
  sessionOrder: string[];
  openTabIds: string[];
  openPanelTabs: AgentPanelTab[];
  activePanelTab: AgentPanelTab | null;
  activeSessionId: string | null;
  activeSession: AgentSession | null;
  messagesBySession: Record<string, Record<string, ChatMessage>>;
  historyOpen: boolean;
  editTargetMessageId: string | null;
  editDraft: string;
  setHistoryOpen: (open: boolean) => void;
  setEditDraft: (draft: string) => void;
  createSession: () => string;
  closeTab: (sessionId: string) => void;
  closePanelTab: (tab: AgentPanelTab) => void;
  switchSession: (sessionId: string) => void;
  switchPanelTab: (tab: AgentPanelTab) => void;
  openSessionTab: (sessionId: string) => void;
  openSubagentTab: (runId: string, sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  sendMessage: (
    content: string,
    options?: { editMessageId?: string },
  ) => Promise<void>;
  stopGeneration: (sessionId?: string) => void;
  beginEditMessage: (messageId: string) => void;
  cancelEdit: () => void;
  regenerateAssistant: (assistantMessageId: string) => Promise<void>;
  undoAssistantChanges: (assistantMessageId: string) => Promise<void>;
  reapplyAssistantChanges: (assistantMessageId: string) => Promise<void>;
  toggleBlockCollapse: (
    sessionId: string,
    messageId: string,
    blockIndex: number,
  ) => void;
  updateMessageBlocks: (
    sessionId: string,
    messageId: string,
    updater: (blocks: MessageBlock[]) => MessageBlock[],
  ) => void;
  setSessionProvider: (sessionId: string, providerId: string) => void;
  isSessionStreaming: (sessionId: string) => boolean;
  preparingContext: boolean;
  sessionsHasMore: boolean;
  loadingMoreSessions: boolean;
  loadingOlderMessages: boolean;
  getSessionMessages: (sessionId: string) => ChatMessage[];
  loadMoreSessions: () => Promise<void>;
  loadOlderMessages: (sessionId?: string) => Promise<void>;
  /** 当前会话待应用提案数量（用于 Keep All 栏） */
  pendingProposalCount: number;
  applyAllPendingChanges: () => Promise<void>;
  applyingAllPending: boolean;
  /** 否定尚未 Keep All 的提案（不写盘） */
  dismissAllPendingChanges: () => Promise<void>;
  dismissingAllPending: boolean;
  /** 当前标注项目下的会话顺序（已过滤） */
  sessionOrderForProject: string[];
  currentAnnotationProjectId: string | null;
  agentMode: AgentInteractionMode;
  setAgentMode: (mode: AgentInteractionMode) => void;
}

const AgentChatContext = createContext<AgentChatContextValue | null>(null);

/**
 * 输入框草稿独立成一个 context：
 * 它每敲一个字都会变，若挂在 AgentChatContext 的 value 上会让
 * AgentMessageList / AgentAssistantMessage 整棵子树跟着重渲。
 */
interface AgentComposerDraftContextValue {
  composerDraft: string;
  setComposerDraft: (draft: string) => void;
}

const AgentComposerDraftContext =
  createContext<AgentComposerDraftContextValue | null>(null);

export function useAgentComposerDraft(): AgentComposerDraftContextValue {
  const ctx = useContext(AgentComposerDraftContext);
  if (!ctx) {
    throw new Error(
      'useAgentComposerDraft must be used within AgentChatProvider',
    );
  }
  return ctx;
}

function normalizeLoadedState(
  state: AgentChatPersistedState,
): AgentChatPersistedState {
  const next = { ...state };
  for (const sessionId of Object.keys(next.messagesBySession)) {
    const messages = next.messagesBySession[sessionId] ?? {};
    // 将崩溃/重启残留的 streaming 状态消息统一标记为 stopped
    const cleaned: Record<string, ChatMessage> = {};
    for (const [msgId, msg] of Object.entries(messages)) {
      if (msg.status === 'streaming') {
        cleaned[msgId] = {
          ...msg,
          status: 'stopped',
          updatedAt: Date.now(),
          finishedAt: msg.finishedAt ?? Date.now(),
        };
      } else {
        cleaned[msgId] = msg;
      }
    }
    next.messagesBySession[sessionId] = normalizeHistoricalMessages(cleaned);
    const session = next.sessions[sessionId];
    if (session?.activeJobId) {
      next.sessions[sessionId] = { ...session, activeJobId: undefined };
    }
  }
  return next;
}

export function AgentChatProvider({ children }: { children: ReactNode }) {
  const { providers, defaultProvider, auxiliaryProvider } = useLlmProviders();
  const { showToast } = useToast();
  const { user, status: authStatus } = useAuth();
  const currentUserId = user?.id ?? '';
  const { rootPath, activeFilePath } = useApp();
  const { activeProject } = useAnnotation();
  const { workMode } = useWorkMode();
  const { models: pretrainedModels } = usePretrainedModels();
  const [state, setState] = useState<AgentChatPersistedState>(() => {
    // Electron 下 SQLite 是事实来源，等 bootstrap 覆盖即可；
    // 纯浏览器（无 electron）没有 SQLite，用 localStorage 缓存恢复会话。
    if (window.electron) return createEmptyChatState();
    return normalizeLoadedState(loadAgentChatState());
  });
  const initializedRef = useRef(false);
  const remoteHydratedRef = useRef(false);
  const bootstrappedProjectIdRef = useRef<string | null | undefined>(undefined);
  const bootstrappedUserIdRef = useRef<string | undefined>(undefined);
  const bootstrapGenerationRef = useRef(0);
  const currentUserIdRef = useRef(currentUserId);
  currentUserIdRef.current = currentUserId;
  const authStatusRef = useRef(authStatus);
  authStatusRef.current = authStatus;
  const loadedSessionsRef = useRef<Set<string>>(new Set());
  const sessionsNextCursorRef = useRef<string | null>(null);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [applyingAllPending, setApplyingAllPending] = useState(false);
  const [dismissingAllPending, setDismissingAllPending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openSubagentTabs, setOpenSubagentTabs] = useState<
    Array<Extract<AgentPanelTab, { kind: 'subagent' }>>
  >([]);
  const [activePanelTab, setActivePanelTab] = useState<AgentPanelTab | null>(
    null,
  );
  const [composerDraft, setComposerDraft] = useState('');
  const composerDraftValue = useMemo(
    () => ({ composerDraft, setComposerDraft }),
    [composerDraft],
  );

  // 页面卸载前把节流中的 localStorage 缓存刷盘，避免最后一次改动丢失
  useEffect(() => {
    const flush = () => {
      flushAgentChatState();
      flushAgentChatUiState();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, []);

  const [editTargetMessageId, setEditTargetMessageId] = useState<string | null>(
    null,
  );
  const [editDraft, setEditDraft] = useState('');
  const [preparingContext, setPreparingContext] = useState(false);
  const agentUiRef = useRef(loadAgentChatUiState());
  const activeProjectIdRef = useRef<string | null>(activeProject?.id ?? null);
  activeProjectIdRef.current = activeProject?.id ?? null;
  const [agentMode, setAgentModeState] = useState<AgentInteractionMode>(
    () => getProjectUi(agentUiRef.current, activeProject?.id).agentMode,
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const currentAnnotationProjectId = activeProject?.id ?? null;
  const prevAnnotationProjectIdRef = useRef(currentAnnotationProjectId);

  useEffect(() => {
    if (prevAnnotationProjectIdRef.current === currentAnnotationProjectId) {
      return;
    }
    prevAnnotationProjectIdRef.current = currentAnnotationProjectId;
    setOpenSubagentTabs([]);
    setActivePanelTab(null);
  }, [currentAnnotationProjectId]);

  const persistUiSlice = useCallback(
    (slice: Partial<ReturnType<typeof createEmptyProjectUi>>) => {
      const pid = activeProjectIdRef.current;
      const currentUi = getProjectUi(agentUiRef.current, pid);
      const nextUi = { ...currentUi, ...slice };
      agentUiRef.current = setProjectUi(agentUiRef.current, pid, nextUi);
      persistAgentChatUiState(agentUiRef.current);
      if (slice.agentMode) {
        setAgentModeState(slice.agentMode);
      }
    },
    [],
  );

  const persist = useCallback(
    (next: AgentChatPersistedState) => {
      stateRef.current = next;
      setState(next);
      persistUiSlice({
        openTabIds: next.openTabIds,
        activeSessionId: next.activeSessionId,
      });
      persistAgentChatState(next);
    },
    [persistUiSlice],
  );

  const setAgentMode = useCallback(
    (mode: AgentInteractionMode) => {
      setAgentModeState(mode);
      persistUiSlice({ agentMode: mode });
    },
    [persistUiSlice],
  );

  // 编辑器模式下不再强制锁定为 chat 模式，允许用户手动切换 Ask / Agent

  const removeGhostSession = useCallback(
    (sessionId: string) => {
      const { current } = stateRef;
      if (!current.sessions[sessionId]) return;
      const { [sessionId]: _removedSession, ...sessions } = current.sessions;
      const { [sessionId]: _removedMessages, ...messagesBySession } =
        current.messagesBySession;
      const sessionOrder = current.sessionOrder.filter(
        (id) => id !== sessionId,
      );
      const openTabIds = current.openTabIds.filter((id) => id !== sessionId);
      let { activeSessionId } = current;
      if (activeSessionId === sessionId) {
        activeSessionId = openTabIds[openTabIds.length - 1] ?? null;
      }
      loadedSessionsRef.current.delete(sessionId);
      persist({
        ...current,
        sessions,
        sessionOrder,
        openTabIds,
        activeSessionId,
        messagesBySession,
      });
    },
    [persist],
  );

  const reportRemoteSessionError = useCallback(
    (err: unknown, fallback: string) => {
      const message =
        err instanceof ApiError ? translateError(err.detail) : fallback;
      showToast(message, { type: 'error' });
    },
    [showToast],
  );

  const ensureSessionLoaded = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const userId = currentUserIdRef.current;
      const isAuthed =
        authStatusRef.current === 'authenticated' ||
        authStatusRef.current === 'authenticated_offline';
      if (isAuthed && !userId) {
        showToast('加载对话失败，请重试', { type: 'error' });
        return false;
      }
      const { current } = stateRef;
      if (!sessionHasHistoryContent(sessionId, current)) {
        return true;
      }
      const existing = current.messagesBySession[sessionId];
      const sessionMeta = current.sessions[sessionId];
      const messageCount = sessionMeta?.messageCount ?? 0;
      if (
        loadedSessionsRef.current.has(sessionId) &&
        Object.keys(existing ?? {}).length > 0
      ) {
        return true;
      }
      if (loadedSessionsRef.current.has(sessionId) && messageCount === 0) {
        return true;
      }
      try {
        const detail = await fetchAgentSessionDetail(userId, sessionId);
        loadedSessionsRef.current.add(sessionId);
        const latest = stateRef.current;
        const prevSession = latest.sessions[sessionId];
        const prevMessages = latest.messagesBySession[sessionId] ?? {};
        const mergedMessages = mergeMessagesFromRemote(
          prevMessages,
          normalizeHistoricalMessages(detail.messages),
        );
        const mergedSession = mergeSessionFromRemote(prevSession, {
          ...detail.session,
          activeJobId: prevSession?.activeJobId,
        });
        persist({
          ...latest,
          sessions: {
            ...latest.sessions,
            [sessionId]: mergedSession,
          },
          messagesBySession: {
            ...latest.messagesBySession,
            [sessionId]: mergedMessages,
          },
        });
        void reconcileAppliedFileProposals({
          sessionId,
          messages: mergedMessages,
          messageIds: mergedSession.messageIds,
          project: activeProject ?? null,
          workspaceRoot: rootPath,
          updateBlock: (messageId, blockIndex, patch) => {
            const snap = stateRef.current;
            const sessionMessages = {
              ...(snap.messagesBySession[sessionId] ?? {}),
            };
            const existing = sessionMessages[messageId];
            if (!existing) return;
            sessionMessages[messageId] = {
              ...existing,
              blocks: existing.blocks.map((b, i) =>
                i === blockIndex ? ({ ...b, ...patch } as MessageBlock) : b,
              ),
              updatedAt: Date.now(),
            };
            persist({
              ...snap,
              messagesBySession: {
                ...snap.messagesBySession,
                [sessionId]: sessionMessages,
              },
            });
          },
        });
        void reconcileAppliedAnnotationProposals({
          sessionId,
          messages: mergedMessages,
          messageIds: mergedSession.messageIds,
          project: activeProject ?? null,
          updateBlock: (messageId, blockIndex, patch) => {
            const snap = stateRef.current;
            const sessionMessages = {
              ...(snap.messagesBySession[sessionId] ?? {}),
            };
            const existing = sessionMessages[messageId];
            if (!existing) return;
            sessionMessages[messageId] = {
              ...existing,
              blocks: existing.blocks.map((b, i) =>
                i === blockIndex ? ({ ...b, ...patch } as MessageBlock) : b,
              ),
              updatedAt: Date.now(),
            };
            persist({
              ...snap,
              messagesBySession: {
                ...snap.messagesBySession,
                [sessionId]: sessionMessages,
              },
            });
          },
        });
        return true;
      } catch (err) {
        showToast('加载对话失败，请重试', { type: 'error' });
        return false;
      }
    },
    [activeProject, persist, rootPath, showToast],
  );

  const loadMoreSessions = useCallback(async () => {
    if (loadingMoreSessions) {
      return;
    }
    const cursor = sessionsNextCursorRef.current;
    if (!cursor) return;
    setLoadingMoreSessions(true);
    try {
      const page = await fetchAgentSessionsPage(currentUserIdRef.current, {
        cursor,
        annotationProjectId: activeProjectIdRef.current,
        workspaceOnly: !activeProjectIdRef.current,
      });
      sessionsNextCursorRef.current = page.nextCursor;
      setSessionsHasMore(page.hasMore);
      const latest = stateRef.current;
      const sessions = { ...latest.sessions };
      const messagesBySession = { ...latest.messagesBySession };
      const orderSeen = new Set(latest.sessionOrder);
      const sessionOrder = [...latest.sessionOrder];
      for (const session of page.sessions) {
        if (!sessionBelongsToProject(session, activeProjectIdRef.current)) {
          continue;
        }
        sessions[session.id] = mergeSessionFromRemote(
          latest.sessions[session.id],
          {
            ...session,
            activeJobId: latest.sessions[session.id]?.activeJobId,
          },
        );
        if (!messagesBySession[session.id]) {
          messagesBySession[session.id] = {};
        }
        if (!orderSeen.has(session.id)) {
          orderSeen.add(session.id);
          sessionOrder.push(session.id);
        }
      }
      persist({ ...latest, sessions, sessionOrder, messagesBySession });
    } catch {
      showToast('加载更多历史失败', { type: 'error' });
    } finally {
      setLoadingMoreSessions(false);
    }
  }, [
    loadingMoreSessions,
    persist,
    sessionsHasMore,
    showToast,
    activeProject?.id,
  ]);

  const loadOlderMessages = useCallback(
    async (sessionId?: string) => {
      const targetId = sessionId ?? stateRef.current.activeSessionId;
      if (!targetId || loadingOlderMessages) {
        return;
      }
      const { current } = stateRef;
      const session = current.sessions[targetId];
      if (!session?.hasMoreMessagesBefore) return;
      const oldestId = session.messageIds[0];
      if (!oldestId) return;

      setLoadingOlderMessages(true);
      try {
        const detail = await fetchAgentSessionDetail(
          currentUserIdRef.current,
          targetId,
          {
            beforeMessageId: oldestId,
          },
        );
        const latest = stateRef.current;
        const mergedMessages = {
          ...(latest.messagesBySession[targetId] ?? {}),
          ...normalizeHistoricalMessages(detail.messages),
        };
        const newIds = detail.session.messageIds.filter(
          (id) => !session.messageIds.includes(id),
        );
        persist({
          ...latest,
          sessions: {
            ...latest.sessions,
            [targetId]: {
              ...latest.sessions[targetId],
              ...detail.session,
              messageIds: [...newIds, ...session.messageIds],
              activeJobId: session.activeJobId,
            },
          },
          messagesBySession: {
            ...latest.messagesBySession,
            [targetId]: mergedMessages,
          },
        });
      } catch {
        showToast('加载更早消息失败', { type: 'error' });
      } finally {
        setLoadingOlderMessages(false);
      }
    },
    [loadingOlderMessages, persist, showToast],
  );

  const bootstrapProjectAgent = useCallback(async () => {
    const generation = bootstrapGenerationRef.current;
    const userId = currentUserIdRef.current;
    const projectId = activeProjectIdRef.current;
    // 避免项目与用户未变化时重复 bootstrap 的全部流程。
    // 但如果外部依赖（如 defaultProvider）变化导致 callback 被重建，
    // 前一次异步 bootstrap 的结果可能因 generation 检查被丢弃，
    // 此时需要做轻量回复：跳过 DB 清理操作，仅确保 sessions 和草稿标签页有效。
    if (
      bootstrappedProjectIdRef.current === projectId &&
      bootstrappedUserIdRef.current === userId
    ) {
      const remote = await loadLocalAgentChatStateForProject(userId, projectId);
      const { current } = stateRef;
      const ui = getProjectUi(agentUiRef.current, projectId);
      const merged = mergeProjectSessionsIntoState(
        current,
        remote,
        projectId,
        current.openTabIds,
      );
      let { state: nextState, ui: nextUi } = normalizeProjectTabs(
        merged,
        { ...ui, openTabIds: current.openTabIds },
        projectId,
      );

      if (nextUi.openTabIds.length === 0) {
        const provider = defaultProvider;
        const session = createDraftSession(
          projectId,
          provider ? { id: provider.id, model: provider.model } : null,
          getProjectUi(agentUiRef.current, projectId).agentMode,
        );
        nextState = {
          ...nextState,
          sessions: { ...nextState.sessions, [session.id]: session },
          openTabIds: [session.id],
          activeSessionId: session.id,
          messagesBySession: {
            ...nextState.messagesBySession,
            [session.id]: nextState.messagesBySession[session.id] ?? {},
          },
        };
        nextUi = {
          ...nextUi,
          openTabIds: [session.id],
          activeSessionId: session.id,
        };
      }

      sessionsNextCursorRef.current = remote.sessionsNextCursor;
      setSessionsHasMore(remote.sessionsHasMore);
      agentUiRef.current = setProjectUi(agentUiRef.current, projectId, nextUi);
      persistAgentChatUiState(agentUiRef.current);
      persist(nextState);
      setAgentModeState(nextUi.agentMode);
      if (
        nextState.activeSessionId &&
        sessionHasHistoryContent(nextState.activeSessionId, nextState)
      ) {
        void ensureSessionLoaded(nextState.activeSessionId);
      }
      return;
    }
    bootstrappedProjectIdRef.current = projectId;
    bootstrappedUserIdRef.current = userId;

    loadedSessionsRef.current.clear();
    // 登录后将无 user_id 的历史数据归属到当前用户
    if (userId) {
      await backfillLegacyUserIdLocally(userId).catch((err) =>
        console.error('[DB] Failed to backfill legacy user_id:', err),
      );
    }
    // 清理上次未正常完成的 streaming 状态消息
    cleanupStreamingLocally().catch((err) =>
      console.error('[DB] Failed to cleanup streaming messages:', err),
    );
    const remote = await loadLocalAgentChatStateForProject(userId, projectId);
    const ui = getProjectUi(agentUiRef.current, projectId);
    const merged = mergeProjectSessionsIntoState(
      createEmptyChatState(),
      remote,
      projectId,
      ui.openTabIds,
    );
    let { state: nextState, ui: nextUi } = normalizeProjectTabs(
      merged,
      ui,
      projectId,
    );

    if (nextUi.openTabIds.length === 0) {
      const provider = defaultProvider;
      const session = createDraftSession(
        projectId,
        provider ? { id: provider.id, model: provider.model } : null,
        getProjectUi(agentUiRef.current, projectId).agentMode,
      );
      nextState = {
        ...nextState,
        sessions: { ...nextState.sessions, [session.id]: session },
        openTabIds: [session.id],
        activeSessionId: session.id,
        messagesBySession: {
          ...nextState.messagesBySession,
          [session.id]: nextState.messagesBySession[session.id] ?? {},
        },
      };
      nextUi = {
        ...nextUi,
        openTabIds: [session.id],
        activeSessionId: session.id,
      };
    }

    if (
      !shouldApplyBootstrapResult(generation, bootstrapGenerationRef.current)
    ) {
      return;
    }

    sessionsNextCursorRef.current = remote.sessionsNextCursor;
    setSessionsHasMore(remote.sessionsHasMore);
    agentUiRef.current = setProjectUi(agentUiRef.current, projectId, nextUi);
    persistAgentChatUiState(agentUiRef.current);
    persist(nextState);
    setAgentModeState(nextUi.agentMode);
    if (
      nextState.activeSessionId &&
      sessionHasHistoryContent(nextState.activeSessionId, nextState)
    ) {
      void ensureSessionLoaded(nextState.activeSessionId);
    }
  }, [currentUserId, defaultProvider, ensureSessionLoaded, persist]);

  useEffect(() => {
    if (authStatus === 'loading' || authStatus === 'unauthenticated') return;
    if (!window.electron) {
      remoteHydratedRef.current = true;
      return undefined;
    }

    let cancelled = false;
    const generation = ++bootstrapGenerationRef.current;

    (async () => {
      try {
        await bootstrapProjectAgent();
        if (
          !cancelled &&
          shouldApplyBootstrapResult(generation, bootstrapGenerationRef.current)
        ) {
          remoteHydratedRef.current = true;
        }
      } catch (err) {
        if (
          !cancelled &&
          shouldApplyBootstrapResult(generation, bootstrapGenerationRef.current)
        ) {
          showToast('加载对话列表失败，请重试', { type: 'error' });
          remoteHydratedRef.current = true;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeProject?.id,
    authStatus,
    currentUserId,
    bootstrapProjectAgent,
    showToast,
  ]);

  useEffect(() => {
    if (authStatus === 'loading' || authStatus === 'unauthenticated') return;
    if (!remoteHydratedRef.current) return;
    const projectId = activeProject?.id ?? null;
    const ui = getProjectUi(agentUiRef.current, projectId);
    setAgentModeState(ui.agentMode);
    const { current } = stateRef;
    const openTabIds = ui.openTabIds.filter(
      (id) =>
        current.sessions[id] &&
        sessionBelongsToProject(current.sessions[id], projectId),
    );
    let { activeSessionId } = ui;
    if (!activeSessionId || !openTabIds.includes(activeSessionId)) {
      activeSessionId = openTabIds[openTabIds.length - 1] ?? null;
    }
    if (
      openTabIds.join(',') !== current.openTabIds.join(',') ||
      activeSessionId !== current.activeSessionId
    ) {
      persist({ ...current, openTabIds, activeSessionId });
    }
  }, [activeProject?.id, authStatus, persist]);

  const resolveProvider = useCallback(
    (providerId?: string) => {
      if (providerId) {
        const matched = providers.find(
          (item) => item.id === providerId && item.enabled,
        );
        if (matched) return matched;
      }
      return defaultProvider;
    },
    [providers, defaultProvider],
  );

  useEffect(() => {
    if (authStatus === 'loading' || authStatus === 'unauthenticated') return;
    if (initializedRef.current) return;
    initializedRef.current = true;
    const { current } = stateRef;
    if (current.openTabIds.length > 0) return;

    const projectId = activeProject?.id ?? null;
    const provider = defaultProvider;
    const session = createDraftSession(
      projectId,
      provider ? { id: provider.id, model: provider.model } : null,
      getProjectUi(agentUiRef.current, projectId).agentMode,
    );
    const latest = stateRef.current;
    persist({
      ...latest,
      sessions: { ...latest.sessions, [session.id]: session },
      openTabIds: [session.id],
      activeSessionId: session.id,
      messagesBySession: {
        ...latest.messagesBySession,
        [session.id]: {},
      },
    });
  }, [activeProject?.id, authStatus, defaultProvider, persist]);

  const updateMessage = useCallback(
    (
      sessionId: string,
      messageId: string,
      updater: (message: ChatMessage) => ChatMessage,
    ) => {
      const { current } = stateRef;
      const sessionMessages = {
        ...(current.messagesBySession[sessionId] ?? {}),
      };
      const existing = sessionMessages[messageId];
      if (!existing) return;
      sessionMessages[messageId] = updater(existing);
      persist({
        ...current,
        messagesBySession: {
          ...current.messagesBySession,
          [sessionId]: sessionMessages,
        },
      });
    },
    [persist],
  );

  const updateMessageBlocks = useCallback(
    (
      sessionId: string,
      messageId: string,
      updater: (blocks: MessageBlock[]) => MessageBlock[],
    ) => {
      updateMessage(sessionId, messageId, (message) => ({
        ...message,
        blocks: updater(message.blocks),
        updatedAt: Date.now(),
      }));
    },
    [updateMessage],
  );

  /**
   * 点击 Keep All / Undo 时立即把 awaiting 消息切回 streaming（带阶段提示），
   * 消除「apply 写盘 + resume 建连」期间 UI 停在「等待确认」的空窗。
   * 返回被切换的消息 id，供失败兜底恢复；无 awaiting 消息时返回 null。
   */
  const promoteAwaitingMessageToStreaming = useCallback(
    (sessionId: string, phase: ChatStreamPhase): string | null => {
      const latest = stateRef.current;
      const messagesMap = latest.messagesBySession[sessionId] ?? {};
      const ids = resolveSessionMessageIds(
        latest.sessions[sessionId],
        messagesMap,
      );
      for (let i = ids.length - 1; i >= 0; i -= 1) {
        const msg = messagesMap[ids[i]];
        if (
          msg?.role === 'assistant' &&
          msg.status === 'awaiting_confirmation'
        ) {
          updateMessage(sessionId, msg.id, (m) => ({
            ...m,
            status: 'streaming',
            streamPhase: phase,
            // 重新计时：awaiting 时写过的 finishedAt 会让 Worked for 偏小
            finishedAt: undefined,
            updatedAt: Date.now(),
          }));
          return msg.id;
        }
      }
      return null;
    },
    [updateMessage],
  );

  /** promote 的失败兜底：把消息恢复为 awaiting（可重试）或落 done（无 job 可续跑）。 */
  const settlePromotedMessage = useCallback(
    (
      sessionId: string,
      messageId: string,
      outcome: 'awaiting_confirmation' | 'done',
    ) => {
      updateMessage(sessionId, messageId, (m) => ({
        ...m,
        status: outcome,
        streamPhase: null,
        finishedAt: m.finishedAt ?? Date.now(),
        updatedAt: Date.now(),
      }));
    },
    [updateMessage],
  );

  const attachJobListener = useCallback(
    (jobId: string, sessionId: string, messageId: string) => {
      return subscribeJobEvents(jobId, (event) => {
        // awaiting_confirmation：提案待用户确认（HITL 断点），turn 暂停而非完成。
        // 消息置为 awaiting_confirmation（不显示 Files Changed/工具栏），
        // job 保留在注册表中，Keep All/Dismiss 后在同一 messageId 上续跑。
        if (event.type === 'done' || event.type === 'awaiting_confirmation') {
          const isAwaitingConfirm = event.type === 'awaiting_confirmation';
          const nextStatus = isAwaitingConfirm
            ? ('awaiting_confirmation' as const)
            : ('done' as const);
          const latest = stateRef.current;
          const sessionMessages = {
            ...(latest.messagesBySession[sessionId] ?? {}),
          };
          const existing = sessionMessages[messageId];
          if (!existing) return;

          sessionMessages[messageId] = {
            ...existing,
            status: nextStatus,
            updatedAt: Date.now(),
            finishedAt: existing.finishedAt ?? Date.now(),
            blocks: finalizeSubagentBlocks(
              existing.blocks.map((block) => {
                if (block.type === 'annotation_pipeline') {
                  return finalizeAnnotationPipelineBlock(block, 'done');
                }
                if (block.type === 'tool_call') {
                  // 客户端异步工具没有真实 tool_result，turn 结束（含 awaiting）
                  // 时收掉其 queued/running 状态，避免工具行永远「进行中」
                  const settle =
                    CLIENT_TOOL_NAME_SET.has(block.name) &&
                    (block.status === 'queued' || block.status === 'running');
                  return settle
                    ? { ...block, collapsed: true, status: 'done' as const }
                    : { ...block, collapsed: true };
                }
                if (block.type === 'reasoning') {
                  return { ...block, collapsed: true };
                }
                return block;
              }),
              'error',
            ),
          };

          const session = latest.sessions[sessionId];
          persist({
            ...latest,
            messagesBySession: {
              ...latest.messagesBySession,
              [sessionId]: sessionMessages,
            },
            sessions: session
              ? {
                  ...latest.sessions,
                  [sessionId]: {
                    ...session,
                    activeJobId: undefined,
                    updatedAt: Date.now(),
                  },
                }
              : latest.sessions,
          });
          // 写入最终 blocks 到 SQLite
          const finalMsg =
            stateRef.current.messagesBySession[sessionId]?.[messageId];
          if (finalMsg) {
            updateMessageLocally(messageId, {
              blocksJson: JSON.stringify(finalMsg.blocks),
              status: nextStatus,
            }).catch((err) =>
              console.error('[DB] Failed to update message:', err),
            );
          }
          return;
        }

        if (event.type === 'error') {
          const latest = stateRef.current;
          const sessionMessages = {
            ...(latest.messagesBySession[sessionId] ?? {}),
          };
          const existing = sessionMessages[messageId];
          if (!existing) return;

          sessionMessages[messageId] = {
            ...existing,
            status: 'error',
            error: translateError(event.message),
            updatedAt: Date.now(),
            finishedAt: existing.finishedAt ?? Date.now(),
            blocks: finalizeSubagentBlocks(
              existing.blocks.map((block) =>
                block.type === 'annotation_pipeline'
                  ? {
                      ...block,
                      collapsed: true,
                      steps: block.steps.map((s) =>
                        s.status === 'running'
                          ? { ...s, status: 'error' as const }
                          : s,
                      ),
                    }
                  : block,
              ),
              'error',
            ),
          };

          const session = latest.sessions[sessionId];
          persist({
            ...latest,
            messagesBySession: {
              ...latest.messagesBySession,
              [sessionId]: sessionMessages,
            },
            sessions: session
              ? {
                  ...latest.sessions,
                  [sessionId]: {
                    ...session,
                    activeJobId: undefined,
                    updatedAt: Date.now(),
                  },
                }
              : latest.sessions,
          });
          // 写入 error 到 SQLite
          const errMsg =
            stateRef.current.messagesBySession[sessionId]?.[messageId];
          if (errMsg) {
            updateMessageLocally(messageId, {
              blocksJson: JSON.stringify(errMsg.blocks),
              status: 'error',
              error: errMsg.error,
            }).catch((err) =>
              console.error('[DB] Failed to update message:', err),
            );
          }
          return;
        }

        if (event.type === 'context_updated') {
          const latest = stateRef.current;
          const session = latest.sessions[sessionId];
          if (!session) return;

          persist({
            ...latest,
            sessions: {
              ...latest.sessions,
              [sessionId]: {
                ...session,
                contextSummary: event.summary,
                summaryUpToMessageId:
                  ((event as Record<string, unknown>).summaryUpToMessageId as
                    string | undefined) ??
                  ((event as Record<string, unknown>)
                    .summary_up_to_message_id as string | undefined),
                lastContextTokenEstimate:
                  ((event as Record<string, unknown>).tokenEstimate as
                    number | undefined) ??
                  ((event as Record<string, unknown>).token_estimate as
                    number | undefined),
                updatedAt: Date.now(),
              },
            },
          });
          return;
        }

        if (event.type === 'preparing') {
          // 后端已接单、正在向模型发起流式调用：空窗期提示“等待模型响应”
          updateMessage(sessionId, messageId, (message) => ({
            ...message,
            streamPhase: 'waiting-model',
            updatedAt: Date.now(),
          }));
          return;
        }

        if (event.type === 'route_decided') {
          return;
        }

        updateMessage(sessionId, messageId, (message) => ({
          ...message,
          status: 'streaming',
          streamPhase: null,
          blocks: applyStreamEventToBlocks(message.blocks, event),
          updatedAt: Date.now(),
        }));
      });
    },
    [persist, updateMessage],
  );

  const createSession = useCallback(() => {
    const { current } = stateRef;
    const provider = defaultProvider;
    const session = createDraftSession(
      activeProject?.id ?? null,
      provider ? { id: provider.id, model: provider.model } : null,
      agentMode,
    );
    setActivePanelTab({ kind: 'session', sessionId: session.id });
    persist({
      ...current,
      sessions: { ...current.sessions, [session.id]: session },
      openTabIds: [...current.openTabIds, session.id],
      activeSessionId: session.id,
      messagesBySession: {
        ...current.messagesBySession,
        [session.id]: current.messagesBySession[session.id] ?? {},
      },
    });
    setEditTargetMessageId(null);
    setComposerDraft('');
    return session.id;
  }, [activeProject?.id, agentMode, defaultProvider, persist]);

  const switchSession = useCallback(
    (sessionId: string) => {
      const { current } = stateRef;
      if (!current.sessions[sessionId]) return;
      setActivePanelTab({ kind: 'session', sessionId });
      persist({ ...current, activeSessionId: sessionId });
      setEditTargetMessageId(null);
      setComposerDraft('');
      void ensureSessionLoaded(sessionId);
    },
    [persist, ensureSessionLoaded],
  );

  const openSessionTab = useCallback(
    (sessionId: string) => {
      const { current } = stateRef;
      if (!current.sessions[sessionId]) return;
      const openTabIds = current.openTabIds.includes(sessionId)
        ? current.openTabIds
        : [...current.openTabIds, sessionId];
      setActivePanelTab({ kind: 'session', sessionId });
      persist({
        ...current,
        openTabIds,
        activeSessionId: sessionId,
      });
      setHistoryOpen(false);
      setEditTargetMessageId(null);
      setComposerDraft('');
      void ensureSessionLoaded(sessionId);
    },
    [persist, ensureSessionLoaded],
  );

  const closeTab = useCallback(
    (sessionId: string) => {
      const { current } = stateRef;
      const openTabIds = current.openTabIds.filter((id) => id !== sessionId);
      let { activeSessionId } = current;
      if (activeSessionId === sessionId) {
        activeSessionId = openTabIds[openTabIds.length - 1] ?? null;
      }

      let { sessions } = current;
      let { sessionOrder } = current;
      let { messagesBySession } = current;
      if (!sessionHasHistoryContent(sessionId, current)) {
        const { [sessionId]: _removed, ...restSessions } = sessions;
        sessions = restSessions;
        const { [sessionId]: _msgs, ...restMessages } = messagesBySession;
        messagesBySession = restMessages;
        sessionOrder = sessionOrder.filter((id) => id !== sessionId);
      }

      if (openTabIds.length === 0) {
        const provider = defaultProvider;
        const session = createDraftSession(
          activeProject?.id ?? null,
          provider ? { id: provider.id, model: provider.model } : null,
          agentMode,
        );
        setActivePanelTab({ kind: 'session', sessionId: session.id });
        persist({
          ...current,
          sessions: { ...sessions, [session.id]: session },
          sessionOrder,
          openTabIds: [session.id],
          activeSessionId: session.id,
          messagesBySession: { ...messagesBySession, [session.id]: {} },
        });
        return;
      }
      if (activeSessionId) {
        setActivePanelTab({ kind: 'session', sessionId: activeSessionId });
      }
      persist({
        ...current,
        sessions,
        sessionOrder,
        openTabIds,
        activeSessionId,
        messagesBySession,
      });
    },
    [activeProject?.id, agentMode, defaultProvider, persist],
  );

  const openSubagentTab = useCallback((runId: string, sessionId: string) => {
    const tab: Extract<AgentPanelTab, { kind: 'subagent' }> = {
      kind: 'subagent',
      runId,
      sessionId,
    };
    setOpenSubagentTabs((tabs) =>
      tabs.some((item) => item.runId === runId) ? tabs : [...tabs, tab],
    );
    setActivePanelTab(tab);
  }, []);

  const switchPanelTab = useCallback(
    (tab: AgentPanelTab) => {
      setActivePanelTab(tab);
      if (tab.kind === 'session') {
        switchSession(tab.sessionId);
      }
    },
    [switchSession],
  );

  const closePanelTab = useCallback(
    (tab: AgentPanelTab) => {
      if (tab.kind === 'session') {
        closeTab(tab.sessionId);
        return;
      }
      setOpenSubagentTabs((tabs) =>
        tabs.filter((item) => item.runId !== tab.runId),
      );
      setActivePanelTab((current) => {
        if (current?.kind === 'subagent' && current.runId === tab.runId) {
          return { kind: 'session', sessionId: tab.sessionId };
        }
        return current;
      });
    },
    [closeTab],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const { current } = stateRef;
      const session = current.sessions[sessionId];
      if (session?.activeJobId && isJobRunning(session.activeJobId)) {
        stopJob(session.activeJobId);
      }

      if (sessionHasHistoryContent(sessionId, current)) {
        deleteAgentSessionRemote(currentUserIdRef.current, sessionId).catch(
          (err) => console.error('[DB] Failed to delete session:', err),
        );
      }

      loadedSessionsRef.current.delete(sessionId);

      const { [sessionId]: _removed, ...sessions } = current.sessions;
      const { [sessionId]: _msgs, ...messagesBySession } =
        current.messagesBySession;
      const sessionOrder = current.sessionOrder.filter(
        (id) => id !== sessionId,
      );
      const openTabIds = current.openTabIds.filter((id) => id !== sessionId);
      let { activeSessionId } = current;
      if (activeSessionId === sessionId) {
        activeSessionId = openTabIds[openTabIds.length - 1] ?? null;
      }
      if (openTabIds.length === 0) {
        const provider = defaultProvider;
        const session = createDraftSession(
          activeProject?.id ?? null,
          provider ? { id: provider.id, model: provider.model } : null,
          agentMode,
        );
        setOpenSubagentTabs((tabs) =>
          tabs.filter((tab) => tab.sessionId !== sessionId),
        );
        setActivePanelTab({ kind: 'session', sessionId: session.id });
        persist({
          sessions: { ...sessions, [session.id]: session },
          sessionOrder,
          openTabIds: [session.id],
          activeSessionId: session.id,
          messagesBySession: { ...messagesBySession, [session.id]: {} },
        });
        return;
      }
      setOpenSubagentTabs((tabs) =>
        tabs.filter((tab) => tab.sessionId !== sessionId),
      );
      if (activeSessionId) {
        setActivePanelTab({ kind: 'session', sessionId: activeSessionId });
      }
      persist({
        sessions,
        sessionOrder,
        openTabIds,
        activeSessionId,
        messagesBySession,
      });
      if (
        activeSessionId &&
        sessionHasHistoryContent(activeSessionId, {
          sessions,
          messagesBySession,
        })
      ) {
        void ensureSessionLoaded(activeSessionId);
      }
    },
    [
      activeProject?.id,
      agentMode,
      defaultProvider,
      ensureSessionLoaded,
      persist,
      showToast,
    ],
  );

  const stopGeneration = useCallback(
    (sessionId?: string) => {
      const { current } = stateRef;
      const targetSessionId = sessionId ?? current.activeSessionId;
      if (!targetSessionId) return;
      const session = current.sessions[targetSessionId];
      if (!session?.activeJobId) return;
      stopJob(session.activeJobId);
      const assistantId = session.messageIds[session.messageIds.length - 1];
      const sessionMessages = {
        ...(current.messagesBySession[targetSessionId] ?? {}),
      };
      if (assistantId && sessionMessages[assistantId]) {
        const existing = sessionMessages[assistantId];
        sessionMessages[assistantId] = {
          ...existing,
          status: 'stopped',
          updatedAt: Date.now(),
          finishedAt: existing.finishedAt ?? Date.now(),
          // 手动停止时收掉排队/执行中的客户端标注工具块，避免永久「排队中」
          blocks: finalizeSubagentBlocks(
            existing.blocks.map((block) =>
              block.type === 'tool_call' &&
              CLIENT_TOOL_NAME_SET.has(block.name) &&
              (block.status === 'queued' || block.status === 'running')
                ? { ...block, status: 'error' as const, collapsed: true }
                : block,
            ),
            'error',
          ),
        };
      }
      persist({
        ...current,
        messagesBySession: {
          ...current.messagesBySession,
          [targetSessionId]: sessionMessages,
        },
        sessions: {
          ...current.sessions,
          [targetSessionId]: {
            ...session,
            activeJobId: undefined,
            updatedAt: Date.now(),
          },
        },
      });
    },
    [persist],
  );

  /**
   * 兜底：把会话中停在 awaiting_confirmation 的 assistant 消息落为 done。
   * 用于 Keep All/Dismiss 时已无挂起 job 可续跑（如应用重启后），
   * 或用户直接发新消息丢弃断点的场景，避免 Files Changed 永远不显示。
   */
  const finalizeAwaitingConfirmationMessages = useCallback(
    (sessionId: string) => {
      const latest = stateRef.current;
      const messagesMap = latest.messagesBySession[sessionId] ?? {};
      const ids = resolveSessionMessageIds(
        latest.sessions[sessionId],
        messagesMap,
      );
      const staleIds = ids.filter((id) => {
        const msg = messagesMap[id];
        return (
          msg?.role === 'assistant' && msg.status === 'awaiting_confirmation'
        );
      });
      if (staleIds.length === 0) return;
      const now = Date.now();
      const nextMessages = { ...messagesMap };
      for (const id of staleIds) {
        const msg = nextMessages[id];
        nextMessages[id] = {
          ...msg,
          status: 'done',
          updatedAt: now,
          finishedAt: msg.finishedAt ?? now,
        };
      }
      persist({
        ...latest,
        messagesBySession: {
          ...latest.messagesBySession,
          [sessionId]: nextMessages,
        },
      });
      for (const id of staleIds) {
        updateMessageLocally(id, { status: 'done' }).catch((err) =>
          console.error('[DB] Failed to finalize awaiting message:', err),
        );
      }
    },
    [persist],
  );

  const sendMessage = useCallback(
    async (content: string, options?: { editMessageId?: string }) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      const { current } = stateRef;
      const sessionId = current.activeSessionId;
      if (!sessionId) return;

      const wasDraft = !sessionHasHistoryContent(sessionId, current);

      if (!wasDraft) {
        const loaded = await ensureSessionLoaded(sessionId);
        if (!loaded) return;
      }

      const session = stateRef.current.sessions[sessionId];
      if (!session) return;

      if (session.activeJobId && isJobRunning(session.activeJobId)) {
        showToast('当前任务仍在进行，请先停止后再发送', { type: 'info' });
        return;
      }

      const selectedProvider = resolveProvider(session.providerId);
      if (!selectedProvider) return;

      const editMessageId =
        options?.editMessageId ?? editTargetMessageId ?? null;
      const isEdit = Boolean(editMessageId);

      const now = Date.now();
      let messageIds = [...session.messageIds];
      const sessionMessages = {
        ...(stateRef.current.messagesBySession[sessionId] ?? {}),
      };

      let truncateFromMessageId: string | null = null;
      let sessionForContext: AgentSession = { ...session };
      let newUserMessageId: string | null = null;

      if (editMessageId) {
        const editIndex = messageIds.indexOf(editMessageId);
        if (editIndex >= 0) {
          const pendingRemoveIds = messageIds.slice(editIndex + 1);
          const pendingRemoveMessages = pendingRemoveIds
            .map((id) => sessionMessages[id])
            .filter((message): message is ChatMessage => Boolean(message));
          const appliedRefs = collectAppliedProposalRefs(
            pendingRemoveMessages,
            pendingRemoveIds,
          );
          const rollback = await decideEditRollback({
            refs: appliedRefs,
            getBlock: (ref) =>
              sessionMessages[ref.messageId]?.blocks[ref.blockIndex],
          });
          if (rollback.action === 'abort') {
            return;
          }
          let skippedRollback = rollback.skipped > 0;
          if (rollback.restorable.length > 0) {
            const restorePaths = rollback.restorable.flatMap((ref) => {
              const block =
                sessionMessages[ref.messageId]?.blocks[ref.blockIndex];
              if (!block) return [];
              if (block.type === 'annotation_proposal') {
                return annotationPathsFromBlock(block);
              }
              if (isFileProposalBlock(block)) {
                return [block.suggestedRelativePath];
              }
              return [];
            });
            if (
              !confirmDirtyWorkspaceIfNeeded(
                restorePaths,
                activeProject?.id ?? null,
              )
            ) {
              return;
            }
            const restored = await restoreAppliedCheckpoints({
              refs: rollback.restorable,
              project: activeProject ?? null,
              workspaceRoot: rootPath,
              newestFirst: true,
              continueOnSkippable: true,
            });
            if (!restored.ok) {
              showToast(formatRestoreError(restored), { type: 'error' });
              return;
            }
            if ((restored.skipped ?? 0) > 0) {
              skippedRollback = true;
            }
            await syncWorkspaceFactMemory(activeProject);
            if (activeProject && restored.restoredPaths.length > 0) {
              dispatchMutationsAppliedEvent(
                activeProject.id,
                restored.restoredPaths,
                { force: true },
              );
            }
          }
          if (skippedRollback) {
            showToast('已跳过无法回滚的改动，磁盘内容将保留', {
              type: 'info',
            });
          }
          truncateFromMessageId = editMessageId;
          const clearSummary = shouldClearSummaryOnEdit(
            session,
            messageIds,
            editMessageId,
          );
          const removedIds = messageIds.slice(editIndex + 1);
          messageIds = messageIds.slice(0, editIndex + 1);
          for (const removedId of removedIds) {
            delete sessionMessages[removedId];
          }
          // 同步清理 SQLite 中编辑点之后的废弃消息
          deleteMessagesAfterIdLocally(sessionId, editMessageId).catch((err) =>
            console.error('[DB] Failed to cleanup after edit:', err),
          );
          sessionMessages[editMessageId] = {
            ...sessionMessages[editMessageId],
            blocks: [{ type: 'text', content: trimmed }],
            updatedAt: now,
          };
          if (clearSummary) {
            sessionForContext = {
              ...sessionForContext,
              contextSummary: undefined,
              summaryUpToMessageId: undefined,
            };
          }
        }
        setEditTargetMessageId(null);
        setEditDraft('');
      } else {
        const userMessageId = createAgentId('msg');
        newUserMessageId = userMessageId;
        const userMessage: ChatMessage = {
          id: userMessageId,
          sessionId,
          role: 'user',
          blocks: [{ type: 'text', content: trimmed }],
          status: 'done',
          interactionMode: agentMode,
          providerId: selectedProvider.id,
          model: selectedProvider.model,
          createdAt: now,
          updatedAt: now,
        };
        sessionMessages[userMessageId] = userMessage;
        messageIds.push(userMessageId);
      }

      // 确认将发出新任务后再丢掉 HITL 断点，避免用户取消回滚确认后 job 已被销毁
      discardAwaitingConfirmation(sessionId);
      finalizeAwaitingConfirmationMessages(sessionId);

      const userMessageIdForJob = resolveUserMessageIdForJob({
        editMessageId,
        newUserMessageId,
      });
      const assistantMessageId = createAgentId('msg');
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        blocks: [],
        status: 'streaming',
        streamPhase: 'preparing-context',
        interactionMode: agentMode,
        providerId: selectedProvider.id,
        model: selectedProvider.model,
        createdAt: now + 1,
        updatedAt: now + 1,
      };
      sessionMessages[assistantMessageId] = assistantMessage;
      messageIds.push(assistantMessageId);

      const jobId = createAgentId('job');
      const nextTitle =
        session.title === '新对话' || isEdit
          ? buildSessionTitle(trimmed)
          : session.title;

      const nextSession: AgentSession = {
        ...sessionForContext,
        title: nextTitle,
        providerId: selectedProvider.id,
        model: selectedProvider.model,
        messageIds,
        activeJobId: jobId,
        updatedAt: now,
      };

      persist({
        ...current,
        sessions: { ...current.sessions, [sessionId]: nextSession },
        sessionOrder: [
          sessionId,
          ...current.sessionOrder.filter((id) => id !== sessionId),
        ],
        messagesBySession: {
          ...current.messagesBySession,
          [sessionId]: sessionMessages,
        },
      });

      // ── 同步到 SQLite ──
      // 必须按 session → 用户消息 → 助手消息的顺序 await：否则后续 update 可能
      // 先于 create 落到不存在的行，而 update 对缺失行是静默 no-op，会丢更新。
      // 首次发消息：创建 session
      if (wasDraft) {
        await createSessionLocally(currentUserIdRef.current, {
          id: sessionId,
          title: nextTitle,
          annotationProjectId:
            current.sessions[sessionId].annotationProjectId ??
            activeProject?.id ??
            null,
          interactionMode: agentMode,
          providerId: selectedProvider.id,
          model: selectedProvider.model,
        }).catch((err) => console.error('[DB] Failed to create session:', err));
      }

      // 用户消息：编辑时 update 已有消息，否则 create 新消息
      const userMessageData = sessionMessages[userMessageIdForJob];
      if (userMessageData) {
        if (isEdit) {
          await updateMessageLocally(userMessageData.id, {
            blocksJson: JSON.stringify(userMessageData.blocks),
          }).catch((err) =>
            console.error('[DB] Failed to update user message:', err),
          );
        } else {
          await createMessageLocally({
            id: userMessageData.id,
            sessionId,
            userId: currentUserIdRef.current,
            role: userMessageData.role,
            interactionMode: userMessageData.interactionMode,
            blocksJson: JSON.stringify(userMessageData.blocks),
            status: userMessageData.status,
            providerId: userMessageData.providerId,
            model: userMessageData.model,
          }).catch((err) =>
            console.error('[DB] Failed to create user message:', err),
          );
        }
      }

      // 助手消息占位
      await createMessageLocally({
        id: assistantMessageId,
        sessionId,
        userId: currentUserIdRef.current,
        role: 'assistant',
        blocksJson: '[]',
        status: 'streaming',
        providerId: selectedProvider.id,
        model: selectedProvider.model,
      }).catch((err) =>
        console.error('[DB] Failed to create assistant message:', err),
      );

      // 消息已进入内存态，输入框立即清空，不必等 IPC 落库
      setComposerDraft('');

      attachJobListener(jobId, sessionId, assistantMessageId);
      setPreparingContext(true);
      // 异步获取本地 MCP Server URL + 用户启用的远程 MCP（Electron 环境下可用）
      const mcpBridge = (
        window as Window &
          typeof globalThis & {
            electron?: {
              mcp?: {
                getServerUrl?: () => Promise<{
                  url: string;
                  token: string;
                } | null>;
                getEnabledServers?: () => Promise<McpServerConfig[] | null>;
              };
            };
          }
      ).electron?.mcp;
      const localMcp = (await mcpBridge?.getServerUrl?.()) ?? null;
      const mcpServerUrl: string | null = localMcp?.url ?? null;
      const mcpServerToken: string | null = localMcp?.token ?? null;
      const remoteMcpServers: McpServerConfig[] =
        (await mcpBridge?.getEnabledServers?.().catch(() => null)) ?? [];

      // 项目级指令：标注模式读项目目录，编辑器模式读工作区根目录
      const instructionsDir =
        workMode === 'annotation' && activeProject
          ? activeProject.directoryPath
          : rootPath;
      const projectInstructions =
        await loadProjectInstructions(instructionsDir);

      // 工作区记忆：仅标注模式且任务开关打开时注入索引并激活 MCP memory 工具
      const workspaceMemoryEnabled =
        workMode === 'annotation' &&
        Boolean(activeProject?.workspaceMemoryEnabled);
      let memoryIndex: string | null = null;
      const memoryScopeKey = workspaceMemoryEnabled
        ? computeMemoryScopeKey(activeProject?.id)
        : null;
      if (memoryScopeKey) {
        await syncWorkspaceFactMemory(activeProject);
        memoryIndex = await loadMemoryIndex(memoryScopeKey);
      } else {
        await setWorkspaceMemoryActive(false);
      }

      // 全局 Skills catalog：扫描 ~/.agents/skills，注入 system prompt（失败返回空数组不阻塞）
      const skillsCatalog = await loadSkillsCatalog();

      const sessionMessagesForLedger = Object.values(sessionMessages).filter(
        (message): message is ChatMessage => Boolean(message),
      );
      const clientContext = buildClientContextPayload({
        rootPath,
        activeFilePath,
        activeProject: activeProject ?? null,
        agentMode,
        workMode,
        detectionModels: pretrainedModels,
        mcpServerUrl,
        mcpServerToken,
        mcpServers: remoteMcpServers,
        projectInstructions,
        memoryIndex,
        workspaceMemoryEnabled,
        skillsCatalog,
        proposalLedger: buildProposalLedger(sessionMessagesForLedger),
        proposalStates: buildProposalStates(sessionMessagesForLedger),
      });

      // Turn understanding removed — now handled locally or skipped

      // ── 上下文准备：窗口裁剪 + 自动摘要（失败降级为纯裁剪，不阻塞发送） ──
      let sessionForJob: AgentSession = nextSession;
      let messageIdsForJob = messageIds;
      try {
        const prepared = await prepareChatContext({
          session: nextSession,
          messageIds,
          sessionMessages,
          currentUserContent: trimmed,
          provider: {
            baseUrl: selectedProvider.baseUrl,
            apiKey: selectedProvider.apiKey,
            model: selectedProvider.model,
          },
          excludeMessageIds: new Set([assistantMessageId]),
          modelContextWindowTokens: selectedProvider.contextWindowTokens,
          // 摘要真正触发时更新空窗提示（仅此时 summarizeFn 才会被调用）；
          // 配置了辅助模型时摘要走辅助模型凭据，否则跟随会话模型
          summarizeFn: (summarizeOptions) => {
            updateMessage(sessionId, assistantMessageId, (message) => ({
              ...message,
              streamPhase: 'summarizing',
              updatedAt: Date.now(),
            }));
            return summarizeConversation(
              auxiliaryProvider
                ? {
                    ...summarizeOptions,
                    baseUrl: auxiliaryProvider.baseUrl,
                    apiKey: auxiliaryProvider.apiKey,
                    model: auxiliaryProvider.model,
                  }
                : summarizeOptions,
            );
          },
        });
        messageIdsForJob = prepared.windowedMessageIds;
        if (prepared.summarized && prepared.contextSummary) {
          sessionForJob = {
            ...nextSession,
            contextSummary: prepared.contextSummary,
            summaryUpToMessageId: prepared.summaryUpToMessageId,
            lastContextTokenEstimate: prepared.tokenEstimate,
          };
          const latest = stateRef.current;
          const latestSession = latest.sessions[sessionId];
          if (latestSession) {
            persist({
              ...latest,
              sessions: {
                ...latest.sessions,
                [sessionId]: {
                  ...latestSession,
                  contextSummary: prepared.contextSummary,
                  summaryUpToMessageId: prepared.summaryUpToMessageId,
                  lastContextTokenEstimate: prepared.tokenEstimate,
                  updatedAt: Date.now(),
                },
              },
            });
          }
          patchAgentSessionRemote(currentUserIdRef.current, sessionId, {
            contextSummary: prepared.contextSummary,
            summaryUpToMessageId: prepared.summaryUpToMessageId,
            lastContextTokenEstimate: prepared.tokenEstimate,
          }).catch((err) =>
            console.error('[DB] Failed to persist context summary:', err),
          );
        } else if (prepared.tokenEstimate) {
          sessionForJob = {
            ...nextSession,
            lastContextTokenEstimate: prepared.tokenEstimate,
          };
        }
      } catch (err) {
        console.warn('[AgentChat] 上下文准备失败，使用全量消息:', err);
      }

      // 构建客户端工具上下文（有标注项目时传入，供 Agent 调用客户端工具使用）
      let conversationTranscript = '';
      if (workMode === 'annotation' && activeProject) {
        const toolTurnCtx = buildTurnContextFromState(
          sessionForJob,
          messageIdsForJob,
          { [sessionId]: Object.values(sessionMessages) },
          { excludeMessageIds: new Set([assistantMessageId]) },
        );
        conversationTranscript = toolTurnCtx.summary
          ? `【此前对话摘要】${toolTurnCtx.summary}\n${toolTurnCtx.transcript}`
          : toolTurnCtx.transcript;
      }
      const clientToolContext: ClientToolContext | null =
        workMode === 'annotation' && activeProject
          ? {
              project: buildAnnotationProjectSnapshot(
                activeProject,
                pretrainedModels,
              ),
              detectionModels: pretrainedModels,
              currentFileAbsolutePath: activeFilePath,
              conversationTranscript,
              pendingAnnotationChanges: collectPendingAnnotationChanges(
                Object.values(sessionMessages).filter(
                  (message): message is ChatMessage => Boolean(message),
                ),
              ),
            }
          : null;

      // Debug: 发送前上下文摘要
      if (typeof window !== 'undefined' && (window as any).__LR_AGENT_DEBUG__) {
        const displayContent =
          trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
        console.log(
          '%c[LR-Agent]%c 📤 发送消息 %c"%s"%c (session=%s provider=%s)',
          'color: #ff9800; font-weight:bold;',
          '',
          'color: #e0e0e0;',
          displayContent,
          '',
          sessionId.slice(0, 12),
          selectedProvider.id.slice(0, 12),
        );
      }

      try {
        // 请求即将发出：进入等待模型阶段（后端 preparing 事件会再次确认该状态）
        updateMessage(sessionId, assistantMessageId, (message) => ({
          ...message,
          streamPhase: 'waiting-model',
          updatedAt: Date.now(),
        }));
        await startChatJob({
          jobId,
          session: sessionForJob,
          messageIds: messageIdsForJob,
          sessionMessages,
          providerId: selectedProvider.id,
          providerBaseUrl: selectedProvider.baseUrl,
          providerApiKey: selectedProvider.apiKey,
          providerModel: selectedProvider.model,
          providerSupportsVision: selectedProvider.supportsVision,
          auxiliaryProvider: auxiliaryProvider
            ? {
                baseUrl: auxiliaryProvider.baseUrl,
                apiKey: auxiliaryProvider.apiKey,
                model: auxiliaryProvider.model,
              }
            : null,
          userMessageId: userMessageIdForJob,
          assistantMessageId,
          userContent: trimmed,
          truncateFromMessageId,
          clientContext,
          clientToolContext,
          // resume 前重建台账/结构化状态：提案确认状态在 job 启动后才会变化
          refreshClientContext: async () => {
            const latest = stateRef.current;
            const latestMap = latest.messagesBySession[sessionId] ?? {};
            const latestIds = resolveSessionMessageIds(
              latest.sessions[sessionId],
              latestMap,
            );
            const latestMessages = latestIds
              .map((id) => latestMap[id])
              .filter((message): message is ChatMessage => Boolean(message));
            return {
              ...clientContext,
              proposalLedger: buildProposalLedger(latestMessages),
              proposalStates: buildProposalStates(latestMessages),
            };
          },
        });
      } catch (err) {
        updateMessage(sessionId, assistantMessageId, (message) => ({
          ...message,
          status: 'error',
          error: resolveErrorMessage(err, '对话请求失败'),
          updatedAt: Date.now(),
          finishedAt: message.finishedAt ?? Date.now(),
        }));
        const latest = stateRef.current.sessions[sessionId];
        if (latest) {
          persist({
            ...stateRef.current,
            sessions: {
              ...stateRef.current.sessions,
              [sessionId]: {
                ...latest,
                activeJobId: undefined,
                updatedAt: Date.now(),
              },
            },
          });
        }
      } finally {
        setPreparingContext(false);
      }
    },
    [
      activeFilePath,
      activeProject,
      agentMode,
      attachJobListener,
      auxiliaryProvider,
      pretrainedModels,
      editTargetMessageId,
      ensureSessionLoaded,
      finalizeAwaitingConfirmationMessages,
      persist,
      resolveProvider,
      rootPath,
      showToast,
      updateMessage,
      workMode,
    ],
  );

  const setSessionProvider = useCallback(
    (sessionId: string, providerId: string) => {
      const { current } = stateRef;
      const session = current.sessions[sessionId];
      const provider = resolveProvider(providerId);
      if (!session || !provider) return;
      persist({
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...session,
            providerId: provider.id,
            model: provider.model,
            updatedAt: Date.now(),
          },
        },
      });
      patchAgentSessionRemote(currentUserIdRef.current, sessionId, {
        providerId: provider.id,
        model: provider.model,
      }).catch((err) =>
        console.error('[DB] Failed to update session provider:', err),
      );
    },
    [persist, resolveProvider],
  );

  const beginEditMessage = useCallback((messageId: string) => {
    const { current } = stateRef;
    const sessionId = current.activeSessionId;
    if (!sessionId) return;
    const session = current.sessions[sessionId];
    if (session?.activeJobId && isJobRunning(session.activeJobId)) return;
    const message = current.messagesBySession[sessionId]?.[messageId];
    if (!message || message.role !== 'user' || message.status !== 'done') {
      return;
    }
    setEditTargetMessageId(messageId);
    setEditDraft(getUserTextFromMessage(message));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditTargetMessageId(null);
    setEditDraft('');
  }, []);

  const regenerateAssistant = useCallback(
    async (assistantMessageId: string) => {
      const { current } = stateRef;
      const sessionId = current.activeSessionId;
      if (!sessionId) return;

      const session = current.sessions[sessionId];
      if (!session) return;

      const assistantIndex = session.messageIds.indexOf(assistantMessageId);
      if (assistantIndex < 0) return;

      const assistantMessage =
        current.messagesBySession[sessionId]?.[assistantMessageId];
      if (!assistantMessage || assistantMessage.role !== 'assistant') {
        return;
      }

      if (session.activeJobId && isJobRunning(session.activeJobId)) {
        stopGeneration(sessionId);
      }

      const sessionMessages = {
        ...(current.messagesBySession[sessionId] ?? {}),
      };
      let markedStopped = false;
      for (const id of session.messageIds) {
        const msg = sessionMessages[id];
        if (msg?.status === 'streaming') {
          sessionMessages[id] = {
            ...msg,
            status: 'stopped',
            updatedAt: Date.now(),
            finishedAt: msg.finishedAt ?? Date.now(),
          };
          markedStopped = true;
        }
      }
      if (markedStopped) {
        persist({
          ...stateRef.current,
          messagesBySession: {
            ...stateRef.current.messagesBySession,
            [sessionId]: sessionMessages,
          },
        });
      }

      let userMessageId: string | null = null;
      let userContent = '';
      for (let i = assistantIndex - 1; i >= 0; i -= 1) {
        const id = session.messageIds[i];
        const msg = stateRef.current.messagesBySession[sessionId]?.[id];
        if (msg?.role === 'user') {
          userMessageId = id;
          userContent = getUserTextFromMessage(msg);
          break;
        }
      }
      if (!userMessageId || !userContent.trim()) return;

      await sendMessage(userContent, {
        editMessageId: userMessageId,
      });
    },
    [agentMode, persist, sendMessage, stopGeneration],
  );

  const undoAssistantChanges = useCallback(
    async (assistantMessageId: string) => {
      const sessionId = stateRef.current.activeSessionId;
      if (!sessionId) return;
      const message =
        stateRef.current.messagesBySession[sessionId]?.[assistantMessageId];
      if (!message || !messageCanUndo(message)) return;
      const refs = collectAppliedProposalRefs([message]);
      const restorePaths = refs.flatMap((ref) => {
        const block = message.blocks[ref.blockIndex];
        if (!block) return [];
        if (block.type === 'annotation_proposal') {
          return annotationPathsFromBlock(block);
        }
        if (isFileProposalBlock(block)) return [block.suggestedRelativePath];
        return [];
      });
      if (!confirmDirtyWorkspaceIfNeeded(restorePaths, activeProject?.id)) {
        return;
      }
      const restored = await restoreAppliedCheckpoints({
        refs,
        project: activeProject ?? null,
        workspaceRoot: rootPath,
        newestFirst: true,
      });
      if (!restored.ok) {
        showToast(formatRestoreError(restored), { type: 'error' });
        return;
      }
      for (const ref of refs) {
        updateMessageBlocks(sessionId, ref.messageId, (blocks) =>
          blocks.map((block, index) =>
            index === ref.blockIndex
              ? ({ ...block, status: 'undone' } as MessageBlock)
              : block,
          ),
        );
        const block = message.blocks[ref.blockIndex];
        if (!block) continue;
        patchAgentMessageBlockRemote({
          sessionId,
          messageId: ref.messageId,
          blockType: block.type,
          blockIndex: ref.blockIndex,
          patch: { status: 'undone' },
        }).catch(() => undefined);
      }
      await syncWorkspaceFactMemory(activeProject);
      if (activeProject && restored.restoredPaths.length > 0) {
        dispatchMutationsAppliedEvent(
          activeProject.id,
          restored.restoredPaths,
          {
            force: true,
          },
        );
      }
      markWorkspaceTextFilesChanged(restorePaths);
      clearFilePreviewSession();
      showToast('已撤销本轮写入', { type: 'success' });
    },
    [activeProject, rootPath, showToast, updateMessageBlocks],
  );

  const dismissAllPendingChanges = useCallback(async () => {
    if (dismissingAllPending) return;
    const sessionId = stateRef.current.activeSessionId;
    if (!sessionId) return;
    const messagesMap = stateRef.current.messagesBySession[sessionId] ?? {};
    const ids = resolveSessionMessageIds(
      stateRef.current.sessions[sessionId],
      messagesMap,
    );
    const messages = ids
      .map((id) => messagesMap[id])
      .filter((message): message is ChatMessage => Boolean(message));
    if (countPendingProposals(messages) === 0) return;

    setDismissingAllPending(true);
    // 立即反馈：消息切回 streaming 并提示「正在放弃提案…」（同 Keep All 空窗）
    const promotedId = promoteAwaitingMessageToStreaming(
      sessionId,
      'discarding-changes',
    );
    try {
      const dismissed = dismissPendingProposals({
        sessionId,
        messages,
        updateBlock: (messageId, blockIndex, patch) => {
          updateMessageBlocks(sessionId, messageId, (blocks) =>
            blocks.map((block, index) =>
              index === blockIndex
                ? ({ ...block, ...patch } as MessageBlock)
                : block,
            ),
          );
        },
      });
      clearFilePreviewSession();
      if (dismissed > 0) {
        showToast('已放弃提案', { type: 'info' });
        // 提案已关闭：续跑因 HITL 断点暂停的 job，让模型重新规划；
        // 无挂起 job 时兜底把暂停消息落为 done
        const resumedJobId = resumeAwaitingConfirmation(sessionId);
        if (!resumedJobId) {
          if (promotedId) {
            settlePromotedMessage(sessionId, promotedId, 'done');
          }
          finalizeAwaitingConfirmationMessages(sessionId);
        }
      } else if (promotedId) {
        settlePromotedMessage(sessionId, promotedId, 'awaiting_confirmation');
      }
    } catch (err) {
      if (promotedId) {
        settlePromotedMessage(sessionId, promotedId, 'awaiting_confirmation');
      }
      showToast(resolveErrorMessage(err, '放弃提案失败'), { type: 'error' });
    } finally {
      setDismissingAllPending(false);
    }
  }, [
    dismissingAllPending,
    finalizeAwaitingConfirmationMessages,
    promoteAwaitingMessageToStreaming,
    settlePromotedMessage,
    showToast,
    updateMessageBlocks,
  ]);

  const reapplyAssistantChanges = useCallback(
    async (assistantMessageId: string) => {
      const sessionId = stateRef.current.activeSessionId;
      if (!sessionId) return;
      const messagesMap = stateRef.current.messagesBySession[sessionId] ?? {};
      const ids = resolveSessionMessageIds(
        stateRef.current.sessions[sessionId],
        messagesMap,
      );
      const messages = ids
        .map((id) => messagesMap[id])
        .filter((item): item is ChatMessage => Boolean(item));
      const message = messagesMap[assistantMessageId];
      if (!message || !messageCanReapply(message)) return;
      const refs = collectUndoneProposalRefs(messages, assistantMessageId);
      const result = await applyProposalRefs({
        sessionId,
        messages,
        refs: refs.map((ref) => ({
          messageId: ref.messageId,
          blockIndex: ref.blockIndex,
          kind: ref.kind,
        })),
        project: activeProject ?? null,
        workspaceRoot: rootPath,
        updateBlock: (messageId, blockIndex, patch) => {
          updateMessageBlocks(sessionId, messageId, (blocks) =>
            blocks.map((block, index) =>
              index === blockIndex
                ? ({ ...block, ...patch } as MessageBlock)
                : block,
            ),
          );
        },
        onSyncWarning: (text) => {
          showToast(text, { type: 'info' });
        },
      });
      if (result.applied > 0) {
        await syncWorkspaceFactMemory(activeProject);
        showToast(`已重新应用 ${result.applied} 项变更`, { type: 'success' });
      }
      if (result.errors.length > 0) {
        showToast(result.errors[0], { type: 'error' });
      }
    },
    [activeProject, rootPath, showToast, updateMessageBlocks],
  );

  const toggleBlockCollapse = useCallback(
    (sessionId: string, messageId: string, blockIndex: number) => {
      updateMessage(sessionId, messageId, (message) => ({
        ...message,
        blocks: message.blocks.map((block, index) => {
          if (index !== blockIndex) return block;
          if (block.type === 'reasoning' || block.type === 'tool_call') {
            return { ...block, collapsed: !block.collapsed };
          }
          if (block.type === 'annotation_pipeline') {
            return { ...block, collapsed: !block.collapsed };
          }
          return block;
        }),
        updatedAt: Date.now(),
      }));
    },
    [updateMessage],
  );

  const isSessionStreaming = useCallback((sessionId: string) => {
    const session = stateRef.current.sessions[sessionId];
    return Boolean(session?.activeJobId && isJobRunning(session.activeJobId));
  }, []);

  const getSessionMessages = useCallback(
    (sessionId: string) => {
      const messagesMap = state.messagesBySession[sessionId] ?? {};
      const ids = resolveSessionMessageIds(
        state.sessions[sessionId],
        messagesMap,
      );
      return ids
        .map((id) => messagesMap[id])
        .filter((message): message is ChatMessage => Boolean(message));
    },
    [state.messagesBySession, state.sessions],
  );

  const pendingProposalCount = useMemo(() => {
    const sessionId = state.activeSessionId;
    if (!sessionId) return 0;
    const messagesMap = state.messagesBySession[sessionId] ?? {};
    const ids = resolveSessionMessageIds(
      state.sessions[sessionId],
      messagesMap,
    );
    const messages = ids
      .map((id) => messagesMap[id])
      .filter((message): message is ChatMessage => Boolean(message));
    return countPendingProposals(messages);
  }, [state.activeSessionId, state.messagesBySession, state.sessions]);

  const applyAllPendingChanges = useCallback(async () => {
    const sessionId = stateRef.current.activeSessionId;
    if (!sessionId || applyingAllPending) return;
    const messagesMap = stateRef.current.messagesBySession[sessionId] ?? {};
    const ids = resolveSessionMessageIds(
      stateRef.current.sessions[sessionId],
      messagesMap,
    );
    const messages = ids
      .map((id) => messagesMap[id])
      .filter((message): message is ChatMessage => Boolean(message));
    if (countPendingProposals(messages) === 0) return;

    const pendingRefs = collectPendingProposals(messages);
    const pendingFilePaths = pendingRefs.flatMap((ref) => {
      const block = messages.find((msg) => msg.id === ref.messageId)?.blocks[
        ref.blockIndex
      ];
      if (block && isFileProposalBlock(block)) {
        return [block.suggestedRelativePath];
      }
      return [];
    });

    setApplyingAllPending(true);
    // 立即反馈：消息切回 streaming 并提示「正在应用变更…」，
    // 覆盖 apply 写盘 + resume 建连的空窗；失败时在下面恢复 awaiting
    const promotedId = promoteAwaitingMessageToStreaming(
      sessionId,
      'applying-changes',
    );
    try {
      const result = await applyAllPendingProposals({
        sessionId,
        messages,
        project: activeProject ?? null,
        workspaceRoot: rootPath,
        updateBlock: (messageId, blockIndex, patch) => {
          updateMessageBlocks(sessionId, messageId, (blocks) =>
            blocks.map((b, i) =>
              i === blockIndex ? ({ ...b, ...patch } as MessageBlock) : b,
            ),
          );
        },
        onSyncWarning: (message) => {
          showToast(message, { type: 'info' });
        },
      });
      if (result.applied > 0) {
        showToast(`已应用 ${result.applied} 项变更`, { type: 'success' });
        if (result.missingCheckpoints > 0) {
          showToast('未能保存改前快照，重发时将无法自动回滚这些改动', {
            type: 'info',
          });
        }
        await syncWorkspaceFactMemory(activeProject);
        clearFilePreviewSession();
        markWorkspaceTextFilesChanged(pendingFilePaths);
        // 提案已落盘：续跑因 HITL 断点暂停的 job，进入核对/报告阶段；
        // 无挂起 job（如重启后）时兜底把暂停消息落为 done
        const resumedJobId = resumeAwaitingConfirmation(sessionId);
        if (!resumedJobId) {
          // 消息已被 promote 成 streaming，finalizeAwaiting* 只认 awaiting，
          // 这里直接落 done
          if (promotedId) {
            settlePromotedMessage(sessionId, promotedId, 'done');
          }
          finalizeAwaitingConfirmationMessages(sessionId);
        }
        // resume 成功：首个 SSE 事件会清掉 streamPhase 并保持 streaming
      } else if (promotedId) {
        // 未应用任何变更（全部失败）：恢复 awaiting，允许用户重试
        settlePromotedMessage(sessionId, promotedId, 'awaiting_confirmation');
      }
      if (result.errors.length > 0) {
        showToast(result.errors[0], { type: 'error' });
      }
    } catch (err) {
      // apply 抛异常：恢复 awaiting，避免消息卡在 streaming
      if (promotedId) {
        settlePromotedMessage(sessionId, promotedId, 'awaiting_confirmation');
      }
      showToast(resolveErrorMessage(err, '应用变更失败'), { type: 'error' });
    } finally {
      setApplyingAllPending(false);
    }
  }, [
    activeProject,
    applyingAllPending,
    finalizeAwaitingConfirmationMessages,
    promoteAwaitingMessageToStreaming,
    rootPath,
    settlePromotedMessage,
    showToast,
    updateMessageBlocks,
  ]);

  const openPanelTabs = useMemo<AgentPanelTab[]>(() => {
    const sessionTabs: AgentPanelTab[] = state.openTabIds.map((sessionId) => ({
      kind: 'session',
      sessionId,
    }));
    const subagentTabs = openSubagentTabs.filter((tab) =>
      findSubagentBlock(state.messagesBySession, tab.runId),
    );
    return [...sessionTabs, ...subagentTabs];
  }, [openSubagentTabs, state.messagesBySession, state.openTabIds]);

  const resolvedActivePanelTab = useMemo<AgentPanelTab | null>(() => {
    if (
      activePanelTab &&
      openPanelTabs.some((tab) => isSamePanelTab(tab, activePanelTab))
    ) {
      return activePanelTab;
    }
    if (state.activeSessionId) {
      return { kind: 'session', sessionId: state.activeSessionId };
    }
    return null;
  }, [activePanelTab, openPanelTabs, state.activeSessionId]);

  const activeSession = useMemo(
    () =>
      state.activeSessionId
        ? (state.sessions[state.activeSessionId] ?? null)
        : null,
    [state.activeSessionId, state.sessions],
  );

  const sessionOrderForProject = useMemo(
    () =>
      state.sessionOrder.filter(
        (id) =>
          sessionBelongsToProject(
            state.sessions[id],
            currentAnnotationProjectId,
          ) && sessionHasHistoryContent(id, state),
      ),
    [
      state.sessionOrder,
      state.sessions,
      state.messagesBySession,
      currentAnnotationProjectId,
    ],
  );

  const value = useMemo(
    () => ({
      sessions: state.sessions,
      sessionOrder: state.sessionOrder,
      sessionOrderForProject,
      currentAnnotationProjectId,
      agentMode,
      setAgentMode,
      openTabIds: state.openTabIds,
      openPanelTabs,
      activePanelTab: resolvedActivePanelTab,
      activeSessionId: state.activeSessionId,
      activeSession,
      messagesBySession: state.messagesBySession,
      historyOpen,
      editTargetMessageId,
      editDraft,
      setHistoryOpen,
      setEditDraft,
      createSession,
      closeTab,
      closePanelTab,
      switchSession,
      switchPanelTab,
      openSessionTab,
      openSubagentTab,
      deleteSession,
      sendMessage,
      stopGeneration,
      beginEditMessage,
      cancelEdit,
      regenerateAssistant,
      undoAssistantChanges,
      reapplyAssistantChanges,
      toggleBlockCollapse,
      updateMessageBlocks,
      setSessionProvider,
      isSessionStreaming,
      preparingContext,
      sessionsHasMore,
      loadingMoreSessions,
      loadingOlderMessages,
      getSessionMessages,
      loadMoreSessions,
      loadOlderMessages,
      pendingProposalCount,
      applyAllPendingChanges,
      applyingAllPending,
      dismissAllPendingChanges,
      dismissingAllPending,
    }),
    [
      state,
      activeSession,
      sessionOrderForProject,
      currentAnnotationProjectId,
      agentMode,
      setAgentMode,
      historyOpen,
      editTargetMessageId,
      editDraft,
      preparingContext,
      sessionsHasMore,
      loadingMoreSessions,
      loadingOlderMessages,
      openPanelTabs,
      resolvedActivePanelTab,
      createSession,
      closeTab,
      closePanelTab,
      switchSession,
      switchPanelTab,
      openSessionTab,
      openSubagentTab,
      deleteSession,
      sendMessage,
      stopGeneration,
      beginEditMessage,
      cancelEdit,
      regenerateAssistant,
      undoAssistantChanges,
      reapplyAssistantChanges,
      toggleBlockCollapse,
      updateMessageBlocks,
      setSessionProvider,
      isSessionStreaming,
      getSessionMessages,
      loadMoreSessions,
      loadOlderMessages,
      pendingProposalCount,
      applyAllPendingChanges,
      applyingAllPending,
      dismissAllPendingChanges,
      dismissingAllPending,
    ],
  );

  return (
    <AgentChatContext.Provider value={value}>
      <AgentComposerDraftContext.Provider value={composerDraftValue}>
        {children}
      </AgentComposerDraftContext.Provider>
    </AgentChatContext.Provider>
  );
}

export function useAgentChat(): AgentChatContextValue {
  const ctx = useContext(AgentChatContext);
  if (!ctx) {
    throw new Error('useAgentChat must be used within AgentChatProvider');
  }
  return ctx;
}

export { createEmptyChatState };
