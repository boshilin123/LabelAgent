import type {
  AnnotationProjectSnapshot,
  DetectionOverrides,
} from '../../shared/annotationAgentTypes';
import { ANNOTATION_BATCH_MAX_FILES } from '../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import type { StreamEvent } from '../../shared/agentTypes';
import {
  runAnnotationBatchJob,
  type AnnotationProgressEvent,
} from './annotationAgent/batchOrchestrator';
import {
  buildProposalFileStats,
  type AnnotationProposalFileStat,
} from './annotationProposalStats';

export type AnnotationBatchJobResult = {
  status: 'completed' | 'skipped' | 'error';
  summary: string;
  processedImages: number;
  hasProposal: boolean;
  /** 提案逐文件明细（路径/增删/标签），供工具结果携带真实数字 */
  fileStats?: AnnotationProposalFileStat[];
  omittedCount?: number;
  omittedPaths?: string[];
};

export async function startAnnotationBatchJob(options: {
  jobId: string;
  providerId: string;
  userRequest: string;
  preselectedPaths?: string[];
  sessionId?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
  detectionModels: PretrainedModelConfig[];
  onEvent: (event: StreamEvent) => void;
  onPersistEvent?: (event: StreamEvent) => void;
  signal: AbortSignal;
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerSupportsVision?: boolean;
  scopeHint?: string;
  scopePaths?: string[];
  allFiles?: boolean;
  writeMode?: 'append' | 'replace_matching';
  /** auto_annotate 透传的检测约束（仅几何管线消费） */
  detectionOverrides?: DetectionOverrides;
}): Promise<AnnotationBatchJobResult> {
  const emit = (event: StreamEvent): void => {
    options.onEvent(event);
    options.onPersistEvent?.(event);
  };
  const isCancelled = () => options.signal.aborted;

  const outcome: AnnotationBatchJobResult = {
    status: 'completed',
    summary: '批量标注流水线已完成。',
    processedImages: 0,
    hasProposal: false,
  };
  // 是否已经产生过 progress（决定是否存在 pipeline 卡，避免 skipped 时凭空建卡）
  let sawProgress = false;

  try {
    for await (const event of runAnnotationBatchJob({
      providerId: options.providerId,
      userRequest: options.userRequest,
      preselectedPaths: options.preselectedPaths,
      sessionId: options.sessionId,
      project: options.project,
      currentFileAbsolutePath: options.currentFileAbsolutePath,
      detectionModels: options.detectionModels,
      isCancelled,
      abortSignal: options.signal,
      providerApiKey: options.providerApiKey ?? '',
      providerBaseUrl: options.providerBaseUrl ?? '',
      providerModel: options.providerModel ?? '',
      providerSupportsVision: options.providerSupportsVision ?? false,
      scopeHint: options.scopeHint,
      scopePaths: options.scopePaths,
      allFiles: options.allFiles,
      writeMode: options.writeMode,
      detectionOverrides: options.detectionOverrides,
    })) {
      if (isCancelled()) break;
      if (event.type === 'progress') sawProgress = true;
      mapAndEmit(event, emit);
      if (event.type === 'scope_truncated') {
        outcome.omittedCount = event.omittedCount;
        outcome.omittedPaths = event.omittedPaths;
      }
      if (event.type === 'proposal') {
        outcome.hasProposal = true;
        // 收到有效提案即视为完成；text 事件先于 proposal 到达时曾把 status 置为 skipped，必须恢复
        outcome.status = 'completed';
        outcome.processedImages = event.proposal.stats.processed;
        outcome.fileStats = buildProposalFileStats(
          event.proposal.changes,
          options.project?.labels,
        );
        const { stats } = event.proposal;
        outcome.summary = stats.cancelled
          ? `标注已取消，已保存 ${stats.succeeded} 张的部分结果。`
          : `批量标注完成：处理 ${stats.processed} 张${
              'totalBoxes' in stats
                ? `，共 ${(stats as { totalBoxes: number }).totalBoxes} 个框`
                : 'totalInstances' in stats
                  ? `，共 ${(stats as { totalInstances: number }).totalInstances} 个实例`
                  : ''
            }。`;
      }
      if (event.type === 'text' && !outcome.hasProposal) {
        outcome.status = 'skipped';
        outcome.summary =
          event.content.trim() ||
          '未识别为批量标注请求；请改用 write_workspace_file 写文件，或更具体地描述需要标注的图片范围。';
      }
      if (event.type === 'error') {
        outcome.status = 'error';
        outcome.summary = event.message;
        break;
      }
    }
  } catch (err) {
    if (options.signal.aborted) return outcome;
    outcome.status = 'error';
    outcome.summary = err instanceof Error ? err.message : '批量标注失败';
    emitPipelineError(outcome.summary, emit);
  }

  if (outcome.status === 'completed' && !outcome.hasProposal) {
    outcome.status = 'skipped';
    if (outcome.summary === '批量标注流水线已完成。') {
      outcome.summary =
        '批量标注未产生提案（可能未选定图片或任务与标注无关）。';
    }
  }

  if (outcome.status === 'skipped' && sawProgress) {
    // 未产出任何标注：把一开始的 prepare 步骤落为 skipped。
    // 否则消息结束时会被自动收尾成「已完成」，看起来像凭空生成的假步骤。
    emit({
      type: 'annotation_progress',
      stage: 'prepare',
      message: outcome.summary,
      status: 'skipped',
    });
  }

  return outcome;
}

function mapAndEmit(
  event: AnnotationProgressEvent,
  onEvent: (event: StreamEvent) => void,
): void {
  if (event.type === 'progress') {
    onEvent({
      type: 'annotation_progress',
      stage: event.stage,
      message: event.message,
      status: event.status,
      detail: event.detail,
      imagePath: event.imagePath,
    });
    return;
  }
  if (event.type === 'tool') {
    if (event.status !== 'done' || !event.result) {
      return;
    }
    onEvent({
      type: 'tool_start',
      toolCallId: event.toolCallId,
      name: event.name,
      arguments: event.arguments,
    });
    onEvent({
      type: 'tool_result',
      toolCallId: event.toolCallId,
      result: event.result,
    });
    return;
  }
  if (event.type === 'proposal') {
    onEvent({ type: 'annotation_proposal', proposal: event.proposal });
    return;
  }
  if (event.type === 'text') {
    onEvent({ type: 'text_delta', content: event.content });
    return;
  }
  if (event.type === 'error') {
    emitPipelineError(event.message, onEvent);
  }
  if (event.type === 'scope_truncated') {
    onEvent({
      type: 'annotation_progress',
      stage: 'prepare',
      message: `单次上限 ${ANNOTATION_BATCH_MAX_FILES}，另有 ${event.omittedCount} 张未纳入`,
      status: 'running',
      detail: event.omittedPaths.join(', '),
    });
  }
}

function emitPipelineError(
  message: string,
  onEvent: (event: StreamEvent) => void,
): void {
  onEvent({
    type: 'annotation_progress',
    stage: 'prepare',
    message,
    status: 'error',
  });
}
