import type { MessageBlock } from '../../../shared/agentTypes';
import { buildAssistantRenderSegments } from './explorationRenderUtils';

type ToolCallBlock = Extract<MessageBlock, { type: 'tool_call' }>;

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
  extra: Partial<ToolCallBlock> = {},
): ToolCallBlock {
  return {
    type: 'tool_call',
    id,
    name,
    arguments: JSON.stringify(args),
    status: 'done',
    collapsed: true,
    ...extra,
  };
}

describe('buildAssistantRenderSegments', () => {
  it('merges consecutive exploration tool calls into one segment', () => {
    const blocks: MessageBlock[] = [
      toolCall('t1', 'grep_workspace', { pattern: 'Foo', path: 'src' }),
      toolCall('t2', 'read_workspace_file', {
        relative_path: 'main.py',
        start_line: 1,
        end_line: 20,
      }),
      { type: 'text', content: 'answer' },
    ];

    const segments = buildAssistantRenderSegments(blocks);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      kind: 'exploration',
      summary: 'Explored 1 file, 1 search',
    });
    if (segments[0].kind === 'exploration') {
      expect(segments[0].tools).toHaveLength(2);
    }
    expect(segments[1]).toMatchObject({ kind: 'block' });
  });

  it('does not merge exploration tools separated by other blocks', () => {
    const blocks: MessageBlock[] = [
      toolCall('t1', 'grep_workspace', { pattern: 'A' }),
      { type: 'text', content: 'mid' },
      toolCall('t2', 'read_workspace_file', { relative_path: 'b.ts' }),
    ];

    const segments = buildAssistantRenderSegments(blocks);
    expect(segments).toHaveLength(3);
    expect(segments[0].kind).toBe('exploration');
    expect(segments[1].kind).toBe('block');
    expect(segments[2].kind).toBe('exploration');
  });

  it('does not merge write tools (折叠区内逐行保留标签)', () => {
    const blocks: MessageBlock[] = [
      toolCall('t1', 'write_workspace_file', { relative_path: 'a.md' }),
      toolCall('t2', 'grep_workspace', { pattern: 'X' }),
    ];

    const segments = buildAssistantRenderSegments(blocks);
    expect(segments).toHaveLength(2);
    expect(segments[0].kind).toBe('block');
    expect(segments[1].kind).toBe('exploration');
  });

  it('does not merge MCP tools either (自己一行，摘要只统计检索类)', () => {
    const blocks: MessageBlock[] = [
      toolCall('t1', 'tavily_search', { query: 'yolov8 下载' }),
      toolCall('t2', 'grep_workspace', { pattern: 'yolo' }),
      toolCall('t3', 'read_workspace_file', { relative_path: 'a.py' }),
    ];

    const segments = buildAssistantRenderSegments(blocks);
    expect(segments.map((segment) => segment.kind)).toEqual([
      'block',
      'exploration',
    ]);
    if (segments[1].kind === 'exploration') {
      expect(segments[1].summary).toBe('Explored 1 file, 1 search');
    }
  });

  it('does not merge failed or unsettled tool calls (留主时间线便于诊断)', () => {
    const failed = toolCall(
      't1',
      'read_workspace_file',
      { relative_path: 'a.py' },
      {
        status: 'error',
      },
    );
    const running = toolCall(
      't2',
      'grep_workspace',
      { pattern: 'X' },
      {
        status: 'running',
      },
    );

    const segments = buildAssistantRenderSegments([failed, running]);
    expect(segments.map((segment) => segment.kind)).toEqual(['block', 'block']);
  });

  it('walks a custom index order for work-history slices', () => {
    const blocks: MessageBlock[] = [
      toolCall('t1', 'grep_workspace', { pattern: 'A' }),
      { type: 'text', content: 'answer' },
      toolCall('t2', 'read_workspace_file', { relative_path: 'b.ts' }),
    ];

    const segments = buildAssistantRenderSegments(blocks, [0, 2]);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('exploration');
    if (segments[0].kind === 'exploration') {
      expect(segments[0].tools).toHaveLength(2);
    }
  });

  it('does not fold explore_readonly or subagent into exploration', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'subagent',
        id: 'run-1',
        query: '摸底 src',
        status: 'done',
        steps: [],
        summary: 'ok',
        startedAt: 1,
      },
      toolCall('t1', 'explore_readonly', { query: '不应进组' }),
      toolCall('t2', 'grep_workspace', { pattern: 'X' }),
    ];
    const segments = buildAssistantRenderSegments(blocks);
    expect(segments.map((segment) => segment.kind)).toEqual([
      'block',
      'block',
      'exploration',
    ]);
  });

  it('keeps write tools and file proposals as separate visible blocks', () => {
    const blocks: MessageBlock[] = [
      toolCall('t1', 'write_workspace_file', { relative_path: 'a.md' }),
      {
        type: 'file_proposal',
        title: 'a.md',
        content: 'x',
        suggestedRelativePath: 'a.md',
        status: 'pending',
      },
    ];
    const segments = buildAssistantRenderSegments(blocks);
    expect(segments.map((segment) => segment.kind)).toEqual(['block', 'block']);
  });
});
