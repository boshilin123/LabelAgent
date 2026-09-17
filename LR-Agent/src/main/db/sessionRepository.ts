import { getDatabase } from './database';

export interface SessionRow {
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

export interface SessionListResult {
  sessions: SessionRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 50;

export function listSessions(options: {
  userId: string;
  limit?: number;
  cursor?: string | null;
  annotationProjectId?: string | null;
  workspaceOnly?: boolean;
}): SessionListResult {
  const db = getDatabase();
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;

  let sql = 'SELECT * FROM sessions WHERE deleted_at IS NULL AND user_id = ?';
  const params: unknown[] = [options.userId];

  if (options.annotationProjectId) {
    sql += ' AND annotation_project_id = ?';
    params.push(options.annotationProjectId);
  } else if (options.workspaceOnly) {
    sql += ' AND annotation_project_id IS NULL';
  } else {
    // Exclude annotation-project sessions by default for workspace queries
    // Actually, the original API returns all sessions. Let's keep all.
  }

  if (options.cursor) {
    // cursor format: "updated_at|id"
    const [cursorTs, cursorId] = options.cursor.split('|');
    sql += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
    const ts = parseInt(cursorTs, 10);
    params.push(ts, ts, cursorId);
  }

  sql += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
  params.push(limit + 1); // fetch one extra to determine hasMore

  const rows = db.all(sql, ...params) as unknown as SessionRow[];

  const hasMore = rows.length > limit;
  const sessions = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && sessions.length > 0) {
    const last = sessions[sessions.length - 1];
    nextCursor = `${last.updated_at}|${last.id}`;
  }

  return { sessions, nextCursor, hasMore };
}

export interface SessionWithStatsRow extends SessionRow {
  message_count: number;
  last_message_preview: string | null;
}

export function listSessionsWithStats(options: {
  userId: string;
  limit?: number;
  cursor?: string | null;
  annotationProjectId?: string | null;
  workspaceOnly?: boolean;
}): {
  sessions: SessionWithStatsRow[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  const db = getDatabase();
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;

  // 1) 分页查询会话
  let sql = 'SELECT * FROM sessions WHERE deleted_at IS NULL AND user_id = ?';
  const params: unknown[] = [options.userId];

  if (options.annotationProjectId) {
    sql += ' AND annotation_project_id = ?';
    params.push(options.annotationProjectId);
  } else if (options.workspaceOnly) {
    sql += ' AND annotation_project_id IS NULL';
  }

  if (options.cursor) {
    const [cursorTs, cursorId] = options.cursor.split('|');
    sql += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
    const ts = parseInt(cursorTs, 10);
    params.push(ts, ts, cursorId);
  }

  sql += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
  params.push(limit + 1);

  const rows = db.all(sql, ...params) as unknown as SessionRow[];
  const hasMore = rows.length > limit;
  const sessions = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && sessions.length > 0) {
    const last = sessions[sessions.length - 1];
    nextCursor = `${last.updated_at}|${last.id}`;
  }

  if (sessions.length === 0) {
    return { sessions: [], nextCursor: null, hasMore: false };
  }

  // 2) 批量查询统计信息（替代 N+1 逐条查询）
  const sessionIds = sessions.map((s) => s.id);
  const placeholders = sessionIds.map(() => '?').join(',');

  // message count
  const countRows = db.all(
    `SELECT session_id, COUNT(*) as c FROM messages WHERE session_id IN (${placeholders}) GROUP BY session_id`,
    ...sessionIds,
  ) as { session_id: string; c: number }[];
  const countMap = new Map<string, number>();
  for (const r of countRows) {
    countMap.set(r.session_id, r.c);
  }

  // last message preview: 每个 session 的最后一条 assistant 消息的文本
  // 使用子查询取每个 session 的最大 sort_index 行
  const previewRows = db.all(
    `SELECT m.session_id, m.blocks_json FROM messages m
     INNER JOIN (
       SELECT session_id, MAX(sort_index) as max_sort
       FROM messages WHERE session_id IN (${placeholders}) AND role = 'assistant'
       GROUP BY session_id
     ) latest ON m.session_id = latest.session_id AND m.sort_index = latest.max_sort
     WHERE m.role = 'assistant'`,
    ...sessionIds,
  ) as { session_id: string; blocks_json: string }[];
  const previewMap = new Map<string, string | null>();
  for (const r of previewRows) {
    try {
      const blocks = JSON.parse(r.blocks_json);
      const textBlock = blocks.find(
        (b: { type: string; content?: string }) => b.type === 'text',
      );
      previewMap.set(
        r.session_id,
        textBlock?.content ? textBlock.content.slice(0, 80) : null,
      );
    } catch {
      previewMap.set(r.session_id, null);
    }
  }

  const result: SessionWithStatsRow[] = sessions.map((s) => ({
    ...s,
    message_count: countMap.get(s.id) ?? 0,
    last_message_preview: previewMap.get(s.id) ?? null,
  }));

  return { sessions: result, nextCursor, hasMore };
}

export function getSession(
  sessionId: string,
  userId: string,
): SessionRow | undefined {
  const db = getDatabase();
  return db.get(
    'SELECT * FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    sessionId,
    userId,
  ) as SessionRow | undefined;
}

export function createSession(session: {
  id: string;
  userId: string;
  title?: string;
  annotationProjectId?: string | null;
  interactionMode?: string | null;
  providerId?: string | null;
  model?: string | null;
}): SessionRow {
  const db = getDatabase();
  const now = Date.now();
  db.run(
    `
    INSERT INTO sessions (id, user_id, title, annotation_project_id, interaction_mode, provider_id, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    session.id,
    session.userId,
    session.title ?? '新对话',
    session.annotationProjectId ?? null,
    session.interactionMode ?? null,
    session.providerId ?? null,
    session.model ?? null,
    now,
    now,
  );
  return getSession(session.id, session.userId)!;
}

export function updateSession(
  sessionId: string,
  userId: string,
  patch: Partial<{
    title: string;
    providerId: string | null;
    model: string | null;
    annotationProjectId: string | null;
    interactionMode: string | null;
    contextSummary: string | null;
    summaryUpToMessageId: string | null;
    lastContextTokenEstimate: number | null;
  }>,
): SessionRow | undefined {
  const db = getDatabase();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.providerId !== undefined) {
    sets.push('provider_id = ?');
    params.push(patch.providerId);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model);
  }
  if (patch.annotationProjectId !== undefined) {
    sets.push('annotation_project_id = ?');
    params.push(patch.annotationProjectId);
  }
  if (patch.interactionMode !== undefined) {
    sets.push('interaction_mode = ?');
    params.push(patch.interactionMode);
  }
  if (patch.contextSummary !== undefined) {
    sets.push('context_summary = ?');
    params.push(patch.contextSummary);
  }
  if (patch.summaryUpToMessageId !== undefined) {
    sets.push('summary_up_to_message_id = ?');
    params.push(patch.summaryUpToMessageId);
  }
  if (patch.lastContextTokenEstimate !== undefined) {
    sets.push('last_context_token_estimate = ?');
    params.push(patch.lastContextTokenEstimate);
  }

  if (sets.length === 0) return getSession(sessionId, userId);

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(sessionId);
  params.push(userId);

  db.run(
    `UPDATE sessions SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    ...params,
  );

  return getSession(sessionId, userId);
}

export function softDeleteSession(sessionId: string, userId: string): void {
  const db = getDatabase();
  const now = Date.now();
  db.run(
    'UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    now,
    now,
    sessionId,
    userId,
  );
  // Cascade delete all messages for this session
  db.run('DELETE FROM messages WHERE session_id = ?', sessionId);
}

export function getSessionMessageIds(sessionId: string): string[] {
  const db = getDatabase();
  const rows = db.all(
    'SELECT id FROM messages WHERE session_id = ? ORDER BY sort_index ASC',
    sessionId,
  ) as { id: string }[];
  return rows.map((r) => r.id);
}

export function getSessionMessageCount(sessionId: string): number {
  const db = getDatabase();
  const row = db.get(
    'SELECT COUNT(*) as count FROM messages WHERE session_id = ?',
    sessionId,
  ) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Assign legacy rows (user_id = '') to the current logged-in user. */
export function backfillLegacyUserId(userId: string): {
  sessionsUpdated: number;
  messagesUpdated: number;
} {
  const db = getDatabase();
  const now = Date.now();

  const sessionRow = db.get(
    "SELECT COUNT(*) as count FROM sessions WHERE user_id = '' AND deleted_at IS NULL",
  ) as { count: number } | undefined;
  const sessionsUpdated = sessionRow?.count ?? 0;

  if (sessionsUpdated > 0) {
    db.run(
      "UPDATE sessions SET user_id = ?, updated_at = ? WHERE user_id = '' AND deleted_at IS NULL",
      userId,
      now,
    );
  }

  const messageRow = db.get(
    "SELECT COUNT(*) as count FROM messages WHERE user_id = ''",
  ) as { count: number } | undefined;
  const messagesUpdated = messageRow?.count ?? 0;

  if (messagesUpdated > 0) {
    db.run(
      "UPDATE messages SET user_id = ?, updated_at = ? WHERE user_id = ''",
      userId,
      now,
    );
  }

  return { sessionsUpdated, messagesUpdated };
}

export function getLastMessagePreview(sessionId: string): string | null {
  const db = getDatabase();
  const rows = db.all(
    'SELECT blocks_json FROM messages WHERE session_id = ? AND role = ? ORDER BY sort_index DESC LIMIT 1',
    sessionId,
    'assistant',
  ) as { blocks_json: string }[];
  if (rows.length === 0) return null;
  try {
    const blocks = JSON.parse(rows[0].blocks_json);
    const textBlock = blocks.find(
      (b: { type: string; content?: string }) => b.type === 'text',
    );
    if (textBlock?.content) {
      return textBlock.content.slice(0, 80);
    }
  } catch {
    // ignore
  }
  return null;
}
