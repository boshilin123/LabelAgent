import type { ChatMessage } from '../../shared/agentTypes';
import { normalizeHistoricalAssistantMessage } from './agentChatStore';

function assistantMessage(
  status: ChatMessage['status'],
  blocks: ChatMessage['blocks'] = [{ type: 'text', content: '提案已生成' }],
): ChatMessage {
  return {
    id: 'm1',
    sessionId: 'sess-1',
    role: 'assistant',
    blocks,
    status,
    providerId: 'p1',
    model: 'm1',
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('normalizeHistoricalAssistantMessage: awaiting_confirmation', () => {
  it('历史加载时把 awaiting_confirmation 落为 done 并补 finishedAt', () => {
    const normalized = normalizeHistoricalAssistantMessage(
      assistantMessage('awaiting_confirmation'),
    );
    expect(normalized.status).toBe('done');
    expect(normalized.finishedAt).toBeDefined();
  });

  it('落为 done 后提案块仍保持 pending（Keep All 栏重启后仍可用）', () => {
    const normalized = normalizeHistoricalAssistantMessage(
      assistantMessage('awaiting_confirmation', [
        { type: 'text', content: '提案已生成' },
        {
          type: 'annotation_proposal',
          status: 'pending',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'x',
            changes: [
              {
                relativePath: 'data/2.jpg',
                absolutePath: '/p/data/2.jpg',
                operation: 'append',
                annotations: [],
              },
            ],
            stats: { kind: 'generic', processed: 1, succeeded: 1, skipped: 0 },
            createdAt: 1,
          },
        },
      ]),
    );
    expect(normalized.status).toBe('done');
    const proposalBlock = normalized.blocks.find(
      (block) => block.type === 'annotation_proposal',
    );
    expect(proposalBlock).toMatchObject({ status: 'pending' });
  });

  it('done 消息不受影响', () => {
    const normalized = normalizeHistoricalAssistantMessage(
      assistantMessage('done'),
    );
    expect(normalized.status).toBe('done');
  });

  it('无提案的 streaming 消息不在此函数处理（保持原状）', () => {
    // isTerminal 不含「无提案的 streaming」，由其他清理层负责
    const normalized = normalizeHistoricalAssistantMessage(
      assistantMessage('streaming'),
    );
    expect(normalized.status).toBe('streaming');
  });
});
