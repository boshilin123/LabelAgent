import type {
  AgentChatPersistedState,
  AgentSession,
  ChatMessage,
  MessageBlock,
} from '../../shared/agentTypes';

const DEFAULT_SESSION_PAGE_SIZE = 50;
const DEFAULT_MESSAGE_PAGE_SIZE = 50;

// ── Database row types (matching main process SQLite schema) ──────

interface DbSessionRow {
  id: string;
  title: string;
  annotation_project_id: string | null;
  interaction_mode: string | null;
  provider_id: string | null;
  model: string | null;
  context_summary: string | null;
  summary_up_to_message_id: string | null;
  last_context_token_estimate: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface DbMessageRow {
  id: string;
  session_id: string;
  role: string;
  interaction_mode: string | null;
  sort_index: number;
  blocks_json: string;
  status: string;
  provider_id: string | null;
  model: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface DbSessionListResult {
  sessions: DbSessionRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface DbMessageListResult {
  messages: DbMessageRow[];
  hasMoreBefore: boolean;
}

// ── Mappers ────────────────────────────────────────────────────────

function mapDbSession(row: DbSessionRow): AgentSession {
  return {
    id: row.id,
    title: row.title,
    annotationProjectId: row.annotation_project_id ?? null,
    interactionMode:
      row.interaction_mode === 'annotation' || row.interaction_mode === 'chat'
        ? row.interaction_mode
        : null,
    providerId: row.provider_id ?? '',
    model: row.model ?? '',
    messageIds: [],
    contextSummary: row.context_summary ?? undefined,
    summaryUpToMessageId: row.summary_up_to_message_id ?? undefined,
    lastContextTokenEstimate: row.last_context_token_estimate ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDbMessage(row: DbMessageRow): ChatMessage {
  const mode = row.interaction_mode;
  const interactionMode =
    mode === 'annotation' || mode === 'chat' ? mode : null;
  let blocks: MessageBlock[] = [];
  try {
    blocks = JSON.parse(row.blocks_json);
  } catch {
    blocks = [];
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as ChatMessage['role'],
    blocks,
    status: row.status as ChatMessage['status'],
    interactionMode,
    providerId: row.provider_id ?? '',
    model: row.model ?? '',
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt:
      row.status === 'done' ||
      row.status === 'stopped' ||
      row.status === 'error' ||
      row.status === 'awaiting_confirmation'
        ? row.updated_at
        : undefined,
  };
}

// ── IPC helper ─────────────────────────────────────────────────────

function getDb() {
  return (
    window as unknown as {
      electron: {
        db: {
          sessions: {
            list: (opts: unknown) => Promise<DbSessionListResult>;
            get: (
              id: string,
              userId: string,
            ) => Promise<DbSessionRow | undefined>;
            create: (s: unknown) => Promise<DbSessionRow>;
            update: (
              id: string,
              userId: string,
              p: unknown,
            ) => Promise<DbSessionRow | undefined>;
            softDelete: (id: string, userId: string) => Promise<void>;
            getMessageIds: (id: string) => Promise<string[]>;
            getMessageCount: (id: string) => Promise<number>;
            getLastMessagePreview: (id: string) => Promise<string | null>;
            listWithStats: (opts: unknown) => Promise<{
              sessions: Array<
                DbSessionRow & {
                  message_count: number;
                  last_message_preview: string | null;
                }
              >;
              nextCursor: string | null;
              hasMore: boolean;
            }>;
            backfillLegacyUserId: (userId: string) => Promise<{
              sessionsUpdated: number;
              messagesUpdated: number;
            }>;
          };
          messages: {
            list: (sid: string, opts: unknown) => Promise<DbMessageListResult>;
            get: (id: string) => Promise<DbMessageRow | undefined>;
            create: (m: unknown) => Promise<DbMessageRow>;
            update: (
              id: string,
              p: unknown,
            ) => Promise<DbMessageRow | undefined>;
            deleteAfter: (sid: string, idx: number) => Promise<void>;
            deleteAfterId: (sid: string, msgId: string) => Promise<void>;
            cleanupStreaming: (sid?: string) => Promise<number>;
            deleteBySession: (sid: string) => Promise<void>;
            batchCreate: (msgs: unknown[]) => Promise<void>;
            getForExport: (sid: string) => Promise<DbMessageRow[]>;
          };
        };
      };
    }
  ).electron.db;
}

// ── Public API ─────────────────────────────────────────────────────

export interface AgentSessionsPage {
  sessions: AgentSession[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function listSessionsLocally(
  userId: string,
  options: {
    limit?: number;
    cursor?: string | null;
    annotationProjectId?: string | null;
    workspaceOnly?: boolean;
  } = {},
): Promise<AgentSessionsPage> {
  const db = getDb();
  const result = await db.sessions.listWithStats({
    userId,
    limit: options.limit,
    cursor: options.cursor,
    annotationProjectId: options.annotationProjectId,
    workspaceOnly: options.workspaceOnly,
  });
  const sessions: AgentSession[] = [];
  for (const row of result.sessions) {
    const session = mapDbSession(row);
    session.messageCount = row.message_count;
    session.lastMessagePreview = row.last_message_preview ?? undefined;
    // messageIds 改为惰性加载：仅当前打开的 session 或展开列表详情时才加载
    session.messageIds = [];
    sessions.push(session);
  }
  return {
    sessions,
    nextCursor: result.nextCursor ?? null,
    hasMore: Boolean(result.hasMore),
  };
}

export async function getSessionDetailLocally(
  userId: string,
  sessionId: string,
  options: { limit?: number; beforeMessageId?: string | null } = {},
): Promise<{
  session: AgentSession;
  messages: Record<string, ChatMessage>;
  hasMoreBefore: boolean;
}> {
  const db = getDb();
  const limit = options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE;
  const sessionRow = await db.sessions.get(sessionId, userId);
  if (!sessionRow) {
    throw new Error('Session not found');
  }

  const messageResult = await db.messages.list(sessionId, {
    limit,
    beforeMessageId: options.beforeMessageId,
  });

  const session = mapDbSession(sessionRow);
  const messageIds = await db.sessions.getMessageIds(sessionId);
  const messageCount = await db.sessions.getMessageCount(sessionId);
  session.messageIds = messageIds;
  session.messageCount = messageCount;

  const messages: Record<string, ChatMessage> = {};
  for (const row of messageResult.messages) {
    messages[row.id] = mapDbMessage(row);
  }

  return {
    session: {
      ...session,
      hasMoreMessagesBefore: messageResult.hasMoreBefore,
    },
    messages,
    hasMoreBefore: messageResult.hasMoreBefore,
  };
}

export async function createSessionLocally(
  userId: string,
  session: Pick<
    AgentSession,
    | 'id'
    | 'title'
    | 'providerId'
    | 'model'
    | 'annotationProjectId'
    | 'interactionMode'
  >,
): Promise<AgentSession> {
  const db = getDb();
  const row = await db.sessions.create({
    userId,
    id: session.id,
    title: session.title,
    annotationProjectId: session.annotationProjectId,
    interactionMode: session.interactionMode,
    providerId: session.providerId || null,
    model: session.model || null,
  });
  return mapDbSession(row);
}

export async function updateSessionLocally(
  userId: string,
  sessionId: string,
  patch: Partial<
    Pick<
      AgentSession,
      | 'title'
      | 'providerId'
      | 'model'
      | 'contextSummary'
      | 'summaryUpToMessageId'
      | 'lastContextTokenEstimate'
    >
  >,
): Promise<AgentSession | undefined> {
  const db = getDb();
  const row = await db.sessions.update(sessionId, userId, {
    title: patch.title,
    providerId: patch.providerId,
    model: patch.model,
    contextSummary: patch.contextSummary,
    summaryUpToMessageId: patch.summaryUpToMessageId,
    lastContextTokenEstimate: patch.lastContextTokenEstimate,
  });
  return row ? mapDbSession(row) : undefined;
}

export async function deleteSessionLocally(
  userId: string,
  sessionId: string,
): Promise<void> {
  const db = getDb();
  await db.sessions.softDelete(sessionId, userId);
}

export async function createMessageLocally(message: {
  id: string;
  sessionId: string;
  userId: string;
  role: string;
  interactionMode?: string | null;
  blocksJson?: string;
  status?: string;
  providerId?: string | null;
  model?: string | null;
  error?: string | null;
}): Promise<ChatMessage> {
  const db = getDb();
  const row = await db.messages.create(message);
  return mapDbMessage(row);
}

export async function updateMessageLocally(
  messageId: string,
  patch: {
    blocksJson?: string;
    status?: string;
    error?: string | null;
  },
): Promise<ChatMessage | undefined> {
  const db = getDb();
  const row = await db.messages.update(messageId, patch);
  return row ? mapDbMessage(row) : undefined;
}

export async function deleteMessagesAfterLocally(
  sessionId: string,
  sortIndex: number,
): Promise<void> {
  const db = getDb();
  await db.messages.deleteAfter(sessionId, sortIndex);
}

export async function deleteMessagesAfterIdLocally(
  sessionId: string,
  messageId: string,
): Promise<void> {
  const db = getDb();
  await db.messages.deleteAfterId(sessionId, messageId);
}

export async function cleanupStreamingLocally(
  sessionId?: string,
): Promise<number> {
  const db = getDb();
  return db.messages.cleanupStreaming(sessionId);
}

/** 更新指定消息中某个 block 的状态（标注提案、文件提案等），持久化到 SQLite。
 *  若未指定 blockIndex，则自动查找第一个匹配 blockType 的块。 */
export async function patchAgentMessageBlockRemote(options: {
  sessionId: string;
  messageId: string;
  blockType: string;
  blockIndex?: number;
  patch: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const row = await db.messages.get(options.messageId);
  if (!row) {
    console.error(
      '[patchAgentMessageBlock] message not found:',
      options.messageId,
    );
    return;
  }
  let blocks: MessageBlock[];
  try {
    blocks = JSON.parse(row.blocks_json);
  } catch {
    blocks = [];
  }
  const idx =
    options.blockIndex !== undefined
      ? options.blockIndex
      : blocks.findIndex((b) => b.type === options.blockType);
  if (idx < 0) {
    console.error(
      `[patchAgentMessageBlock] block not found: type=${options.blockType}`,
    );
    return;
  }
  const block = blocks[idx];
  if (block.type !== options.blockType) {
    console.error(
      `[patchAgentMessageBlock] block mismatch at index ${idx}: expected ${options.blockType}, got ${block.type}`,
    );
    return;
  }
  blocks[idx] = { ...block, ...options.patch } as MessageBlock;
  await db.messages.update(options.messageId, {
    blocksJson: JSON.stringify(blocks),
  });
}

export async function backfillLegacyUserIdLocally(
  userId: string,
): Promise<{ sessionsUpdated: number; messagesUpdated: number }> {
  const db = getDb();
  return db.sessions.backfillLegacyUserId(userId);
}

export async function loadLocalAgentChatStateForProject(
  userId: string,
  annotationProjectId: string | null,
): Promise<
  AgentChatPersistedState & {
    sessionsNextCursor: string | null;
    sessionsHasMore: boolean;
  }
> {
  const page = await listSessionsLocally(
    userId,
    annotationProjectId ? { annotationProjectId } : { workspaceOnly: true },
  );
  const sessionsMap: Record<string, AgentSession> = {};
  const messagesBySession: AgentChatPersistedState['messagesBySession'] = {};
  const sessionOrder = page.sessions
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => session.id);

  for (const session of page.sessions) {
    sessionsMap[session.id] = session;
    messagesBySession[session.id] = {};
  }

  return {
    sessions: sessionsMap,
    sessionOrder,
    openTabIds: [],
    activeSessionId: null,
    messagesBySession,
    sessionsNextCursor: page.nextCursor,
    sessionsHasMore: page.hasMore,
  };
}

export async function loadLocalAgentChatState(userId: string): Promise<
  AgentChatPersistedState & {
    sessionsNextCursor: string | null;
    sessionsHasMore: boolean;
  }
> {
  return loadLocalAgentChatStateForProject(userId, null);
}

// Re-export with backward-compatible names
export {
  listSessionsLocally as fetchAgentSessionsPage,
  getSessionDetailLocally as fetchAgentSessionDetail,
  createSessionLocally as createAgentSessionRemote,
  updateSessionLocally as patchAgentSessionRemote,
  deleteSessionLocally as deleteAgentSessionRemote,
  loadLocalAgentChatStateForProject as loadRemoteAgentChatStateForProject,
  loadLocalAgentChatState as loadRemoteAgentChatState,
};
