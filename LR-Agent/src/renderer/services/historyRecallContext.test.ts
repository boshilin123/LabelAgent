import { buildHistoryRecallContext } from './historyRecallContext';
import { estimateTokens } from './contextBudget';
import type { HistoryRecallResult } from '../../shared/conversationHistory';
import type { ChatMessage } from '../../shared/agentTypes';

function result(
  overrides: Partial<HistoryRecallResult> = {},
): HistoryRecallResult {
  return {
    sessionId: 's',
    upToMessageId: 'a0',
    explicitReference: true,
    turns: [
      {
        turn: 1,
        score: 10,
        messages: [
          {
            id: 'a0',
            role: 'assistant',
            text: '检测阈值为 0.37',
            createdAt: 1,
            updatedAt: 1,
            truncated: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function build(value = result(), maxTokens = 1_200) {
  return buildHistoryRecallContext({
    result: value,
    sessionId: 's',
    messageIds: ['u0', 'a0', 'u1'],
    messages: {},
    query: '之前检测阈值是多少',
    maxTokens,
  });
}

it('includes message identity, original value, time and read-only instructions', () => {
  const context = build();
  expect(context).toContain('0.37');
  expect(context).toContain('"id":"a0"');
  expect(context).toContain('createdAt');
  expect(context).toContain('重放历史调用 ID');
});

it('budgets large evidence around the relevant detail and marks partial excerpts', () => {
  const data = result();
  data.turns[0].messages[0].text = `${'x'.repeat(20_000)}检测阈值为 0.37`;
  const context = build(data, 600);
  expect(context).toContain('0.37');
  expect(context).toContain('"truncated":true');
  expect(
    estimateTokens(JSON.stringify([{ role: 'system', content: context }])),
  ).toBeLessThanOrEqual(600);
});

it('does not leak a different session or messages outside the job snapshot', () => {
  expect(() => build(result({ sessionId: 'other' }))).toThrow('其他会话');
  const data = result();
  data.turns[0].messages[0].id = 'unknown';
  data.turns[0].messages[0].text = 'do not leak this';
  const context = build(data);
  expect(context).not.toContain('do not leak this');
  expect(context).toContain('not_found_in_summarized_history');
});

it('adds an honest no-match note only for an explicit historical question', () => {
  expect(build(result({ turns: [] }))).toContain('先检查本轮近期原文');
  expect(build(result({ turns: [], explicitReference: false }))).toBe('');
});

it('rejects an unusably small budget instead of silently omitting found evidence', () => {
  expect(() => build(result(), 10)).toThrow('预算不足');
});

it('uses strictly newer in-memory edits but keeps stored evidence over an equal-version preview', () => {
  const live = {
    id: 'a0',
    sessionId: 's',
    role: 'assistant',
    blocks: [{ type: 'text', content: 'edited threshold 0.62' }],
    status: 'done',
    providerId: 'p',
    model: 'm',
    createdAt: 1,
    updatedAt: 2,
  } as ChatMessage;
  const options = {
    result: result(),
    sessionId: 's',
    messageIds: ['a0'],
    messages: { a0: live },
    query: '之前阈值',
    maxTokens: 1_200,
  };
  expect(buildHistoryRecallContext(options)).toContain('0.62');
  live.updatedAt = 1;
  expect(buildHistoryRecallContext(options)).toContain('0.37');
});

it('presents selected evidence chronologically so an older value is not placed after its correction', () => {
  const data = result();
  data.turns.unshift({
    turn: 3,
    score: 10,
    messages: [
      {
        id: 'u1',
        role: 'assistant',
        text: '检测阈值改为 0.61',
        createdAt: 3,
        updatedAt: 3,
        truncated: false,
      },
    ],
  });
  const context = build(data);
  expect(context.indexOf('0.37')).toBeLessThan(context.indexOf('0.61'));
});

it('shortens long excerpts before dropping other selected facts or corrections', () => {
  const data = result({
    turns: [1, 2, 3, 4].map((turn) => ({
      turn,
      score: 10,
      messages: [
        {
          id: `a${turn}`,
          role: 'assistant',
          text: `${'x'.repeat(10_000)}检测阈值为 0.3${turn}`,
          createdAt: turn,
          updatedAt: turn,
          truncated: false,
        },
      ],
    })),
  });
  const context = buildHistoryRecallContext({
    result: data,
    sessionId: 's',
    messageIds: ['a1', 'a2', 'a3', 'a4'],
    messages: {},
    query: '之前检测阈值',
    maxTokens: 1_000,
  });
  for (const value of ['0.31', '0.32', '0.33', '0.34'])
    expect(context).toContain(value);
  expect(
    estimateTokens(JSON.stringify([{ role: 'system', content: context }])),
  ).toBeLessThanOrEqual(1_000);
});
