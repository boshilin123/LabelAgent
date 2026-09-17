import { prepareChatContext, estimateTokens } from './contextPreparer';
import type {
  AgentSession,
  ChatContextConfig,
  ChatMessage,
} from '../../shared/agentTypes';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    title: 't',
    providerId: 'p1',
    model: 'm',
    messageIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role,
    blocks: [{ type: 'text', content }],
    status: 'done',
    interactionMode: 'chat',
    providerId: 'p1',
    model: 'm',
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 生成 count 轮（user+assistant 各一条）对话 */
function makeTurns(
  count: number,
  contentLength = 100,
): { ids: string[]; messages: Record<string, ChatMessage> } {
  const ids: string[] = [];
  const messages: Record<string, ChatMessage> = {};
  for (let i = 0; i < count; i += 1) {
    const uid = `u${i}`;
    const aid = `a${i}`;
    ids.push(uid, aid);
    messages[uid] = makeMessage(
      uid,
      'user',
      `q${i} ${'x'.repeat(contentLength)}`,
    );
    messages[aid] = makeMessage(
      aid,
      'assistant',
      `r${i} ${'y'.repeat(contentLength)}`,
    );
  }
  return { ids, messages };
}

const provider = { baseUrl: 'http://test', apiKey: 'k', model: 'm' };

const smallConfig: ChatContextConfig = {
  maxContextTokens: 200,
  maxTurnsInWindow: 4,
  summarizeTriggerRatio: 0.5,
  minTurnsBeforeSummarize: 2,
};

describe('estimateTokens', () => {
  it('estimates roughly chars/3', () => {
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('prepareChatContext', () => {
  it('returns all ids without summarize when under threshold', async () => {
    const { ids, messages } = makeTurns(2, 10);
    const summarizeFn = jest.fn();
    const result = await prepareChatContext({
      session: makeSession({ messageIds: ids }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'hello',
      provider,
      summarizeFn,
    });
    expect(result.summarized).toBe(false);
    expect(result.windowedMessageIds).toEqual(ids);
    expect(summarizeFn).not.toHaveBeenCalled();
  });

  it('applies hard turn window even without summarize', async () => {
    const { ids, messages } = makeTurns(10, 5);
    const summarizeFn = jest.fn();
    const result = await prepareChatContext({
      session: makeSession({ messageIds: ids }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'hello',
      provider,
      // token 阈值极高 → 不触发摘要，仅硬窗口
      config: { ...smallConfig, maxContextTokens: 1_000_000 },
      summarizeFn,
    });
    expect(result.summarized).toBe(false);
    // maxTurnsInWindow=4 → 保留最后 8 条内容消息
    expect(result.windowedMessageIds).toEqual(ids.slice(-8));
    expect(summarizeFn).not.toHaveBeenCalled();
  });

  it('summarizes evicted turns when over threshold', async () => {
    const { ids, messages } = makeTurns(10, 100);
    const summarizeFn = jest.fn().mockResolvedValue('这是摘要');
    const result = await prepareChatContext({
      session: makeSession({ messageIds: ids }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'hello',
      provider,
      config: smallConfig,
      summarizeFn,
    });
    expect(result.summarized).toBe(true);
    expect(result.contextSummary).toBe('这是摘要');
    // keepTurns = ceil(4/2)=2 → 保留最后 4 条，摘要覆盖到 a7
    expect(result.summaryUpToMessageId).toBe('a7');
    expect(result.windowedMessageIds).toEqual(ids.slice(-4));
    expect(summarizeFn).toHaveBeenCalledTimes(1);
    const call = summarizeFn.mock.calls[0][0];
    expect(call.existingSummary).toBeNull();
    expect(call.evictedTranscript).toContain('q0');
    expect(call.evictedTranscript).not.toContain('q9');
  });

  it('passes existing summary for incremental merge', async () => {
    const { ids, messages } = makeTurns(10, 100);
    const summarizeFn = jest.fn().mockResolvedValue('合并后的摘要');
    const result = await prepareChatContext({
      session: makeSession({
        messageIds: ids,
        contextSummary: '旧摘要',
        summaryUpToMessageId: 'a1',
      }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'hello',
      provider,
      config: smallConfig,
      summarizeFn,
    });
    expect(result.summarized).toBe(true);
    const call = summarizeFn.mock.calls[0][0];
    expect(call.existingSummary).toBe('旧摘要');
    // 摘要覆盖点之后的消息才参与：a1 之后从 u2 开始
    expect(call.evictedTranscript).toContain('q2');
    expect(call.evictedTranscript).not.toContain('q0');
  });

  it('falls back to hard window when summarize fails', async () => {
    const { ids, messages } = makeTurns(10, 100);
    const summarizeFn = jest.fn().mockRejectedValue(new Error('llm down'));
    const result = await prepareChatContext({
      session: makeSession({ messageIds: ids }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'hello',
      provider,
      config: smallConfig,
      summarizeFn,
    });
    expect(result.summarized).toBe(false);
    expect(result.contextSummary).toBeUndefined();
    // 降级为硬窗口：maxTurnsInWindow=4 → 最后 8 条
    expect(result.windowedMessageIds).toEqual(ids.slice(-8));
  });

  it('excludes messages in excludeMessageIds from lines', async () => {
    const { ids, messages } = makeTurns(2, 10);
    // 模拟流式中的助手占位消息
    const placeholderId = 'a-placeholder';
    messages[placeholderId] = makeMessage(placeholderId, 'assistant', '');
    const allIds = [...ids, placeholderId];
    const summarizeFn = jest.fn();
    const result = await prepareChatContext({
      session: makeSession({ messageIds: allIds }),
      messageIds: allIds,
      sessionMessages: messages,
      currentUserContent: 'hello',
      provider,
      excludeMessageIds: new Set([placeholderId]),
      summarizeFn,
    });
    // 占位消息仍在发送列表末尾（buildBackendMessages 会过滤空内容）
    expect(result.windowedMessageIds).toContain(placeholderId);
    expect(result.summarized).toBe(false);
  });

  it('does not summarize when turns below minTurnsBeforeSummarize', async () => {
    const { ids, messages } = makeTurns(1, 5000);
    const summarizeFn = jest.fn();
    const result = await prepareChatContext({
      session: makeSession({ messageIds: ids }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'hello',
      provider,
      config: { ...smallConfig, minTurnsBeforeSummarize: 2 },
      summarizeFn,
    });
    expect(result.summarized).toBe(false);
    expect(summarizeFn).not.toHaveBeenCalled();
  });
});
