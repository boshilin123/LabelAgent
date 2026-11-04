import { summarizeConversation } from './contextSummarizer';
import { estimateTokens } from './contextBudget';

const originalFetch = global.fetch;
const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
});

const options = {
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'dummy',
  model: 'small-summary',
  existingSummary: null,
  evictedTranscript: 'history',
  contextWindowTokens: 4096,
};
function ok(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

it('merges an existing summary into a normal summarization request', async () => {
  fetchMock.mockResolvedValue(ok('updated summary'));
  expect(
    await summarizeConversation({ ...options, existingSummary: 'old summary' }),
  ).toBe('updated summary');
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.messages[1].content).toContain('old summary');
  expect(body.messages[1].content).toContain('history');
  expect(body.stream).toBe(false);
});

it('chunks long histories using the smaller summary model window', async () => {
  fetchMock.mockImplementation(async () => ok('merged-summary'));
  const transcript = Array.from(
    { length: 50 },
    (_, i) => 'line-' + i + ':' + 'x'.repeat(100),
  ).join('\n');
  expect(
    await summarizeConversation({
      ...options,
      contextWindowTokens: 1024,
      evictedTranscript: transcript,
    }),
  ).toBe('merged-summary');
  expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
  for (const body of bodies) {
    const inputTokens = body.messages.reduce(
      (sum: number, item: { content: string }) =>
        sum + estimateTokens(item.content),
      0,
    );
    expect(inputTokens).toBeLessThanOrEqual(Math.floor(1024 * 0.8));
    expect(body.max_tokens).toBe(205);
  }
  expect(bodies[1].messages[1].content).toContain('merged-summary');
  expect(bodies[bodies.length - 1].messages[1].content).toContain('line-49');
});

it('rejects empty summaries so history cannot be marked covered', async () => {
  fetchMock.mockResolvedValue(ok('  '));
  await expect(summarizeConversation(options)).rejects.toThrow('空内容');
});

it('does not return a partial summary if a later chunk fails', async () => {
  fetchMock
    .mockResolvedValueOnce(ok('partial'))
    .mockResolvedValue({ ok: false, status: 503 });
  await expect(
    summarizeConversation({
      ...options,
      contextWindowTokens: 1024,
      evictedTranscript: 'x'.repeat(6000),
    }),
  ).rejects.toThrow('503');
});
