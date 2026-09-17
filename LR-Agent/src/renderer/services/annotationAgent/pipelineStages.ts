import type { PipelineKind } from '../../../shared/agentTypes';

export const MUTATION_PIPELINE_STAGE_LABELS: Record<string, string> = {
  prepare: '解析意图',
  resolve: '定位目标',
};

export const REPORT_PIPELINE_STAGE_LABELS: Record<string, string> = {
  collect: '收集数据',
  prepare: '生成报告',
};

/** 批量标注流水线 UI 阶段（精简后） */
export const PIPELINE_STAGE_LABELS: Record<string, string> = {
  prepare: '准备',
  workers: '批量处理',
  worker: '处理图片',
  detect: '目标检测',
  map: '标签映射',
  finalize: '生成提案',
  judge: '评分复核',
  retry: '重新打标签',
  tool: '工具调用',
};

const STAGE_LABELS_BY_KIND: Record<PipelineKind, Record<string, string>> = {
  batch: PIPELINE_STAGE_LABELS,
  mutation: MUTATION_PIPELINE_STAGE_LABELS,
  report: REPORT_PIPELINE_STAGE_LABELS,
};

export function labelForPipelineStage(
  stage: string,
  pipelineKind: PipelineKind = 'batch',
): string {
  const table = STAGE_LABELS_BY_KIND[pipelineKind] ?? PIPELINE_STAGE_LABELS;
  return table[stage] ?? stage;
}
