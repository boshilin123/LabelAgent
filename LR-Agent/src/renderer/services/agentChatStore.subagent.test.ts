import {
  applyStreamEventToBlocks,
  finalizeSubagentBlocks,
  normalizeHistoricalAssistantMessage,
} from './agentChatStore';
import type { MessageBlock } from '../../shared/agentTypes';
import { isFoldableTool } from './toolDisplayUtils';
import { buildAssistantRenderSegments } from '../components/agent/explorationRenderUtils';

describe('applyStreamEventToBlocks subagent', () => {
  it('creates a subagent block from explore_readonly tool_start', () => {
    const blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 'run-1',
      name: 'explore_readonly',
      arguments: JSON.stringify({
        query: '找 ModePicker',
        focus_path: 'src',
      }),
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'subagent',
      id: 'run-1',
      query: '找 ModePicker',
      focusPath: 'src',
      status: 'running',
      summary: '',
    });
    expect(blocks.some((block) => block.type === 'tool_call')).toBe(false);
  });

  it('merges streaming steps and summary, preferring subagent_done', () => {
    let blocks: MessageBlock[] = [];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_start',
      toolCallId: 'run-2',
      name: 'explore_readonly',
      arguments: JSON.stringify({ query: '查路由' }),
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'subagent_tool_start',
      toolCallId: 'run-2',
      innerToolCallId: 's1',
      name: 'grep_workspace',
      arguments: JSON.stringify({ pattern: 'route' }),
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'subagent_tool_result',
      toolCallId: 'run-2',
      innerToolCallId: 's1',
      result: 'src/router.ts:1: route',
      status: 'done',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'subagent_text_delta',
      toolCallId: 'run-2',
      content: '流式',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'subagent_done',
      toolCallId: 'run-2',
      summary: '最终摘要',
      status: 'done',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_result',
      toolCallId: 'run-2',
      result: JSON.stringify({ summary: '不应覆盖' }),
    });

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.type).toBe('subagent');
    if (block.type !== 'subagent') return;
    expect(block.summary).toBe('最终摘要');
    expect(block.status).toBe('done');
    expect(block.steps).toHaveLength(1);
    expect(block.steps[0]).toMatchObject({
      id: 's1',
      name: 'grep_workspace',
      result: 'src/router.ts:1: route',
      status: 'done',
    });
    expect(block.innerBlocks).toEqual([
      {
        type: 'tool_call',
        id: 's1',
        name: 'grep_workspace',
        arguments: JSON.stringify({ pattern: 'route' }),
        status: 'done',
        result: 'src/router.ts:1: route',
        collapsed: true,
      },
      { type: 'text', content: '流式' },
      { type: 'text', content: '最终摘要' },
    ]);
  });

  it('interleaves narration text before a tool call in innerBlocks', () => {
    let blocks: MessageBlock[] = [];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_start',
      toolCallId: 'run-narrate',
      name: 'explore_readonly',
      arguments: JSON.stringify({ query: '旁白' }),
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'subagent_text_delta',
      toolCallId: 'run-narrate',
      content: '先看',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'subagent_text_delta',
      toolCallId: 'run-narrate',
      content: '路由',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'subagent_tool_start',
      toolCallId: 'run-narrate',
      innerToolCallId: 'g1',
      name: 'grep_workspace',
      arguments: '{"pattern":"route"}',
    });
    const block = blocks[0];
    expect(block.type).toBe('subagent');
    if (block.type !== 'subagent') return;
    expect(block.innerBlocks).toEqual([
      { type: 'text', content: '先看路由' },
      {
        type: 'tool_call',
        id: 'g1',
        name: 'grep_workspace',
        arguments: '{"pattern":"route"}',
        status: 'running',
        collapsed: true,
      },
    ]);
  });

  it('fills summary from tool_result when stream summary is empty', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 'run-3',
      name: 'explore_readonly',
      arguments: JSON.stringify({ query: '空流' }),
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_result',
      toolCallId: 'run-3',
      result: JSON.stringify({ summary: '兜底摘要' }),
    });
    const block = blocks[0];
    expect(block.type).toBe('subagent');
    if (block.type !== 'subagent') return;
    expect(block.summary).toBe('兜底摘要');
    expect(block.status).toBe('done');
  });

  it('finalizes running subagent blocks on stop / history reload', () => {
    const running: MessageBlock = {
      type: 'subagent',
      id: 'run-stop',
      query: '查阅中',
      status: 'running',
      steps: [
        {
          id: 's1',
          name: 'grep_workspace',
          arguments: '{}',
          status: 'running',
        },
      ],
      summary: '',
      startedAt: 1,
    };
    const finalized = finalizeSubagentBlocks([running], 'error');
    expect(finalized[0]).toMatchObject({
      type: 'subagent',
      status: 'error',
    });
    if (finalized[0].type === 'subagent') {
      expect(finalized[0].steps[0].status).toBe('error');
      expect(finalized[0].summary).toBe('已停止');
      expect(finalized[0].finishedAt).toBeGreaterThan(0);
    }

    const normalized = normalizeHistoricalAssistantMessage({
      id: 'm1',
      sessionId: 's1',
      role: 'assistant',
      blocks: [running],
      status: 'stopped',
      providerId: 'p',
      model: 'm',
      createdAt: 1,
      updatedAt: 1,
    });
    expect(normalized.blocks[0]).toMatchObject({
      type: 'subagent',
      status: 'error',
    });
  });
});

describe('explore_readonly stays out of exploration group', () => {
  it('is not foldable (subagent 行的入口必须留在主时间线)', () => {
    expect(isFoldableTool('explore_readonly')).toBe(false);
  });

  it('renders subagent as its own segment', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'subagent',
        id: 'run-9',
        query: '摸底',
        status: 'done',
        steps: [],
        summary: 'ok',
        startedAt: 1,
      },
      {
        type: 'tool_call',
        id: 'g1',
        name: 'grep_workspace',
        arguments: '{"pattern":"A"}',
        status: 'done',
        collapsed: true,
      },
    ];
    const segments = buildAssistantRenderSegments(blocks);
    expect(segments[0]).toMatchObject({ kind: 'block' });
    expect(segments[1]).toMatchObject({ kind: 'exploration' });
  });
});
