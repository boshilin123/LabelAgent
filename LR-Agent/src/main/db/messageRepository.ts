import { getDatabase } from './database';

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  interaction_mode: string | null;
  sort_index: number;
  blocks_json: string; // JSON string
  status: string;
  provider_id: string | null;
  model: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const DEFAULT_MESSAGE_PAGE_SIZE = 50;

export function getMessages(
  sessionId: string,
  options: {
    beforeMessageId?: string | null;
    limit?: number;
  } = {},
): { messages: MessageRow[]; hasMoreBefore: boolean } {
  const db = getDatabase();
  const limit = options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE;

  let sql = 'SELECT * FROM messages WHERE session_id = ?';
  const params: unknown[] = [sessionId];

  if (options.beforeMessageId) {
    // Get the sort_index of the before message（限定同一会话，避免跨会话误用）
    const beforeMsg = db.get(
      'SELECT sort_index FROM messages WHERE id = ? AND session_id = ?',
      options.beforeMessageId,
      sessionId,
    ) as { sort_index: number } | undefined;
    if (beforeMsg) {
      sql += ' AND sort_index < ?';
      params.push(beforeMsg.sort_index);
    }
  }

  sql += ' ORDER BY sort_index DESC LIMIT ?';
  params.push(limit + 1);

  const rows = db.all(sql, ...params) as unknown as MessageRow[];

  const hasMoreBefore = rows.length > limit;
  const messages = hasMoreBefore ? rows.slice(0, limit) : rows;

  // Reverse to get ascending order (oldest first)
  messages.reverse();

  return { messages, hasMoreBefore };
}

export function createMessage(message: {
  id: string;
  sessionId: string;
  userId: string;
  role: string;
  interactionMode?: string | null;
  sortIndex?: number;
  blocksJson?: string;
  status?: string;
  providerId?: string | null;
  model?: string | null;
  error?: string | null;
}): MessageRow {
  const db = getDatabase();
  const now = Date.now();

  // 只有显式未传 sortIndex 时才自动取 MAX+1；传 0 是合法值，不能当作“未指定”。
  let finalSortIndex: number;
  if (message.sortIndex === undefined) {
    const maxRow = db.get(
      'SELECT COALESCE(MAX(sort_index), 0) as max_idx FROM messages WHERE session_id = ?',
      message.sessionId,
    ) as { max_idx: number } | undefined;
    finalSortIndex = (maxRow?.max_idx ?? 0) + 1;
  } else {
    finalSortIndex = message.sortIndex;
  }

  db.run(
    `
    INSERT INTO messages (id, session_id, user_id, role, interaction_mode, sort_index, blocks_json, status, provider_id, model, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    message.id,
    message.sessionId,
    message.userId,
    message.role,
    message.interactionMode ?? null,
    finalSortIndex,
    message.blocksJson ?? '[]',
    message.status ?? 'done',
    message.providerId ?? null,
    message.model ?? null,
    message.error ?? null,
    now,
    now,
  );

  return db.get(
    'SELECT * FROM messages WHERE id = ?',
    message.id,
  ) as unknown as MessageRow;
}

export function updateMessage(
  messageId: string,
  patch: {
    blocksJson?: string;
    status?: string;
    error?: string | null;
    interactionMode?: string | null;
    providerId?: string | null;
    model?: string | null;
  },
): MessageRow | undefined {
  const db = getDatabase();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.blocksJson !== undefined) {
    sets.push('blocks_json = ?');
    params.push(patch.blocksJson);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    params.push(patch.error);
  }
  if (patch.interactionMode !== undefined) {
    sets.push('interaction_mode = ?');
    params.push(patch.interactionMode);
  }
  if (patch.providerId !== undefined) {
    sets.push('provider_id = ?');
    params.push(patch.providerId);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model);
  }

  if (sets.length === 0) {
    return db.get('SELECT * FROM messages WHERE id = ?', messageId) as
      MessageRow | undefined;
  }

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(messageId);

  db.run(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, ...params);

  return db.get('SELECT * FROM messages WHERE id = ?', messageId) as
    MessageRow | undefined;
}

export function deleteMessagesAfter(
  sessionId: string,
  sortIndex: number,
): void {
  const db = getDatabase();
  db.run(
    'DELETE FROM messages WHERE session_id = ? AND sort_index > ?',
    sessionId,
    sortIndex,
  );
}

export function getMessage(messageId: string): MessageRow | undefined {
  const db = getDatabase();
  return db.get('SELECT * FROM messages WHERE id = ?', messageId) as
    MessageRow | undefined;
}

export function deleteMessagesAfterId(
  sessionId: string,
  messageId: string,
): void {
  const msg = getMessage(messageId);
  if (!msg || msg.session_id !== sessionId) return;
  deleteMessagesAfter(sessionId, msg.sort_index);
}

export function cleanupStreamingMessages(sessionId?: string): number {
  const db = getDatabase();
  if (sessionId) {
    const result = db.get(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND status = ?',
      sessionId,
      'streaming',
    ) as { count: number } | undefined;
    db.run(
      "UPDATE messages SET status = 'stopped', updated_at = ? WHERE session_id = ? AND status = 'streaming'",
      Date.now(),
      sessionId,
    );
    return result?.count ?? 0;
  }
  const result = db.get(
    "SELECT COUNT(*) as count FROM messages WHERE status = 'streaming'",
  ) as { count: number } | undefined;
  db.run(
    "UPDATE messages SET status = 'stopped', updated_at = ? WHERE status = 'streaming'",
    Date.now(),
  );
  return result?.count ?? 0;
}

export function deleteMessagesBySession(sessionId: string): void {
  const db = getDatabase();
  db.run('DELETE FROM messages WHERE session_id = ?', sessionId);
}

export function batchCreateMessages(
  messages: Array<{
    id: string;
    sessionId: string;
    userId: string;
    role: string;
    interactionMode?: string | null;
    sortIndex: number;
    blocksJson: string;
    status?: string;
    providerId?: string | null;
    model?: string | null;
    error?: string | null;
    createdAt: number;
    updatedAt: number;
  }>,
): void {
  const db = getDatabase();

  db.transaction(() => {
    for (const msg of messages) {
      db.run(
        `
        INSERT OR REPLACE INTO messages (id, session_id, user_id, role, interaction_mode, sort_index, blocks_json, status, provider_id, model, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        msg.id,
        msg.sessionId,
        msg.userId,
        msg.role,
        msg.interactionMode ?? null,
        msg.sortIndex,
        msg.blocksJson,
        msg.status ?? 'done',
        msg.providerId ?? null,
        msg.model ?? null,
        msg.error ?? null,
        msg.createdAt,
        msg.updatedAt,
      );
    }
  });
}

export function getSessionMessagesForExport(sessionId: string): MessageRow[] {
  const db = getDatabase();
  return db.all(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY sort_index ASC',
    sessionId,
  ) as unknown as MessageRow[];
}
