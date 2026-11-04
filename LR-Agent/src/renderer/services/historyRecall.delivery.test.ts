import { startChatJob } from './agentJobRegistry';
import { streamChatViaBackend } from './backendChatClient';
import { streamChatDirectly } from './localChatClient';
import { prepareChatContext } from './contextPreparer';
import type {
  AgentSession,
  ChatMessage,
  ClientContextPayload,
} from '../../shared/agentTypes';

jest.mock('./backendChatClient', () => ({
  ...jest.requireActual('./backendChatClient'),
  streamChatViaBackend: jest.fn(),
}));
jest.mock('./localChatClient', () => ({ streamChatDirectly: jest.fn() }));
jest.mock('./annotationBatchJob', () => ({
  startAnnotationBatchJob: jest.fn(),
}));
jest.mock('./annotationMutationBatchJob', () => ({
  startAnnotationMutationJob: jest.fn(),
}));

it.each(['direct', 'backend'])(
  'delivers recovered evidence to the %s request without replaying old tools',
  async (route) => {
    jest.clearAllMocks();
    for (const mock of [streamChatViaBackend, streamChatDirectly]) {
      jest.mocked(mock).mockImplementation(async function* () {
        yield { type: 'done' };
      });
    }
    const session: AgentSession = {
      id: 's-recall',
      title: 't',
      providerId: 'p',
      model: 'm',
      messageIds: ['u0', 'a0', 'u1', 'a1'],
      contextSummary: '已确定参数',
      summaryUpToMessageId: 'a0',
      createdAt: 1,
      updatedAt: 1,
    };
    const messages: Record<string, ChatMessage> = {
      u1: {
        id: 'u1',
        sessionId: session.id,
        role: 'user',
        status: 'done',
        providerId: 'p',
        model: 'm',
        blocks: [{ type: 'text', content: '之前的检测阈值是多少？' }],
        createdAt: 2,
        updatedAt: 2,
      },
      a1: {
        id: 'a1',
        sessionId: session.id,
        role: 'assistant',
        status: 'streaming',
        providerId: 'p',
        model: 'm',
        blocks: [],
        createdAt: 3,
        updatedAt: 3,
      },
    };
    const prepared = await prepareChatContext({
      session,
      messageIds: session.messageIds,
      sessionMessages: messages,
      currentUserContent: '之前的检测阈值是多少？',
      provider: { baseUrl: 'http://offline', apiKey: 'k', model: 'm' },
      excludeMessageIds: new Set(['a1']),
      recallHistory: async ({ upToMessageId }) => ({
        sessionId: session.id,
        upToMessageId,
        explicitReference: true,
        turns: [
          {
            turn: 1,
            score: 5,
            messages: [
              {
                id: 'a0',
                role: 'assistant',
                text: '历史 auto_annotate 工具结果：检测阈值为 0.37',
                createdAt: 1,
                updatedAt: 1,
                truncated: false,
              },
            ],
          },
        ],
      }),
    });
    await startChatJob({
      jobId: `job-recall-${route}`,
      session,
      messageIds: prepared.windowedMessageIds,
      sessionMessages: messages,
      providerId: 'p',
      providerBaseUrl: 'http://offline',
      providerApiKey: 'k',
      providerModel: 'm',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      userContent: '之前的检测阈值是多少？',
      recalledHistoryContext: prepared.recalledHistoryContext,
      clientContext:
        route === 'backend'
          ? ({
              workspaceRoot: '/workspace',
              agentMode: 'chat',
              workMode: 'editor',
            } as ClientContextPayload)
          : undefined,
    });
    const called = jest.mocked(
      route === 'backend' ? streamChatViaBackend : streamChatDirectly,
    );
    expect(called).toHaveBeenCalledTimes(1);
    const payload = called.mock.calls[0][0];
    expect(payload.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('0.37'),
    });
    expect(
      payload.messages.some(
        (message) => 'tool_calls' in message && message.tool_calls?.length,
      ),
    ).toBe(false);
    expect(session.contextSummary).toBe('已确定参数');
  },
);
