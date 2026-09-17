import { isFileProposalBlock } from '../../../shared/agentTypes';
import { isFoldableToolName } from '../../../shared/agentToolKinds';
import type { MessageBlock } from '../../types/agent';

export interface IndexedBlock {
  block: MessageBlock;
  index: number;
}

export type ToolCallBlock = Extract<MessageBlock, { type: 'tool_call' }>;

/**
 * 是否属于可折叠的「工作过程」工具行。
 *
 * 判定分两步：名字不是永久保留项（排除式，见 shared/agentToolKinds），
 * 且调用已正常结束——出错、被中断（消息结束时仍 queued/running）、等待用户批准的
 * 调用一律留在主时间线，便于诊断与回溯。
 */
export function isWorkProcessBlock(block: MessageBlock): boolean {
  if (block.type !== 'tool_call') return false;
  if (block.status !== 'done' || block.awaitingApproval) return false;
  return isFoldableToolName(block.name);
}

/**
 * 交付物卡片（文件提案 / 标注提案 / 标注流水线）是否已结算。
 *
 * 结算后折进 Worked for：确认过的编辑、标注详情不再占用主时间线。
 * 未结算的一律留在主时间线——待确认提案卡是审阅与确认的入口
 * （Keep All / Undo、AgentKeepAllBar 的 openChangeItem 都指向它）；
 * 流水线里出现 error 步骤时同样保留，便于诊断失败。
 */
export function isSettledDeliverableBlock(block: MessageBlock): boolean {
  if (isFileProposalBlock(block)) return block.status !== 'pending';
  if (block.type === 'annotation_proposal') return block.status !== 'pending';
  if (block.type === 'annotation_pipeline') {
    return block.steps.every(
      (step) => step.status === 'done' || step.status === 'skipped',
    );
  }
  return false;
}

/** 可折进 Worked for 的块：工作过程工具行，或已结算的交付物卡片 */
function isFoldableWorkBlock(block: MessageBlock): boolean {
  return isWorkProcessBlock(block) || isSettledDeliverableBlock(block);
}

export function collectThoughtContent(blocks: MessageBlock[]): string {
  return blocks
    .filter(
      (block): block is Extract<MessageBlock, { type: 'reasoning' }> =>
        block.type === 'reasoning' && Boolean(block.content.trim()),
    )
    .map((block) => block.content.trim())
    .join('\n\n');
}

/** 已结算的工作过程与交付物折进 Worked for；待确认提案与结论文字留在主时间线。 */
export function splitWorkHistory(blocks: MessageBlock[]): {
  history: IndexedBlock[];
  rest: IndexedBlock[];
} {
  let lastExplorationIdx = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (isFoldableWorkBlock(blocks[i])) {
      lastExplorationIdx = i;
    }
  }

  if (lastExplorationIdx < 0) {
    return {
      history: [],
      rest: blocks
        .map((block, index) => ({ block, index }))
        .filter((item) => item.block.type !== 'reasoning'),
    };
  }

  const history: IndexedBlock[] = [];
  const rest: IndexedBlock[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.type === 'reasoning') {
      continue;
    }
    const inExplorationPrefix = i <= lastExplorationIdx;
    if (
      inExplorationPrefix &&
      (isFoldableWorkBlock(block) || block.type === 'text')
    ) {
      history.push({ block, index: i });
      continue;
    }
    rest.push({ block, index: i });
  }
  return { history, rest };
}

function formatClockDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function formatWorkedDuration(durationMs: number): string {
  return `Worked for ${formatClockDuration(durationMs)}`;
}

export function formatThoughtLabel(
  durationMs: number,
  options: { streaming?: boolean; hasToolCall?: boolean } = {},
): string {
  if (options.streaming) {
    return 'Thinking…';
  }
  if (options.hasToolCall || durationMs < 2000) {
    return 'Thought briefly';
  }
  return `Thought for ${formatClockDuration(durationMs)}`;
}

export function workHistoryDurationMs(
  createdAt: number,
  finishedAt: number | undefined,
  now = Date.now(),
): number {
  return Math.max(0, (finishedAt ?? now) - createdAt);
}
