import { describe, expect, it } from '@jest/globals';
import { applyStreamEventToBlocks } from './agentChatStore';
import type { MessageBlock } from '../../shared/agentTypes';

function toolCallBlock(id: string): MessageBlock {
  return {
    type: 'tool_call',
    id,
    name: 'read_workspace_file',
    arguments: '{}',
    status: 'done',
    collapsed: true,
  };
}

describe('applyStreamEventToBlocks reasoning_delta', () => {
  it('appends to the last reasoning block', () => {
    let blocks: MessageBlock[] = [
      { type: 'reasoning', content: '先看', collapsed: false },
    ];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'reasoning_delta',
      content: '需求',
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'reasoning',
      content: '先看需求',
    });
  });

  it('starts a new reasoning block after a tool call', () => {
    let blocks: MessageBlock[] = [
      { type: 'reasoning', content: '第一轮', collapsed: true },
      toolCallBlock('t1'),
    ];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'reasoning_delta',
      content: '第二轮',
    });
    expect(blocks.map((block) => block.type)).toEqual([
      'reasoning',
      'tool_call',
      'reasoning',
    ]);
    expect(blocks[0]).toMatchObject({ content: '第一轮' });
    expect(blocks[2]).toMatchObject({
      type: 'reasoning',
      content: '第二轮',
      collapsed: false,
    });
  });
});
