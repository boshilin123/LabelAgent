import type { MessageBlock, PipelineKind } from '../../../shared/agentTypes';
import { isFileProposalBlock } from '../../../shared/agentTypes';

export const PIPELINE_TITLES: Record<
  PipelineKind,
  { active: string; failed: string; idle: string }
> = {
  batch: {
    active: '批量标注进行中…',
    failed: '批量标注未完成',
    idle: '批量标注步骤',
  },
  mutation: {
    active: '标注变更进行中…',
    failed: '标注变更未完成',
    idle: '标注变更步骤',
  },
  report: {
    active: '报告生成进行中…',
    failed: '报告生成未完成',
    idle: '报告生成步骤',
  },
};

/** 根据消息块推断 pipelineKind（兼容历史数据缺字段）。 */
export function inferPipelineKindFromBlocks(
  blocks: MessageBlock[],
): PipelineKind {
  if (blocks.some(isFileProposalBlock)) {
    return 'report';
  }

  const proposal = blocks.find((b) => b.type === 'annotation_proposal');
  if (proposal?.type === 'annotation_proposal') {
    const changes = proposal.proposal.changes ?? [];
    if (
      changes.length > 0 &&
      changes.every((c) => c.operation === 'patch' || c.operation === 'delete')
    ) {
      return 'mutation';
    }
  }

  for (const block of blocks) {
    if (block.type !== 'annotation_pipeline') continue;
    if (block.pipelineKind && block.pipelineKind !== 'batch') {
      return block.pipelineKind;
    }
    const stages = new Set(block.steps.map((s) => s.stage));
    if (stages.has('resolve') && !stages.has('workers')) return 'mutation';
    if (
      stages.has('collect') &&
      !stages.has('workers') &&
      !stages.has('execute')
    ) {
      return 'report';
    }
  }

  return 'batch';
}

export function normalizePipelineKindsInBlocks(
  blocks: MessageBlock[],
): MessageBlock[] {
  const inferred = inferPipelineKindFromBlocks(blocks);
  if (inferred === 'batch') {
    return blocks;
  }
  return blocks.map((block) => {
    if (block.type !== 'annotation_pipeline') return block;
    if (block.pipelineKind && block.pipelineKind !== 'batch') return block;
    return { ...block, pipelineKind: inferred };
  });
}
