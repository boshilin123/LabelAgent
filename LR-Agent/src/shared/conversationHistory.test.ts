import {
  historyExcerpt,
  historyTextFromBlocks,
  parseHistoryQuery,
} from './conversationHistory';

it('recognizes message IDs, generated IDs and Chinese/English turn references', () => {
  expect(
    parseHistoryQuery('消息 ID: msg-abc-123，第十二轮和 turn 3').ids,
  ).toContain('msg-abc-123');
  expect(parseHistoryQuery('看一下 msg-mabc123-xyz789 的原文').ids).toContain(
    'msg-mabc123-xyz789',
  );
  expect(parseHistoryQuery('第十二轮和 turn 3').turns).toEqual([12, 3]);
});

it('extracts Chinese keywords and English identifiers without filler phrases', () => {
  const plan = parseHistoryQuery(
    '之前确定的检测阈值是多少，LearningRate 和 config.yaml？',
  );
  expect(plan.terms).toContain('阈值');
  expect(plan.terms).toContain('learningrate');
  expect(plan.terms).toContain('config.yaml');
  expect(plan.terms).not.toContain('之前');
  expect(plan.explicitReference).toBe(true);
});

it('retains saved text/tool evidence but excludes reasoning', () => {
  const text = historyTextFromBlocks([
    { type: 'text', content: '阈值 0.37' },
    {
      type: 'tool_call',
      name: 'read_workspace_file',
      arguments: '{}',
      result: 'saved result',
    },
    { type: 'reasoning', content: 'private reasoning' },
  ]);
  expect(text).toContain('0.37');
  expect(text).toContain('saved result');
  expect(text).not.toContain('private reasoning');
});

it('takes verbatim evidence around a keyword at the end of a large message', () => {
  const excerpt = historyExcerpt(
    `${'x'.repeat(20_000)}检测阈值为 0.37`,
    ['阈值'],
    200,
  );
  expect(excerpt).toContain('阈值为 0.37');
  expect(excerpt.length).toBeLessThanOrEqual(202);
});
