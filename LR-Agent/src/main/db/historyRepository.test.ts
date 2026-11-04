/** @jest-environment node */
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { recallSessionHistory } from './historyRepository';
import { getDatabase } from './database';
import { prepareChatContext } from '../../renderer/services/contextPreparer';
import {
  buildBackendMessages,
  serializeBackendMessages,
} from '../../renderer/services/backendChatClient';
import type { AgentSession, ChatMessage } from '../../shared/agentTypes';

jest.mock('./database', () => ({ getDatabase: jest.fn() }));
let SQL: SqlJsStatic;
let db: Database;

function rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
  const statement = db.prepare(sql);
  try {
    statement.bind(params as import('sql.js').BindParams);
    const result: Record<string, unknown>[] = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally {
    statement.free();
  }
}

function message(
  id: string,
  session: string,
  role: string,
  order: number,
  text: string,
) {
  db.run('INSERT INTO messages VALUES (?,?,?,?,?,?,?)', [
    id,
    session,
    role,
    order,
    JSON.stringify([{ type: 'text', content: text }]),
    order * 1_000,
    order * 1_000,
  ]);
}

function recall(query = '之前确定的检测阈值是多少？', overrides = {}) {
  return recallSessionHistory({
    userId: 'alice',
    sessionId: 's1',
    upToMessageId: 'a2',
    query,
    ...overrides,
  });
}

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
  });
});

beforeEach(() => {
  db = new SQL.Database();
  db.run(
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, deleted_at INTEGER)',
  );
  db.run(
    'CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, sort_index INTEGER, blocks_json TEXT, created_at INTEGER, updated_at INTEGER)',
  );
  db.run(
    "INSERT INTO sessions VALUES ('s1','alice',NULL),('s2','alice',NULL),('s3','bob',NULL),('deleted','alice',1)",
  );
  jest.mocked(getDatabase).mockReturnValue({
    all: rows,
    get: (sql: string, ...params: unknown[]) => rows(sql, ...params)[0],
  } as unknown as ReturnType<typeof getDatabase>);
  message('u1', 's1', 'user', 10, '请确定检测阈值');
  message('a1', 's1', 'assistant', 11, '检测阈值确定为 0.37');
  message('u2', 's1', 'user', 30, '解释目录结构');
  message('a2', 's1', 'assistant', 31, '这是项目目录');
  message('u3', 's1', 'user', 50, '更新检测阈值');
  message('a3', 's1', 'assistant', 51, '检测阈值改为 0.61');
  message('secret', 's3', 'assistant', 1, '检测阈值为其他用户的 0.99');
});

afterEach(() => db.close());

it('recalls the omitted exact value and its question from the archived range', () => {
  const result = recall();
  expect(result.turns[0].messages.map((item) => item.id)).toEqual(['u1', 'a1']);
  expect(JSON.stringify(result)).toContain('0.37');
  expect(JSON.stringify(result)).not.toContain('0.61');
  expect(JSON.stringify(result)).not.toContain('0.99');
});

it('resolves actual user turns despite gaps in sort_index', () => {
  const result = recall('第二轮说了什么？');
  expect(result.turns[0].turn).toBe(2);
  expect(result.turns[0].messages.map((item) => item.id)).toEqual(['u2', 'a2']);
});

it('supports exact message IDs and does not substitute unrelated records', () => {
  expect(recall('消息 ID: a1').turns[0].messages[1].text).toContain('0.37');
  expect(recall('消息 ID: missing').turns).toEqual([]);
});

it('can retrieve an explicit message and another requested turn together', () => {
  expect(
    recall('消息 ID: a1 和第二轮')
      .turns.map((turn) => turn.turn)
      .sort(),
  ).toEqual([1, 2]);
});

it('checks user ownership, deleted sessions and foreign boundary IDs', () => {
  expect(() => recall('阈值', { userId: 'bob' })).toThrow('Session not found');
  expect(() => recall('阈值', { sessionId: 'deleted' })).toThrow(
    'Session not found',
  );
  expect(() => recall('阈值', { upToMessageId: 'secret' })).toThrow(
    'History boundary not found',
  );
});

it('treats SQL metacharacters as data and never leaks another user', () => {
  const result = recall("之前阈值 %' OR 1=1 --");
  expect(JSON.stringify(result)).not.toContain('0.99');
});

it('does not match JSON field names as if they were conversation text', () => {
  expect(recall('content').turns).toEqual([]);
});

it('does not let JSON metadata crowd an old real keyword hit out of the candidate limit', () => {
  db.run('UPDATE messages SET blocks_json=? WHERE id=?', [
    JSON.stringify([
      { type: 'text', content: 'content was set to original-value' },
    ]),
    'a1',
  ]);
  for (let n = 0; n < 70; n += 1) {
    message(`noise-u${n}`, 's1', 'user', 100 + n * 2, 'unrelated question');
    message(`noise-a${n}`, 's1', 'assistant', 101 + n * 2, 'unrelated answer');
  }
  expect(
    JSON.stringify(recall('content', { upToMessageId: 'noise-a69' })),
  ).toContain('original-value');
});

it('ignores damaged or non-array blocks without breaking other recoverable records', () => {
  db.run('UPDATE messages SET blocks_json=? WHERE id=?', ['not json', 'a2']);
  expect(JSON.stringify(recall())).toContain('0.37');
  db.run('UPDATE messages SET blocks_json=? WHERE id=?', [
    '{"x":"plain string"}',
    'a2',
  ]);
  expect(JSON.stringify(recall())).toContain('0.37');
});

it('prefers later corrections while retaining dated source records', () => {
  const result = recall('检测阈值', { upToMessageId: 'a3' });
  expect(result.turns[0].turn).toBe(3);
  expect(JSON.stringify(result)).toContain('0.61');
  expect(JSON.stringify(result)).toContain('0.37');
  expect(result.turns[0].messages[1].createdAt).toBe(51_000);
});

it('finds relevant evidence near the end of a large saved message', () => {
  db.run('UPDATE messages SET blocks_json=? WHERE id=?', [
    JSON.stringify([
      { type: 'text', content: `${'x'.repeat(30_000)}检测阈值为 0.37` },
    ]),
    'a1',
  ]);
  const result = recall();
  expect(result.turns[0].messages[1].text).toContain('0.37');
  expect(result.turns[0].messages[1].truncated).toBe(true);
});

it('can find the saved old path of a rename proposal', () => {
  db.run('UPDATE messages SET blocks_json=? WHERE id=?', [
    JSON.stringify([
      {
        type: 'file_proposal',
        title: 'rename',
        operation: 'rename',
        suggestedRelativePath: 'D:\\work\\new.md',
        oldPath: 'D:\\work\\original.md',
        status: 'applied',
        content: '',
      },
    ]),
    'a1',
  ]);
  const data = recall('之前 D:\\work\\original.md 是什么？');
  expect(data.turns[0].messages[1].text).toContain('original.md');
  expect(data.turns[0].messages[1].text).toContain('oldPath');
});

it('can find a Windows path inside serialized historical tool arguments', () => {
  db.run('UPDATE messages SET blocks_json=? WHERE id=?', [
    JSON.stringify([
      {
        type: 'tool_call',
        id: 'old-call',
        name: 'read_workspace_file',
        arguments: JSON.stringify({ path: 'D:\\work\\source.md' }),
        result: 'old tool result',
      },
    ]),
    'a1',
  ]);
  expect(JSON.stringify(recall('之前 D:\\work\\source.md 的结果'))).toContain(
    'old tool result',
  );
});

it('keeps an exact hit even in a turn with more than sixteen messages', () => {
  db.run("INSERT INTO sessions VALUES ('long','alice',NULL)");
  message('long-user', 'long', 'user', 0, 'long turn');
  for (let n = 1; n <= 25; n += 1)
    message(`long-${n}`, 'long', 'assistant', n, `value ${n}`);
  const result = recall('消息 ID: long-1', {
    sessionId: 'long',
    upToMessageId: 'long-25',
  });
  expect(result.turns[0].messages.some((item) => item.id === 'long-1')).toBe(
    true,
  );
  expect(result.turns[0].omittedMessages).toBeGreaterThan(0);
});

it('carries an omitted value from real SQLite through context preparation into model JSON', async () => {
  const before = db.export();
  const session: AgentSession = {
    id: 's1',
    title: 't',
    providerId: 'p',
    model: 'm',
    messageIds: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4'],
    contextSummary: '已确定检测参数',
    summaryUpToMessageId: 'a2',
    createdAt: 1,
    updatedAt: 1,
  };
  const messages: Record<string, ChatMessage> = {};
  for (const [id, role, text] of [
    ['u3', 'user', '更新检测阈值'],
    ['a3', 'assistant', '当前阈值是 0.61'],
    ['u4', 'user', '第一轮检测阈值是多少？'],
  ]) {
    messages[id] = {
      id,
      sessionId: 's1',
      role: role as ChatMessage['role'],
      blocks: [{ type: 'text', content: text }],
      status: 'done',
      providerId: 'p',
      model: 'm',
      createdAt: 1,
      updatedAt: 1,
    };
  }
  const prepared = await prepareChatContext({
    session,
    messageIds: session.messageIds,
    sessionMessages: messages,
    currentUserContent: '第一轮检测阈值是多少？',
    provider: { baseUrl: 'http://offline', apiKey: 'k', model: 'm' },
    recallHistory: async (request) =>
      recallSessionHistory({ ...request, userId: 'alice', sessionId: 's1' }),
  });
  const payload = serializeBackendMessages([
    { role: 'system', content: prepared.recalledHistoryContext! },
    ...buildBackendMessages(prepared.windowedMessageIds, messages),
  ]);
  expect(JSON.stringify(payload)).toContain('0.37');
  expect(JSON.stringify(payload)).toContain('0.61');
  expect(prepared.windowedMessageIds).toEqual(['u3', 'a3', 'u4']);
  expect(db.export()).toEqual(before);
});
