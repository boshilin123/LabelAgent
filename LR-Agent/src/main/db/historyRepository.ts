import {
  historyExcerpt,
  historyTextFromBlocks,
  parseHistoryQuery,
  type HistoryRecallRequest,
  type HistoryRecallResult,
} from '../../shared/conversationHistory';
import { getDatabase } from './database';
import { getSession } from './sessionRepository';
import type { MessageRow } from './messageRepository';

/** 只查询当前用户、当前会话、摘要覆盖点以内的原文；不修改消息或摘要。 */
export function recallSessionHistory(
  request: HistoryRecallRequest,
): HistoryRecallResult {
  if (
    !request ||
    typeof request.userId !== 'string' ||
    !request.userId ||
    typeof request.sessionId !== 'string' ||
    typeof request.upToMessageId !== 'string' ||
    typeof request.query !== 'string'
  )
    throw new Error('Invalid history recall request');
  if (!getSession(request.sessionId, request.userId))
    throw new Error('Session not found');
  const db = getDatabase();
  const cutoff = db.get(
    'SELECT sort_index FROM messages WHERE session_id = ? AND id = ?',
    request.sessionId,
    request.upToMessageId,
  ) as { sort_index: number } | undefined;
  if (!cutoff) throw new Error('History boundary not found');
  const plan = parseHistoryQuery(request.query);
  const result: HistoryRecallResult = {
    sessionId: request.sessionId,
    upToMessageId: request.upToMessageId,
    turns: [],
    explicitReference: plan.explicitReference,
  };
  if (!plan.ids.length && !plan.turns.length && !plan.terms.length)
    return result;

  // 只读取轻量排序信息来恢复真正的用户轮次，不把 sort_index 当作轮数。
  const metadata = db.all(
    'SELECT id, role, sort_index FROM messages WHERE session_id = ? AND sort_index <= ? ORDER BY sort_index ASC',
    request.sessionId,
    cutoff.sort_index,
  ) as unknown as Array<Pick<MessageRow, 'id' | 'role' | 'sort_index'>>;
  const turns: Array<{ number: number; ids: string[] }> = [];
  const turnById = new Map<string, number>();
  for (const row of metadata) {
    if (row.role === 'user') {
      turns.push({ number: turns.length + 1, ids: [] });
    }
    if (turns.length && (row.role === 'user' || row.role === 'assistant')) {
      turnById.set(row.id, turns.length - 1);
      turns[turns.length - 1].ids.push(row.id);
    }
  }
  const ranks = new Map<number, number>();
  const matchedIds = new Set<string>();
  if (plan.ids.length || plan.turns.length) {
    for (const id of plan.ids) {
      const index = turnById.get(id);
      if (index !== undefined) {
        ranks.set(index, 1_000);
        matchedIds.add(id);
      }
    }
    for (const turn of plan.turns)
      if (turns[turn - 1]) ranks.set(turn - 1, 1_000);
  } else {
    // instr 使用参数化字面匹配，不把用户的 %/_ 当 SQL 通配符。
    const scoreSql = plan.terms
      .map(() => '(CASE WHEN instr(recall_text, ?) > 0 THEN 1 ELSE 0 END)')
      .join(' + ');
    const candidates = db.all(
      `WITH searchable AS MATERIALIZED (
         SELECT m.*, lower((SELECT coalesce(group_concat(
           CASE WHEN b.type <> 'object' THEN '' ELSE
             CASE json_extract(b.value, '$.type')
               WHEN 'text' THEN json_extract(b.value, '$.content')
               WHEN 'tool_call' THEN coalesce(json_extract(b.value, '$.name'),'') || ' ' ||
                 coalesce(json_extract(b.value, '$.arguments'),'') || ' ' || coalesce(json_extract(b.value, '$.result'),'')
               WHEN 'file_proposal' THEN coalesce(json_extract(b.value, '$.title'),'') || ' ' ||
                 coalesce(json_extract(b.value, '$.suggestedRelativePath'),'') || ' ' ||
                 coalesce(json_extract(b.value, '$.oldPath'),'') || ' ' || coalesce(json_extract(b.value, '$.status'),'') || ' ' ||
                 coalesce(json_extract(b.value, '$.content'),'')
               WHEN 'document_proposal' THEN coalesce(json_extract(b.value, '$.title'),'') || ' ' ||
                 coalesce(json_extract(b.value, '$.suggestedRelativePath'),'') || ' ' ||
                 coalesce(json_extract(b.value, '$.oldPath'),'') || ' ' || coalesce(json_extract(b.value, '$.status'),'') || ' ' ||
                 coalesce(json_extract(b.value, '$.content'),'')
               WHEN 'subagent' THEN json_extract(b.value, '$.summary')
               ELSE '' END
           END, char(10)), '')
           FROM json_each(CASE WHEN json_valid(m.blocks_json) THEN
             CASE WHEN json_type(m.blocks_json)='array' THEN m.blocks_json ELSE '[]' END ELSE '[]' END) b
         )) AS recall_text FROM messages m
         WHERE session_id = ? AND sort_index <= ? AND role IN ('user','assistant')
       )
       SELECT * FROM (SELECT *, (${scoreSql}) AS recall_score FROM searchable)
       WHERE recall_score > 0 ORDER BY recall_score DESC, sort_index DESC LIMIT 64`,
      request.sessionId,
      cutoff.sort_index,
      ...plan.terms,
    ) as unknown as Array<MessageRow & { recall_text: string }>;
    for (const row of candidates) {
      const text = row.recall_text;
      const score = plan.terms.reduce(
        (sum, term) =>
          sum + (text.includes(term) ? Math.min(term.length, 8) : 0),
        0,
      );
      const index = turnById.get(row.id);
      if (score && index !== undefined) {
        ranks.set(index, Math.max(ranks.get(index) ?? 0, score));
        matchedIds.add(row.id);
      }
    }
  }
  const selected = [...ranks]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .slice(0, 4);
  for (const [index, score] of selected) {
    const turn = turns[index];
    const selectedIds = [
      ...new Set([
        ...[...matchedIds].filter((id) => turnById.get(id) === index),
        turn.ids[0],
        ...[...turn.ids].reverse(),
      ]),
    ]
      .filter(Boolean)
      .slice(0, 8);
    const rows = db.all(
      `SELECT * FROM messages WHERE session_id = ? AND id IN (${selectedIds.map(() => '?').join(',')})
       AND role IN ('user','assistant') ORDER BY sort_index ASC`,
      request.sessionId,
      ...selectedIds,
    ) as unknown as MessageRow[];
    const messages = rows.flatMap((row) => {
      let blocks: unknown;
      try {
        blocks = JSON.parse(row.blocks_json);
      } catch {
        return [];
      }
      const text = historyTextFromBlocks(blocks);
      if (!text) return [];
      return [
        {
          id: row.id,
          role: row.role,
          text: historyExcerpt(text, plan.terms, 12_000),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          truncated: text.length > 12_000,
        },
      ];
    });
    if (messages.length)
      result.turns.push({
        turn: turn.number,
        score,
        messages,
        omittedMessages: Math.max(0, turn.ids.length - selectedIds.length),
      });
  }
  return result;
}
