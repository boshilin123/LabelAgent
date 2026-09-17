import type {
  AnnotationPipelineStep,
  PipelineKind,
  StreamEvent,
} from '../../../shared/agentTypes';
import {
  isImageDetailPipelineStage,
  upsertImageDetailPipelineStep,
} from './pipelineImageSteps';
import { labelForPipelineStage } from './pipelineStages';

export type AnnotationProgressStreamEvent = Extract<
  StreamEvent,
  { type: 'annotation_progress' }
>;

export function buildPipelineStepFromProgressEvent(
  event: AnnotationProgressStreamEvent,
  pipelineKind: PipelineKind = 'batch',
): AnnotationPipelineStep {
  return {
    stage: event.stage,
    label: labelForPipelineStage(event.stage, pipelineKind),
    message: event.message,
    status: event.status ?? 'running',
    detail: event.detail,
    imagePath: event.imagePath,
  };
}

export function upsertPipelineSteps(
  steps: AnnotationPipelineStep[],
  event: AnnotationProgressStreamEvent,
  pipelineKind: PipelineKind = 'batch',
): AnnotationPipelineStep[] {
  const incoming = buildPipelineStepFromProgressEvent(event, pipelineKind);
  const pipelineFailed =
    event.status === 'error' && !isImageDetailPipelineStage(event.stage);
  const updated = steps.map((step) =>
    step.status === 'running' &&
    (pipelineFailed ||
      (step.stage !== event.stage && !isImageDetailPipelineStage(event.stage)))
      ? {
          ...step,
          status: pipelineFailed ? ('error' as const) : ('done' as const),
        }
      : step,
  );

  if (isImageDetailPipelineStage(event.stage)) {
    return upsertImageDetailPipelineStep(updated, incoming);
  }

  const idx = updated.findIndex((step) => step.stage === event.stage);
  if (idx >= 0) {
    updated[idx] = incoming;
    return updated;
  }

  return [...updated, incoming];
}
