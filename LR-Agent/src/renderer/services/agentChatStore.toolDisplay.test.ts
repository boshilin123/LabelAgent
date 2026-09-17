import { applyStreamEventToBlocks } from './agentChatStore';
import type { MessageBlock } from '../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';
import {
  formatToolCallLabel,
  isFoldableTool,
  summarizeToolArgumentsForDisplay,
  summarizeToolResultForDisplay,
} from './toolDisplayUtils';

describe('isFoldableTool（排除式判定）', () => {
  it('folds read-only built-ins, MCP tools and terminal commands', () => {
    expect(isFoldableTool('grep_workspace')).toBe(true);
    expect(isFoldableTool('read_workspace_file')).toBe(true);
    expect(isFoldableTool('glob_workspace')).toBe(true);
    expect(isFoldableTool('read_document_file')).toBe(true);
    expect(isFoldableTool('read_image_for_vision')).toBe(true);
    expect(isFoldableTool('read_file_annotation')).toBe(true);
    expect(isFoldableTool('tavily_search')).toBe(true);
    expect(isFoldableTool('memory_read')).toBe(true);
    expect(isFoldableTool('start_terminal_command')).toBe(true);
  });

  it('keeps side-effecting tool rows foldable too (结算后折进 Worked for)', () => {
    expect(isFoldableTool('write_workspace_file')).toBe(true);
    expect(isFoldableTool('str_replace_workspace_file')).toBe(true);
    expect(isFoldableTool('delete_workspace_file')).toBe(true);
    expect(isFoldableTool('move_workspace_file')).toBe(true);
    expect(isFoldableTool('auto_annotate')).toBe(true);
    expect(isFoldableTool('mutate_annotation')).toBe(true);
  });

  it('never folds the subagent entry point', () => {
    expect(isFoldableTool('explore_readonly')).toBe(false);
  });
});

describe('formatToolCallLabel', () => {
  it('formats read with line range', () => {
    const label = formatToolCallLabel(
      'read_workspace_file',
      JSON.stringify({
        relative_path: 'src/Foo.tsx',
        start_line: 1,
        end_line: 80,
      }),
    );
    expect(label).toBe('Read src/Foo.tsx L1-80');
  });

  it('formats grep', () => {
    const label = formatToolCallLabel(
      'grep_workspace',
      JSON.stringify({ pattern: 'AgentMode', path: 'src' }),
    );
    expect(label).toBe('Grepped AgentMode in src');
  });

  it('formats list directory', () => {
    const label = formatToolCallLabel(
      'list_workspace_directory',
      JSON.stringify({ relative_dir: 'src' }),
    );
    expect(label).toBe('Listed src');
  });

  it('formats glob and document', () => {
    expect(
      formatToolCallLabel(
        'glob_workspace',
        JSON.stringify({ glob_pattern: '**/*.ts' }),
      ),
    ).toBe('Glob **/*.ts');
    expect(
      formatToolCallLabel(
        'read_document_file',
        JSON.stringify({ relative_path: 'docs/a.pdf' }),
      ),
    ).toBe('文档 docs/a.pdf');
  });
});

describe('summarizeToolResultForDisplay', () => {
  it('truncates long grep results', () => {
    const long = `${'line\n'.repeat(500)}tail`;
    const display = summarizeToolResultForDisplay('grep_workspace', long);
    expect(display.length).toBeLessThan(long.length);
    expect(display).toContain('字符');
  });
});

describe('summarizeToolArgumentsForDisplay', () => {
  it('replaces write_workspace_file content with size summary', () => {
    const raw = JSON.stringify({
      relative_path: 'algo/dijkstra.cpp',
      content: 'line1\nline2\nline3',
    });
    const display = summarizeToolArgumentsForDisplay(
      'write_workspace_file',
      raw,
    );
    expect(display).toContain('algo/dijkstra.cpp');
    expect(display).toContain('字符');
    expect(display).not.toContain('line1');
  });
});

describe('applyStreamEventToBlocks tool_start', () => {
  it('stores summarized arguments and defaults collapsed to true', () => {
    const args = JSON.stringify({
      relative_path: 'a.cpp',
      content: 'int x = 1;',
    });
    const blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 'id-1',
      name: 'write_workspace_file',
      arguments: args,
    });
    expect(blocks).toHaveLength(1);
    const tool = blocks[0];
    if (tool.type !== 'tool_call') throw new Error('expected tool_call');
    expect(tool.collapsed).toBe(true);
    expect(tool.arguments).not.toContain('int x = 1');
    expect(tool.arguments).toContain('a.cpp');
  });
});

describe('applyStreamEventToBlocks annotation tool_result', () => {
  const runningPipeline: MessageBlock = {
    type: 'annotation_pipeline',
    collapsed: false,
    pipelineKind: 'batch',
    steps: [
      { stage: 'collect', label: '收集', message: '', status: 'done' },
      { stage: 'workers', label: '处理', message: '', status: 'running' },
    ],
  };

  function seedBlocks(): MessageBlock[] {
    return [
      runningPipeline,
      {
        type: 'tool_call',
        id: 't-1',
        name: 'auto_annotate',
        arguments: '{}',
        status: 'running',
        collapsed: true,
      },
    ];
  }

  it('settles running pipeline steps when auto_annotate finishes', () => {
    const blocks = applyStreamEventToBlocks(seedBlocks(), {
      type: 'tool_result',
      toolCallId: 't-1',
      result: '{"status":"completed"}',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);
    const pipeline = blocks[0];
    if (pipeline.type !== 'annotation_pipeline') throw new Error('pipeline');
    expect(pipeline.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('marks running steps as error on phase_blocked', () => {
    const blocks = applyStreamEventToBlocks(seedBlocks(), {
      type: 'tool_result',
      toolCallId: 't-1',
      result: '{"status":"phase_blocked","summary":"no"}',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);
    const pipeline = blocks[0];
    if (pipeline.type !== 'annotation_pipeline') throw new Error('pipeline');
    expect(pipeline.steps[1].status).toBe('error');
  });

  it('settles mutation pipeline when mutate_annotation finishes', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'annotation_pipeline',
        collapsed: false,
        pipelineKind: 'mutation',
        steps: [
          { stage: 'resolve', label: '解析', message: '', status: 'running' },
        ],
      },
      {
        type: 'tool_call',
        id: 't-2',
        name: 'mutate_annotation',
        arguments: '{}',
        status: 'running',
        collapsed: true,
      },
    ];
    const next = applyStreamEventToBlocks(blocks, {
      type: 'tool_result',
      toolCallId: 't-2',
      result: '{"status":"completed"}',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);
    const pipeline = next[0];
    if (pipeline.type !== 'annotation_pipeline') throw new Error('pipeline');
    expect(pipeline.steps[0].status).toBe('done');
  });
});

describe('applyStreamEventToBlocks client tool queue semantics', () => {
  const annotateArgs = JSON.stringify({ user_request: '标注第 6~8 张' });

  function makeProposal(
    id: string,
    operation: 'append' | 'delete',
  ): AnnotationBatchProposal {
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
            relativePath: 'data/6.jpg',
            absolutePath: 'C:/proj/data/6.jpg',
            operation: 'append' as const,
            annotations: [],
          };
    return {
      id,
      projectId: 'proj-1',
      summary: '批量标注',
      changes: [change],
      stats: { kind: 'generic', processed: 1, succeeded: 1, skipped: 0 },
      createdAt: Date.now(),
    } as unknown as AnnotationBatchProposal;
  }

  function toolBlockAt(
    blocks: MessageBlock[],
    id: string,
  ): Extract<MessageBlock, { type: 'tool_call' }> {
    const block = blocks.find(
      (b): b is Extract<MessageBlock, { type: 'tool_call' }> =>
        b.type === 'tool_call' && b.id === id,
    );
    if (!block) throw new Error(`tool_call ${id} not found`);
    return block;
  }

  it('creates client annotation tools as queued on tool_start', () => {
    const blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 'a1',
      name: 'auto_annotate',
      arguments: annotateArgs,
    });
    expect(toolBlockAt(blocks, 'a1').status).toBe('queued');
  });

  it('keeps server-side tools running on tool_start', () => {
    const blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 's1',
      name: 'list_workspace_directory',
      arguments: '{}',
    });
    expect(toolBlockAt(blocks, 's1').status).toBe('running');
  });

  it('flips queued to running on the repeated tool_start and keeps arguments', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 'a1',
      name: 'auto_annotate',
      arguments: annotateArgs,
    });
    // runLoop 开始执行该工具时合成的第二个 tool_start（arguments 为空串）
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_start',
      toolCallId: 'a1',
      name: 'auto_annotate',
      arguments: '',
    });
    const tool = toolBlockAt(blocks, 'a1');
    expect(tool.status).toBe('running');
    expect(tool.arguments).toContain('标注第 6~8 张');
  });

  it('settles only the matching-kind client tool when a proposal arrives', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 'a1',
      name: 'auto_annotate',
      arguments: annotateArgs,
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_start',
      toolCallId: 'm1',
      name: 'mutate_annotation',
      arguments: annotateArgs,
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: makeProposal('p1', 'append'),
    });
    expect(toolBlockAt(blocks, 'a1').status).toBe('done');
    // mutation 提案未到，mutate_annotation 保持排队
    expect(toolBlockAt(blocks, 'm1').status).toBe('queued');
    const proposal = blocks.find((b) => b.type === 'annotation_proposal');
    if (proposal?.type !== 'annotation_proposal') throw new Error('proposal');
    expect(proposal.sourceKind).toBe('batch');
  });

  it('marks mutation proposal sourceKind and settles the mutate tool', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 'm1',
      name: 'mutate_annotation',
      arguments: annotateArgs,
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_start',
      toolCallId: 'm1',
      name: 'mutate_annotation',
      arguments: '',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: makeProposal('p2', 'delete'),
    });
    expect(toolBlockAt(blocks, 'm1').status).toBe('done');
    const proposal = blocks.find((b) => b.type === 'annotation_proposal');
    if (proposal?.type !== 'annotation_proposal') throw new Error('proposal');
    expect(proposal.sourceKind).toBe('mutation');
  });
});
