import {
  prepareChatContext,
  estimateTokens,
  deriveMaxContextTokens,
} from './contextPreparer';
import { buildBackendMessages } from './backendChatClient';
import type { HistoryRecallResult } from '../../shared/conversationHistory';
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
  windowStrategy: 'turns',
  maxContextTokens: 400,
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

  it('summarizes short history before a configured turn window evicts it', async () => {
    const { ids, messages } = makeTurns(10, 5);
    const summarizeFn = jest.fn().mockResolvedValue('完整覆盖旧消息的摘要');
    const result = await prepareChatContext({
      session: makeSession({ messageIds: ids }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'hello',
      provider,
      // 即使 token 未达阈值，也不能静默丢掉即将移出窗口的内容。
      config: { ...smallConfig, maxContextTokens: 1_000_000 },
      summarizeFn,
    });
    expect(result.summarized).toBe(true);
    expect(result.windowedMessageIds).toEqual(ids.slice(-4));
    expect(result.summaryUpToMessageId).toBe('a7');
    expect(summarizeFn).toHaveBeenCalledTimes(1);
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

  it('preserves all original messages when a turn-triggered summary fails within budget', async () => {
    const { ids, messages } = makeTurns(10, 100);
    const summarizeFn = jest.fn().mockRejectedValue(new Error('llm down'));
    const result = await prepareChatContext({
      session: makeSession({ messageIds: ids }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'hello',
      provider,
      config: { ...smallConfig, maxContextTokens: 1_000_000 },
      summarizeFn,
    });
    expect(result.summarized).toBe(false);
    expect(result.contextSummary).toBeUndefined();
    expect(result.windowedMessageIds).toEqual(ids);
    expect(result.summaryUpToMessageId).toBeUndefined();
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
      config: {
        ...smallConfig,
        maxContextTokens: 6000,
        summarizeTriggerRatio: 0.1,
        minTurnsBeforeSummarize: 2,
      },
      summarizeFn,
    });
    expect(result.summarized).toBe(false);
    expect(summarizeFn).not.toHaveBeenCalled();
  });
});

describe('model-sized context protection', () => {
  it('uses 80% without the former 8K floor or 48K ceiling', () => {
    expect(deriveMaxContextTokens(1_000_000)).toBe(800_000);
    expect(deriveMaxContextTokens(1_048_576)).toBe(838_860);
    expect(deriveMaxContextTokens(128_000)).toBe(102_400);
    expect(deriveMaxContextTokens(4096)).toBe(3276);
    for (const value of [null, undefined, NaN, Infinity, -1, 0, 1.5]) {
      expect(deriveMaxContextTokens(value)).toBeNull();
    }
  });

  it('keeps more than 20 short turns when the model budget has space', async () => {
    const { ids, messages } = makeTurns(30, 20);
    const summarizeFn = jest.fn();
    const result = await prepareChatContext({
      session: makeSession(),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'continue',
      provider,
      modelContextWindowTokens: 1_000_000,
      summarizeFn,
    });
    expect(result.windowedMessageIds).toEqual(ids);
    expect(result.summarized).toBe(false);
    expect(summarizeFn).not.toHaveBeenCalled();
  });

  it('moves the summary boundary to a complete user turn', async () => {
    const { ids, messages } = makeTurns(20, 10);
    ids.push('u20');
    messages.u20 = makeMessage('u20', 'user', 'the next question');
    const summarizeFn = jest.fn().mockResolvedValue('summary');
    const result = await prepareChatContext({
      session: makeSession(),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'the next question',
      provider,
      config: {
        ...smallConfig,
        maxTurnsInWindow: 20,
        maxContextTokens: 100_000,
      },
      summarizeFn,
    });
    expect(result.summaryUpToMessageId).toBe('a10');
    expect(result.windowedMessageIds[0]).toBe('u11');
    expect(summarizeFn.mock.calls[0][0].evictedTranscript).toContain('r10');
    expect(summarizeFn.mock.calls[0][0].evictedTranscript).not.toContain('q11');
  });

  it('rejects an over-budget request when summary generation fails without mutating history', async () => {
    const { ids, messages } = makeTurns(10, 100);
    const session = makeSession({
      contextSummary: 'old',
      summaryUpToMessageId: 'a0',
    });
    await expect(
      prepareChatContext({
        session,
        messageIds: ids,
        sessionMessages: messages,
        currentUserContent: 'continue',
        provider,
        config: smallConfig,
        summarizeFn: jest.fn().mockRejectedValue(new Error('offline')),
      }),
    ).rejects.toThrow('历史消息已保留');
    expect(session.contextSummary).toBe('old');
    expect(session.summaryUpToMessageId).toBe('a0');
    expect(ids).toHaveLength(20);
  });

  it('does not silently skip history that has not been loaded', async () => {
    const message = makeMessage('u1', 'user', 'hello');
    await expect(
      prepareChatContext({
        session: makeSession(),
        messageIds: ['old', 'u1'],
        sessionMessages: { u1: message },
        currentUserContent: 'hello',
        provider,
      }),
    ).rejects.toThrow('历史消息尚未加载');
  });

  it('preserves history when an empty summary is returned', async () => {
    const { ids, messages } = makeTurns(10, 5);
    const result = await prepareChatContext({
      session: makeSession(),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'continue',
      provider,
      config: { ...smallConfig, maxContextTokens: 100_000 },
      summarizeFn: jest.fn().mockResolvedValue('   '),
    });
    expect(result.windowedMessageIds).toEqual(ids);
    expect(result.summarized).toBe(false);
  });

  it('reports an oversized latest turn instead of dropping it', async () => {
    const { ids, messages } = makeTurns(1, 10_000);
    await expect(
      prepareChatContext({
        session: makeSession(),
        messageIds: ids,
        sessionMessages: messages,
        currentUserContent: 'continue',
        provider,
        config: smallConfig,
      }),
    ).rejects.toThrow('请缩短输入');
  });

  it('counts multilingual text conservatively', () => {
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens('中文测试')).toBe(4);
    expect(estimateTokens('😀')).toBe(2);
  });

  it('keeps assistant tool calls and their results together after compaction', async () => {
    const { ids, messages } = makeTurns(10, 10);
    messages.a9.blocks.push({
      type: 'tool_call',
      id: 'call-last',
      name: 'write_workspace_file',
      arguments: '{"relative_path":"notes.md"}',
      status: 'done',
      collapsed: true,
      result: '{"status":"ok","summary":"proposal prepared"}',
    });
    messages.a0.blocks.push({
      type: 'tool_call',
      id: 'call-old',
      name: 'write_workspace_file',
      arguments: '{"relative_path":"old.md"}',
      status: 'done',
      collapsed: true,
      result: '{"status":"ok","summary":"old proposal"}',
    });
    const summarizeFn = jest.fn().mockResolvedValue('summary');
    const result = await prepareChatContext({
      session: makeSession(),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: 'continue',
      provider,
      config: { ...smallConfig, maxContextTokens: 100_000 },
      summarizeFn,
    });
    const payload = buildBackendMessages(result.windowedMessageIds, messages);
    const declarations = payload.flatMap((item) => item.tool_calls ?? []);
    const results = payload.filter((item) => item.role === 'tool');
    expect(declarations.map((item) => item.id)).toEqual(['call-last']);
    expect(results.map((item) => item.tool_call_id)).toEqual(['call-last']);
    expect(summarizeFn.mock.calls[0][0].evictedTranscript).toContain(
      'call-old',
    );
  });
});

describe('recalling raw history omitted from a summary', () => {
  function history(upToMessageId: string): HistoryRecallResult {
    return {
      sessionId: 's1',
      upToMessageId,
      explicitReference: true,
      turns: [
        {
          turn: 1,
          score: 5,
          messages: [
            {
              id: 'u0',
              role: 'user',
              text: '确定检测阈值',
              createdAt: 1,
              updatedAt: 1,
              truncated: false,
            },
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
    };
  }

  it('restores a missing exact value without reinserting old message IDs or changing the summary', async () => {
    const { ids, messages } = makeTurns(4, 10);
    delete messages.u0;
    delete messages.a0;
    const session = makeSession({
      messageIds: ids,
      contextSummary: '已确定检测参数',
      summaryUpToMessageId: 'a1',
    });
    const recallHistory = jest.fn(async ({ upToMessageId }) =>
      history(upToMessageId),
    );
    const prepared = await prepareChatContext({
      session,
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: '之前检测阈值是多少？',
      provider,
      recallHistory,
    });
    expect(prepared.recalledHistoryContext).toContain('0.37');
    expect(prepared.windowedMessageIds).toEqual(ids.slice(4));
    expect(prepared.summarized).toBe(false);
    expect(session.contextSummary).toBe('已确定检测参数');
    expect(recallHistory).toHaveBeenCalledWith({
      query: '之前检测阈值是多少？',
      upToMessageId: 'a1',
    });
  });

  it('recalls a fact even when this same request first compresses it out of the window', async () => {
    const { ids, messages } = makeTurns(10, 10);
    messages.a0.blocks = [{ type: 'text', content: '检测阈值为 0.37' }];
    const summarizeFn = jest.fn().mockResolvedValue('已确定检测参数');
    const recallHistory = jest.fn(async ({ upToMessageId }) =>
      history(upToMessageId),
    );
    const prepared = await prepareChatContext({
      session: makeSession(),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: '之前检测阈值是多少？',
      provider,
      recallHistory,
      summarizeFn,
      config: { ...smallConfig, maxContextTokens: 8_000 },
    });
    expect(prepared.summarized).toBe(true);
    expect(prepared.contextSummary).toBe('已确定检测参数');
    expect(prepared.recalledHistoryContext).toContain('0.37');
    expect(recallHistory).toHaveBeenCalledWith({
      query: '之前检测阈值是多少？',
      upToMessageId: prepared.summaryUpToMessageId,
    });
    expect(summarizeFn.mock.calls[0][0].evictedTranscript).not.toContain(
      '历史会话原文回查',
    );
    expect(prepared.tokenEstimate).toBeLessThanOrEqual(8_000);
  });

  it('includes serialized recall evidence in the same total token budget', async () => {
    const { ids, messages } = makeTurns(4, 10);
    delete messages.u0;
    delete messages.a0;
    const prepared = await prepareChatContext({
      session: makeSession({
        contextSummary: '已确定参数',
        summaryUpToMessageId: 'a1',
      }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: '之前阈值是多少',
      provider,
      modelContextWindowTokens: 10_000,
      recallHistory: async ({ upToMessageId }) => history(upToMessageId),
    });
    const payload = [
      { role: 'system', content: prepared.recalledHistoryContext },
      ...buildBackendMessages(prepared.windowedMessageIds, messages),
    ];
    expect(prepared.tokenEstimate).toBe(
      estimateTokens(JSON.stringify(payload)) + estimateTokens('已确定参数'),
    );
    expect(prepared.tokenEstimate).toBeLessThanOrEqual(8_000);
  });

  it('charges actual recalled text instead of reserving its maximum and dropping a recent turn', async () => {
    const { ids, messages } = makeTurns(13, 1_200);
    messages.a0.blocks = [{ type: 'text', content: '检测阈值为 0.37' }];
    const keptCost = estimateTokens(
      JSON.stringify(buildBackendMessages(ids.slice(-20), messages)),
    );
    expect(keptCost).toBeGreaterThan(8_000);
    const prepared = await prepareChatContext({
      session: makeSession(),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: '之前检测阈值是多少？',
      provider,
      config: {
        windowStrategy: 'tokens',
        maxContextTokens: 10_000,
        maxTurnsInWindow: 20,
        summarizeTriggerRatio: 1,
        minTurnsBeforeSummarize: 10,
      },
      summarizeFn: jest.fn().mockResolvedValue('已确定检测参数'),
      recallHistory: async ({ upToMessageId }) => history(upToMessageId),
    });
    expect(prepared.summarized).toBe(true);
    expect(prepared.windowedMessageIds).toEqual(ids.slice(-20));
    expect(prepared.tokenEstimate).toBeLessThanOrEqual(10_000);
  });

  it('can recall a short exact value on a 4K model without an artificially tiny recall allowance', async () => {
    const { ids, messages } = makeTurns(4, 10);
    delete messages.u0;
    delete messages.a0;
    const prepared = await prepareChatContext({
      session: makeSession({
        contextSummary: '已确定参数',
        summaryUpToMessageId: 'a1',
      }),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: '之前阈值是多少？',
      provider,
      modelContextWindowTokens: 4_000,
      recallHistory: async ({ upToMessageId }) => history(upToMessageId),
    });
    expect(prepared.recalledHistoryContext).toContain('0.37');
    expect(prepared.tokenEstimate).toBeLessThanOrEqual(3_200);
  });

  it('does not search before there is any summarized history', async () => {
    const { ids, messages } = makeTurns(2, 10);
    const recallHistory = jest.fn();
    await prepareChatContext({
      session: makeSession(),
      messageIds: ids,
      sessionMessages: messages,
      currentUserContent: '之前阈值是多少',
      provider,
      recallHistory,
    });
    expect(recallHistory).not.toHaveBeenCalled();
  });

  it('fails visibly when the history store is unavailable instead of silently guessing', async () => {
    const { ids, messages } = makeTurns(3, 10);
    await expect(
      prepareChatContext({
        session: makeSession({ summaryUpToMessageId: 'a0' }),
        messageIds: ids,
        sessionMessages: messages,
        currentUserContent: '之前阈值是多少',
        provider,
        recallHistory: jest
          .fn()
          .mockRejectedValue(new Error('history unavailable')),
      }),
    ).rejects.toThrow('history unavailable');
  });

  it('does not proceed after a cancelled lookup', async () => {
    const { ids, messages } = makeTurns(3, 10);
    const controller = new AbortController();
    await expect(
      prepareChatContext({
        session: makeSession({ summaryUpToMessageId: 'a0' }),
        messageIds: ids,
        sessionMessages: messages,
        currentUserContent: '之前阈值是多少',
        provider,
        signal: controller.signal,
        recallHistory: async ({ upToMessageId }) => {
          controller.abort();
          return history(upToMessageId);
        },
      }),
    ).rejects.toThrow('Aborted');
  });
});
