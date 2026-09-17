import type { ChatMessage } from '../../shared/agentTypes';
import {
  findSubagentBlock,
  isSamePanelTab,
  panelTabKey,
  subagentTranscriptBlocks,
  truncateSubagentQuery,
} from './subagentBlocks';

function messageWithSubagent(id: string): ChatMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'assistant',
    blocks: [
      {
        type: 'subagent',
        id,
        query: '查找 ModePicker 实现位置',
        status: 'done',
        steps: [],
        summary: '在 src/components',
        startedAt: 1,
        finishedAt: 2,
      },
    ],
    status: 'done',
    providerId: 'p',
    model: 'm',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('subagent tab helpers', () => {
  it('finds a block after the panel tab is closed', () => {
    const messagesBySession = {
      s1: { m1: messageWithSubagent('run-1') },
    };
    const found = findSubagentBlock(messagesBySession, 'run-1');
    expect(found?.block.summary).toBe('在 src/components');
    expect(found?.sessionId).toBe('s1');
  });

  it('truncates tab title and distinguishes tab kinds', () => {
    expect(
      truncateSubagentQuery('查找 ModePicker 实现位置以及调用链', 12),
    ).toContain('…');
    expect(
      isSamePanelTab(
        { kind: 'subagent', runId: 'a', sessionId: 's1' },
        { kind: 'subagent', runId: 'a', sessionId: 's1' },
      ),
    ).toBe(true);
    expect(panelTabKey({ kind: 'session', sessionId: 's1' })).toBe(
      'session:s1',
    );
  });

  it('appends summary when innerBlocks has tools but no text', () => {
    const blocks = subagentTranscriptBlocks({
      type: 'subagent',
      id: 'run-2',
      query: '摸底',
      status: 'done',
      steps: [],
      innerBlocks: [
        {
          type: 'tool_call',
          id: 's1',
          name: 'grep_workspace',
          arguments: '{}',
          status: 'done',
          collapsed: true,
        },
      ],
      summary: '补上的结论',
      startedAt: 1,
    });
    expect(blocks[blocks.length - 1]).toEqual({
      type: 'text',
      content: '补上的结论',
    });
  });

  it('rebuilds a transcript from historical steps + summary', () => {
    const blocks = subagentTranscriptBlocks({
      type: 'subagent',
      id: 'run-1',
      query: '摸底',
      status: 'done',
      steps: [
        {
          id: 's1',
          name: 'grep_workspace',
          arguments: '{"pattern":"A"}',
          status: 'done',
          result: 'hit',
        },
      ],
      summary: '历史摘要',
      startedAt: 1,
    });
    expect(blocks).toEqual([
      {
        type: 'tool_call',
        id: 's1',
        name: 'grep_workspace',
        arguments: '{"pattern":"A"}',
        status: 'done',
        result: 'hit',
        collapsed: true,
      },
      { type: 'text', content: '历史摘要' },
    ]);
  });
});
