import { createAgentId } from '../../../shared/agentTypes';
import type {
  AnnotationPipelineStep,
  LlmProviderConfig,
  StreamEvent,
} from '../../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import type { AnnotationProject } from '../../types/annotation';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { upsertPipelineSteps } from '../annotationAgent/pipelineStepAccumulator';
import { buildAnnotationProjectSnapshot } from '../buildProjectSnapshot';
import { startAnnotationBatchJob } from '../annotationBatchJob';
import { buildQuickInferencePrompt } from './quickInferencePrompts';

export type QuickInferenceJobResult =
  | {
      ok: true;
      proposal: AnnotationBatchProposal;
      pipelineSteps: AnnotationPipelineStep[];
      summaryText: string;
    }
  | { ok: false; error: string; cancelled?: boolean };

export async function runQuickInferenceJob(options: {
  provider: LlmProviderConfig;
  project: AnnotationProject;
  detectionModels: PretrainedModelConfig[];
  currentFileAbsolutePath: string;
  scopeHint: string;
  onProgress?: (message: string) => void;
  onPipelineUpdate?: (steps: AnnotationPipelineStep[]) => void;
  onSummaryUpdate?: (summaryText: string) => void;
  signal: AbortSignal;
}): Promise<QuickInferenceJobResult> {
  let proposal: AnnotationBatchProposal | null = null;
  let errorMessage: string | null = null;
  let pipelineSteps: AnnotationPipelineStep[] = [];
  let summaryText = '';

  const onEvent = (event: StreamEvent): void => {
    if (event.type === 'annotation_progress') {
      pipelineSteps = upsertPipelineSteps(pipelineSteps, event, 'batch');
      options.onPipelineUpdate?.(pipelineSteps);
      options.onProgress?.(event.message);
      return;
    }
    if (event.type === 'annotation_proposal') {
      proposal = event.proposal;
      // 与对话链路（applyStreamEventToBlocks）保持一致：提案已生成即流水线结束。
      // 几何管线在发出 workers/infer 的 running 后不会再发终结性的 main stage，
      // 若不在此刻收尾，面板会一直显示「批量标注进行中…」。
      pipelineSteps = pipelineSteps.map((step) =>
        step.status === 'running' || step.status === 'pending'
          ? { ...step, status: 'done' as const }
          : step,
      );
      options.onPipelineUpdate?.(pipelineSteps);
      return;
    }
    if (event.type === 'error') {
      errorMessage = event.message;
      return;
    }
    if (event.type === 'text_delta' && event.content) {
      summaryText += event.content;
      options.onSummaryUpdate?.(summaryText);
    }
  };

  const userRequest = buildQuickInferencePrompt(
    options.project.annotationType,
    options.project,
  );

  const result = await startAnnotationBatchJob({
    jobId: createAgentId(),
    providerId: options.provider.id,
    userRequest,
    preselectedPaths: [],
    project: buildAnnotationProjectSnapshot(
      options.project,
      options.detectionModels,
    ),
    currentFileAbsolutePath: options.currentFileAbsolutePath,
    detectionModels: options.detectionModels,
    onEvent,
    signal: options.signal,
    providerApiKey: options.provider.apiKey,
    providerBaseUrl: options.provider.baseUrl,
    providerModel: options.provider.model,
    providerSupportsVision: options.provider.supportsVision,
    scopeHint: options.scopeHint,
  });

  if (options.signal.aborted) {
    return { ok: false, error: '已取消', cancelled: true };
  }

  if (errorMessage) {
    return { ok: false, error: errorMessage };
  }

  if (proposal) {
    return {
      ok: true,
      proposal,
      pipelineSteps,
      summaryText: summaryText.trim(),
    };
  }

  if (result.status === 'error') {
    return { ok: false, error: result.summary || '快捷推理失败' };
  }

  return {
    ok: false,
    error: result.summary || '未生成标注提案，请检查文件与模型配置',
  };
}
