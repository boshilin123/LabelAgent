import type { AnnotationPipelineStep } from '../../../shared/agentTypes';

export const PIPELINE_RUNNING_DETAIL_TAIL = 5;

const IMAGE_DETAIL_STAGES = new Set(['worker', 'judge', 'retry']);

export function isImageDetailPipelineStage(stage: string): boolean {
  return IMAGE_DETAIL_STAGES.has(stage);
}

/** 从 worker/judge/retry 进度文案中解析相对路径（兼容历史数据）。 */
export function extractImagePathFromWorkerMessage(
  message: string,
): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const colonIdx = trimmed.indexOf('：');
  if (colonIdx < 0) return null;

  const path = trimmed.slice(colonIdx + 1).trim();
  return path || null;
}

export function resolvePipelineImagePath(
  step: Pick<AnnotationPipelineStep, 'imagePath' | 'message'>,
): string | null {
  if (step.imagePath?.trim()) return step.imagePath.trim();
  return extractImagePathFromWorkerMessage(step.message);
}

export function basenameForPipelineImage(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

export function workerStepDisplayLabel(step: AnnotationPipelineStep): string {
  const path = resolvePipelineImagePath(step);
  if (path) return basenameForPipelineImage(path);
  return step.label;
}

export function workerStepDisplayMessage(step: AnnotationPipelineStep): string {
  if (step.status === 'done') {
    return step.detail?.trim() || '完成';
  }
  if (step.status === 'error' || step.status === 'skipped') {
    return (
      step.detail?.trim() ||
      step.message.replace(/^跳过：/, '').trim() ||
      '跳过'
    );
  }
  if (step.status === 'running') {
    if (step.message.startsWith('处理中')) return '处理中…';
    if (step.message.startsWith('评分')) return step.message;
    if (step.message.startsWith('重新打标签')) return step.message;
    return step.message;
  }
  return step.message;
}

function trimRunningDetailTail(
  steps: AnnotationPipelineStep[],
): AnnotationPipelineStep[] {
  const main = steps.filter((s) => !isImageDetailPipelineStage(s.stage));
  const details = steps.filter((s) => isImageDetailPipelineStage(s.stage));
  const terminal = details.filter((s) => s.status !== 'running');
  const running = details.filter((s) => s.status === 'running');
  const trimmedRunning = running.slice(-PIPELINE_RUNNING_DETAIL_TAIL);
  return [...main, ...terminal, ...trimmedRunning];
}

export function upsertImageDetailPipelineStep(
  steps: AnnotationPipelineStep[],
  incoming: AnnotationPipelineStep,
): AnnotationPipelineStep[] {
  const imagePath = resolvePipelineImagePath(incoming);
  const withPath: AnnotationPipelineStep = {
    ...incoming,
    imagePath: imagePath ?? incoming.imagePath,
  };

  const main = steps.filter((s) => !isImageDetailPipelineStage(s.stage));
  const details = steps.filter((s) => isImageDetailPipelineStage(s.stage));

  let nextDetails: AnnotationPipelineStep[];
  if (imagePath) {
    const idx = details.findIndex(
      (s) => resolvePipelineImagePath(s) === imagePath,
    );
    if (idx >= 0) {
      nextDetails = [...details];
      nextDetails[idx] = withPath;
    } else {
      nextDetails = [...details, withPath];
    }
  } else {
    const idx = details.findIndex(
      (s) => s.stage === incoming.stage && s.message === incoming.message,
    );
    if (idx >= 0) {
      nextDetails = [...details];
      nextDetails[idx] = withPath;
    } else {
      nextDetails = [...details, withPath];
    }
  }

  return trimRunningDetailTail([...main, ...nextDetails]);
}
