import { describe, expect, it } from '@jest/globals';
import {
  applyStreamEventToBlocks,
  normalizeAnnotationCardOrder,
  normalizeHistoricalAssistantMessage,
} from './agentChatStore';
import type { MessageBlock } from '../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';

function textBlock(content: string): MessageBlock {
  return { type: 'text', content };
}

function reasoningBlock(content: string): MessageBlock {
  return { type: 'reasoning', content, collapsed: false };
}

function toolCallBlock(name: string): MessageBlock {
  return {
    type: 'tool_call',
    id: `tool-${name}`,
    name,
    arguments: '{}',
    status: 'done',
    result: 'done',
    collapsed: true,
  };
}

function pipelineBlock(
  overrides: Partial<
    Extract<MessageBlock, { type: 'annotation_pipeline' }>
  > = {},
): MessageBlock {
  return {
    type: 'annotation_pipeline',
    collapsed: true,
    steps: [
      { stage: 'prepare', label: 'prepare', message: 'ok', status: 'done' },
    ],
    pipelineKind: 'batch',
    ...overrides,
  };
}

function proposalBlock(
  id = 'p1',
  operation: 'append' | 'delete' = 'append',
): Extract<MessageBlock, { type: 'annotation_proposal' }> {
  const change =
    operation === 'delete'
      ? {
          relativePath: 'data/8.jpg',
          absolutePath: 'C:/proj/data/8.jpg',
          operation: 'delete' as const,
          deleteIds: ['unlabeled-1'],
          annotations: [],
        }
      : {
          relativePath: '测试文本.txt',
          absolutePath: 'C:/proj/测试文本.txt',
          operation: 'append' as const,
          annotations: [],
        };
  const proposal = {
    id,
    projectId: 'proj-1',
    summary: operation === 'delete' ? '删除无标签框' : '批量标注',
    changes: [change],
    stats: {
      kind: 'generic' as const,
      processed: 1,
      succeeded: 1,
      skipped: 0,
    },
    createdAt: Date.now(),
  } as AnnotationBatchProposal;
  return { type: 'annotation_proposal', proposal, status: 'pending' };
}

describe('applyStreamEventToBlocks annotation card ordering', () => {
  it('appends late text_delta after an existing annotation_proposal', () => {
    let blocks: MessageBlock[] = [proposalBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '让我先查看项目结构。',
    });
    expect(blocks.map((b) => b.type)).toEqual(['annotation_proposal', 'text']);
    const text = blocks[1];
    if (text.type !== 'text') throw new Error('expected text');
    expect(text.content).toContain('让我先查看');
  });

  it('merges consecutive late text_delta into one trailing text block', () => {
    let blocks: MessageBlock[] = [pipelineBlock(), proposalBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '第一句。',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '第二句。',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'annotation_pipeline',
      'annotation_proposal',
      'text',
    ]);
    const text = blocks[2];
    if (text.type !== 'text') throw new Error('expected text');
    expect(text.content).toBe('第一句。第二句。');
  });

  it('appends new tool_call after the card, and tool_result updates in place', () => {
    let blocks: MessageBlock[] = [pipelineBlock(), proposalBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_start',
      toolCallId: 't-1',
      name: 'list_workspace_directory',
      arguments: '{}',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'annotation_pipeline',
      'annotation_proposal',
      'tool_call',
    ]);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_result',
      toolCallId: 't-1',
      result: 'Explored 1 file',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'annotation_pipeline',
      'annotation_proposal',
      'tool_call',
    ]);
    const tool = blocks[2];
    if (tool.type !== 'tool_call') throw new Error('expected tool_call');
    expect(tool.result).toContain('Explored');
  });

  it('appends new reasoning block after the card', () => {
    let blocks: MessageBlock[] = [pipelineBlock(), proposalBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'reasoning_delta',
      content: '已思考',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'annotation_pipeline',
      'annotation_proposal',
      'reasoning',
    ]);
  });

  it('places annotation_proposal right after the batch pipeline', () => {
    let blocks: MessageBlock[] = [textBlock('开头叙述'), pipelineBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: proposalBlock().proposal,
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'text',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
  });

  it('appends annotation_proposal to end when no pipeline exists', () => {
    let blocks: MessageBlock[] = [textBlock('开头叙述')];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: proposalBlock().proposal,
    });
    expect(blocks.map((b) => b.type)).toEqual(['text', 'annotation_proposal']);
  });

  it('keeps two annotation proposals with different ids', () => {
    let blocks: MessageBlock[] = [
      textBlock('开头叙述'),
      pipelineBlock(),
      proposalBlock('batch-1', 'append'),
      pipelineBlock({ pipelineKind: 'mutation' }),
    ];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: proposalBlock('mut-1', 'delete').proposal,
    });
    const proposals = blocks.filter(
      (b): b is Extract<MessageBlock, { type: 'annotation_proposal' }> =>
        b.type === 'annotation_proposal',
    );
    expect(proposals.map((b) => b.proposal.id)).toEqual(['batch-1', 'mut-1']);
    expect(blocks.map((b) => b.type)).toEqual([
      'text',
      'annotation_pipeline',
      'annotation_proposal',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
  });

  it('upserts annotation_proposal with the same id and keeps status', () => {
    let blocks: MessageBlock[] = [proposalBlock('p1', 'append')];
    const existing = blocks[0] as Extract<
      MessageBlock,
      { type: 'annotation_proposal' }
    >;
    existing.status = 'applied';
    const updated = proposalBlock('p1', 'append').proposal;
    updated.summary = '更新后的摘要';
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: updated,
    });
    const proposals = blocks.filter((b) => b.type === 'annotation_proposal');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: 'annotation_proposal',
      status: 'applied',
      proposal: { id: 'p1', summary: '更新后的摘要' },
    });
  });

  it('keeps hasCheckpoint when upserting an applied annotation_proposal', () => {
    let blocks: MessageBlock[] = [proposalBlock('p1', 'append')];
    const existing = blocks[0] as Extract<
      MessageBlock,
      { type: 'annotation_proposal' }
    >;
    existing.status = 'applied';
    existing.hasCheckpoint = true;
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: existing.proposal,
    });
    expect(blocks[0]).toMatchObject({
      type: 'annotation_proposal',
      status: 'applied',
      hasCheckpoint: true,
    });
  });

  it('places mutation proposal after the mutation pipeline', () => {
    let blocks: MessageBlock[] = [
      pipelineBlock(),
      proposalBlock('batch-1', 'append'),
      pipelineBlock({ pipelineKind: 'mutation' }),
    ];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: proposalBlock('mut-1', 'delete').proposal,
    });
    expect(
      blocks.map(
        (b) => (b as { pipelineKind?: string }).pipelineKind ?? b.type,
      ),
    ).toEqual([
      'batch',
      'annotation_proposal',
      'mutation',
      'annotation_proposal',
    ]);
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe('annotation_proposal');
    if (last.type === 'annotation_proposal') {
      expect(last.proposal.id).toBe('mut-1');
    }
  });

  it('keeps original behavior (append) when no card exists', () => {
    let blocks: MessageBlock[] = [reasoningBlock('思考')];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '纯文本回答',
    });
    expect(blocks.map((b) => b.type)).toEqual(['reasoning', 'text']);
  });
});

describe('normalizeAnnotationCardOrder', () => {
  it('keeps chronological order instead of moving cards to the tail', () => {
    const blocks: MessageBlock[] = [
      toolCallBlock('list_workspace_directory'),
      pipelineBlock(),
      proposalBlock(),
      textBlock('让我先查看…'),
      toolCallBlock('read_workspace_file'),
      textBlock('文件已读取。'),
    ];
    const out = normalizeAnnotationCardOrder(blocks);
    expect(out.map((b) => b.type)).toEqual([
      'tool_call',
      'annotation_pipeline',
      'annotation_proposal',
      'text',
      'tool_call',
      'text',
    ]);
  });

  it('returns input unchanged when no card exists', () => {
    const blocks: MessageBlock[] = [textBlock('a'), textBlock('b')];
    expect(normalizeAnnotationCardOrder(blocks)).toEqual(blocks);
  });
});

describe('normalizeHistoricalAssistantMessage', () => {
  it('keeps a persisted assistant message in chronological order', () => {
    const message = {
      id: 'm1',
      sessionId: 's1',
      role: 'assistant' as const,
      status: 'done' as const,
      providerId: 'provider-1',
      model: 'model-1',
      createdAt: 1,
      updatedAt: 2,
      blocks: [
        pipelineBlock(),
        proposalBlock(),
        textBlock('让我先查看项目结构。'),
      ],
    };
    const out = normalizeHistoricalAssistantMessage(message);
    expect(out.blocks.map((b) => b.type)).toEqual([
      'annotation_pipeline',
      'annotation_proposal',
      'text',
    ]);
    expect(out.finishedAt).toBe(2);
  });
});
