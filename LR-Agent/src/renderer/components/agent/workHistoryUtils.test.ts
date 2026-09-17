import { describe, expect, it } from '@jest/globals';
import type { MessageBlock } from '../../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import {
  CLIENT_PIPELINE_TOOL_NAMES,
  NEVER_FOLD_TOOL_NAMES,
  PROPOSAL_TOOL_NAMES,
  isFoldableToolName,
} from '../../../shared/agentToolKinds';
import {
  collectThoughtContent,
  formatThoughtLabel,
  formatWorkedDuration,
  splitWorkHistory,
  workHistoryDurationMs,
} from './workHistoryUtils';

function textBlock(content: string): MessageBlock {
  return { type: 'text', content };
}

function reasoningBlock(content: string): MessageBlock {
  return { type: 'reasoning', content, collapsed: false };
}

type ToolCallBlock = Extract<MessageBlock, { type: 'tool_call' }>;

function toolCallBlock(
  name: string,
  id = `tool-${name}`,
  extra: Partial<ToolCallBlock> = {},
): ToolCallBlock {
  return {
    type: 'tool_call',
    id,
    name,
    arguments: '{}',
    status: 'done',
    collapsed: true,
    ...extra,
  };
}

type PipelineBlock = Extract<MessageBlock, { type: 'annotation_pipeline' }>;

function pipelineBlock(steps?: PipelineBlock['steps']): PipelineBlock {
  return {
    type: 'annotation_pipeline',
    collapsed: true,
    steps: steps ?? [
      { stage: 'prepare', label: 'prepare', message: 'ok', status: 'done' },
    ],
    pipelineKind: 'batch',
  };
}

function proposalBlock(): MessageBlock {
  return {
    type: 'annotation_proposal',
    proposal: {
      id: 'p1',
      projectId: 'proj-1',
      summary: '批量标注',
      changes: [],
      stats: {
        kind: 'generic',
        processed: 1,
        succeeded: 1,
        skipped: 0,
      },
      createdAt: 1,
    } as AnnotationBatchProposal,
    status: 'pending',
  };
}

type FileProposalBlock = Extract<MessageBlock, { type: 'file_proposal' }>;

function fileProposalBlock(
  status: FileProposalBlock['status'] = 'pending',
): FileProposalBlock {
  return {
    type: 'file_proposal',
    title: 'doc.md',
    content: '# hi',
    suggestedRelativePath: 'doc.md',
    status,
  };
}

describe('splitWorkHistory', () => {
  it('returns no history when there are only answer blocks', () => {
    const blocks = [textBlock('你好')];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history).toHaveLength(0);
    expect(rest.map((item) => item.block.type)).toEqual(['text']);
  });

  it('keeps commentary text inside history and trailing answer outside', () => {
    const blocks = [
      textBlock('先读文件'),
      toolCallBlock('read_workspace_file'),
      textBlock('这是最终回答'),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history.map((item) => item.block.type)).toEqual([
      'text',
      'tool_call',
    ]);
    expect(rest.map((item) => item.block.type)).toEqual(['text']);
    expect(rest[0]?.block).toEqual(textBlock('这是最终回答'));
  });

  it('folds settled pipeline and annotation tool rows, keeps pending proposal visible', () => {
    // pipelineBlock() 步骤全 done（已结算）→ 折；proposalBlock() status pending → 留
    const blocks = [
      textBlock('先读目录'),
      toolCallBlock('list_workspace_directory'),
      textBlock('开始标注'),
      toolCallBlock('auto_annotate'),
      textBlock('已完成 3 张图'),
      pipelineBlock(),
      proposalBlock(),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history.map((item) => item.block.type)).toEqual([
      'text',
      'tool_call',
      'text',
      'tool_call',
      'text',
      'annotation_pipeline',
    ]);
    expect(rest.map((item) => item.block.type)).toEqual([
      'annotation_proposal',
    ]);
  });

  it('extracts reasoning out of work history', () => {
    const blocks = [
      reasoningBlock('想一下'),
      toolCallBlock('list_workspace_directory'),
      pipelineBlock(),
      proposalBlock(),
      textBlock('完成'),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history.map((item) => item.block.type)).toEqual([
      'tool_call',
      'annotation_pipeline',
    ]);
    expect(rest.map((item) => item.block.type)).toEqual([
      'annotation_proposal',
      'text',
    ]);
    expect(collectThoughtContent(blocks)).toBe('想一下');
  });

  it('folds settled write/delete tool rows and applied proposal cards', () => {
    const { history, rest } = splitWorkHistory([
      toolCallBlock('write_workspace_file'),
      fileProposalBlock('applied'),
      textBlock('已写好'),
    ]);
    expect(history.map((item) => item.block.type)).toEqual([
      'tool_call',
      'file_proposal',
    ]);
    // 结论文字在最后一项工作之后，留在主时间线
    expect(rest.map((item) => item.block.type)).toEqual(['text']);
  });

  it('keeps pending file proposal cards on the main timeline', () => {
    const blocks = [
      toolCallBlock('delete_workspace_file'),
      {
        type: 'file_proposal',
        title: '删除 notes.md',
        content: '',
        suggestedRelativePath: 'notes.md',
        status: 'pending',
        operation: 'delete',
      } satisfies MessageBlock,
      textBlock('已删除'),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    // 工具行已结束可折，但待确认的卡片必须留在主时间线供 Keep All / Undo
    expect(history.map((item) => item.block.type)).toEqual(['tool_call']);
    expect(rest.map((item) => item.block.type)).toEqual([
      'file_proposal',
      'text',
    ]);
  });

  it('keeps failed pipeline cards on the main timeline', () => {
    const failedPipeline = pipelineBlock([
      { stage: 'prepare', label: 'prepare', message: 'boom', status: 'error' },
    ]);
    const { history, rest } = splitWorkHistory([
      toolCallBlock('grep_workspace'),
      failedPipeline,
    ]);
    expect(history.map((item) => item.block.type)).toEqual(['tool_call']);
    expect(rest.map((item) => item.block.type)).toEqual([
      'annotation_pipeline',
    ]);
  });

  it('folds read-only MCP tools and terminal commands (排除式判定)', () => {
    // 复刻一次「帮我下载 YOLOv8」的实际序列：联网搜索 + 若干终端命令
    const blocks = [
      textBlock('我先查一下下载方式。'),
      toolCallBlock('tavily_search'),
      toolCallBlock('start_terminal_command', 't1'),
      toolCallBlock('start_terminal_command', 't2'),
      toolCallBlock('glob_workspace'),
      toolCallBlock('read_document_file'),
      textBlock('已下载完成。'),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history.map((item) => item.block.type)).toEqual([
      'text',
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_call',
    ]);
    // 结论文字在最后一个工作过程之后，留在主时间线
    expect(rest.map((item) => item.block.type)).toEqual(['text']);
  });

  it('keeps failed, interrupted and awaiting-approval calls on the main timeline', () => {
    const failed = toolCallBlock('tavily_search', 'failed', {
      status: 'error',
    });
    const interrupted = toolCallBlock('start_terminal_command', 'interrupted', {
      status: 'running',
    });
    const queued = toolCallBlock('read_workspace_file', 'queued', {
      status: 'queued',
    });
    const awaiting = toolCallBlock('start_terminal_command', 'awaiting', {
      awaitingApproval: true,
    });

    const { history, rest } = splitWorkHistory([
      toolCallBlock('grep_workspace'),
      failed,
      interrupted,
      queued,
      awaiting,
    ]);
    expect(history.map((item) => item.block.type)).toEqual(['tool_call']);
    expect(rest).toHaveLength(4);
    expect(rest.map((item) => item.block.type)).toEqual([
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_call',
    ]);
  });

  it('never folds explore_readonly (subagent entry point)', () => {
    const { history, rest } = splitWorkHistory([
      toolCallBlock('explore_readonly'),
      textBlock('查完了'),
    ]);
    expect(history).toHaveLength(0);
    expect(rest.map((item) => item.block.type)).toEqual(['tool_call', 'text']);
  });
});

describe('工具名清单约束（shared/agentToolKinds）', () => {
  it('写文件与标注工具行按结算状态折叠，不再按名字永久排除', () => {
    for (const name of [
      ...PROPOSAL_TOOL_NAMES,
      ...CLIENT_PIPELINE_TOOL_NAMES,
    ]) {
      expect(NEVER_FOLD_TOOL_NAMES.has(name)).toBe(false);
      expect(isFoldableToolName(name)).toBe(true);
    }
  });

  it('终端命令与 MCP 工具可折叠（批准条只在实时消息里出现），explore_readonly 永不折叠', () => {
    expect(isFoldableToolName('start_terminal_command')).toBe(true);
    expect(isFoldableToolName('run_agent_skill_script')).toBe(true);
    expect(isFoldableToolName('tavily_search')).toBe(true);
    expect(isFoldableToolName('read_agent_skill')).toBe(true);
    expect(isFoldableToolName('explore_readonly')).toBe(false);
  });
});

describe('formatWorkedDuration', () => {
  it('uses at least one second', () => {
    expect(formatWorkedDuration(120)).toBe('Worked for 1s');
  });

  it('formats seconds under a minute', () => {
    expect(formatWorkedDuration(12_400)).toBe('Worked for 12s');
  });

  it('formats minutes and leftover seconds', () => {
    expect(formatWorkedDuration(72_000)).toBe('Worked for 1m 12s');
  });

  it('omits zero leftover seconds', () => {
    expect(formatWorkedDuration(120_000)).toBe('Worked for 2m');
  });
});

describe('workHistoryDurationMs', () => {
  it('prefers finishedAt over now', () => {
    expect(workHistoryDurationMs(1000, 3500, 9999)).toBe(2500);
  });
});

describe('formatThoughtLabel', () => {
  it('uses Thinking while streaming', () => {
    expect(formatThoughtLabel(12_000, { streaming: true })).toBe('Thinking…');
  });

  it('uses Thought briefly when tools ran', () => {
    expect(formatThoughtLabel(12_000, { hasToolCall: true })).toBe(
      'Thought briefly',
    );
  });

  it('uses Thought briefly under two seconds', () => {
    expect(formatThoughtLabel(800)).toBe('Thought briefly');
  });

  it('uses Thought for when only thinking took longer', () => {
    expect(formatThoughtLabel(8000)).toBe('Thought for 8s');
  });
});

describe('collectThoughtContent', () => {
  it('joins multiple reasoning blocks', () => {
    expect(
      collectThoughtContent([
        reasoningBlock('第一轮'),
        toolCallBlock('grep_workspace'),
        reasoningBlock('第二轮'),
      ]),
    ).toBe('第一轮\n\n第二轮');
  });
});
