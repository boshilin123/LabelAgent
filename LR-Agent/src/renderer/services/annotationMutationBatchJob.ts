import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../shared/annotationAgentTypes';
import type { StreamEvent } from '../../shared/agentTypes';
import { ANNOTATION_BATCH_MAX_FILES } from '../../shared/annotationAgentTypes';
import {
  runAnnotationMutationJob,
  type MutationProgressEvent,
} from './annotationAgent/mutationOrchestrator';
import { getRelativeProjectPath } from '../utils/projectPaths';
import { resolveAnnotationScopePaths } from './annotationAgent/scopePathUtil';
import {
  buildProposalFileStats,
  type AnnotationProposalFileStat,
} from './annotationProposalStats';

export type AnnotationMutationJobResult = {
  status: 'completed' | 'skipped' | 'error';
  summary: string;
  hasProposal: boolean;
  /** 提案逐文件明细（路径/增删改/标签），供工具结果携带真实数字 */
  fileStats?: AnnotationProposalFileStat[];
};

export async function startAnnotationMutationJob(options: {
  jobId: string;
  providerId: string;
  userRequest: string;
  sessionId?: string;
  conversationTranscript?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
  onEvent: (event: StreamEvent) => void;
  onPersistEvent?: (event: StreamEvent) => void;
  signal: AbortSignal;
  paths?: string[];
  annotationIds?: string[];
  pendingAnnotationChanges?: AnnotationBatchChange[];
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
}): Promise<AnnotationMutationJobResult> {
  const emit = (event: StreamEvent): void => {
    options.onEvent(event);
    options.onPersistEvent?.(event);
  };
  const isCancelled = () => options.signal.aborted;
  const outcome: AnnotationMutationJobResult = {
    status: 'completed',
    summary: '标注变更流水线已完成。',
    hasProposal: false,
  };

  try {
    const currentRel =
      options.currentFileAbsolutePath &&
      getRelativeProjectPath(
        options.project.directoryPath,
        options.currentFileAbsolutePath,
      );

    const textTypes = new Set([
      'span_ner',
      'text_classification',
      'instruction',
      'preference',
      'conversation',
      'cot',
    ]);
    const listCatalog = textTypes.has(options.project.annotationType)
      ? window.electron?.annotationAgent?.listTextFiles
      : window.electron?.annotationAgent?.listImages;
    const catalog = await listCatalog?.(
      options.project.directoryPath,
      ANNOTATION_BATCH_MAX_FILES * 4,
    );
    const candidates = (catalog ?? []).map((c) => ({
      relativePath: c.relativePath,
      name: c.name,
      parent: c.parent,
      absolutePath: c.absolutePath,
      index: c.index,
    }));
    if (
      currentRel &&
      options.currentFileAbsolutePath &&
      !candidates.some((c) => c.relativePath === currentRel)
    ) {
      const parts = currentRel.split('/');
      candidates.push({
        relativePath: currentRel,
        name: parts[parts.length - 1] || currentRel,
        parent: parts.slice(0, -1).join('/'),
        absolutePath: options.currentFileAbsolutePath,
        index: candidates.length,
      });
    }

    const requestedPaths = (options.paths ?? [])
      .map((p) => p.trim())
      .filter(Boolean);
    if (requestedPaths.length > 0) {
      const scoped = await resolveAnnotationScopePaths(
        candidates.map((c) => ({
          relativePath: c.relativePath,
          absolutePath: c.absolutePath,
        })),
        { paths: requestedPaths },
        ANNOTATION_BATCH_MAX_FILES * 4,
        async (relativePath) =>
          window.electron?.annotationAgent?.resolveRelativeFile?.(
            options.project.directoryPath,
            relativePath,
          ) ?? null,
      );
      if (scoped.error) {
        emitPipelineError(scoped.error, emit);
        return {
          status: 'error',
          summary: scoped.error,
          hasProposal: false,
        };
      }
      const allowed = new Set(scoped.paths.map((p) => p.relativePath));
      const filtered = candidates.filter((c) => allowed.has(c.relativePath));
      const seen = new Set(filtered.map((c) => c.relativePath));
      for (const extra of scoped.paths) {
        if (seen.has(extra.relativePath)) continue;
        const parts = extra.relativePath.split('/');
        filtered.push({
          relativePath: extra.relativePath,
          name: parts[parts.length - 1] || extra.relativePath,
          parent: parts.slice(0, -1).join('/'),
          absolutePath: extra.absolutePath,
          index: filtered.length,
        });
        seen.add(extra.relativePath);
      }
      candidates.length = 0;
      candidates.push(...filtered);
    }

    for await (const event of runAnnotationMutationJob({
      providerId: options.providerId,
      userRequest: options.userRequest,
      sessionId: options.sessionId,
      conversationTranscript: options.conversationTranscript,
      project: options.project,
      currentFileAbsolutePath: options.currentFileAbsolutePath,
      candidates,
      currentRelativePath: currentRel ?? '',
      selectedAnnotationIds: options.annotationIds,
      pendingAnnotationChanges: options.pendingAnnotationChanges,
      providerApiKey: options.providerApiKey ?? '',
      providerBaseUrl: options.providerBaseUrl ?? '',
      providerModel: options.providerModel ?? '',
      isCancelled,
    })) {
      if (isCancelled()) break;
      mapAndEmit(event, emit);
      if (event.type === 'proposal') {
        outcome.hasProposal = true;
        outcome.status = 'completed';
        outcome.summary =
          event.proposal.summary?.trim() || '已生成标注变更提案。';
        outcome.fileStats = buildProposalFileStats(
          event.proposal.changes,
          options.project?.labels,
        );
      }
      if (event.type === 'text' && !outcome.hasProposal) {
        outcome.status = 'skipped';
        outcome.summary =
          event.content.trim() || '未能识别要修改或删除的标注。';
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
    outcome.summary = err instanceof Error ? err.message : '标注变更失败';
    emitPipelineError(outcome.summary, emit);
  }

  if (outcome.status === 'completed' && !outcome.hasProposal) {
    outcome.status = 'skipped';
    if (outcome.summary === '标注变更流水线已完成。') {
      outcome.summary = '标注变更未产生提案。';
    }
  }

  return outcome;
}

function mapAndEmit(
  event: MutationProgressEvent,
  onEvent: (event: StreamEvent) => void,
): void {
  if (event.type === 'progress') {
    onEvent({
      type: 'annotation_progress',
      stage: event.stage,
      message: event.message,
      status: event.status,
      detail: event.detail,
      pipelineKind: 'mutation',
    });
    return;
  }
  if (event.type === 'proposal') {
    const summary = event.proposal.summary?.trim();
    if (summary) {
      onEvent({ type: 'text_delta', content: `${summary}\n` });
    }
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
    pipelineKind: 'mutation',
  });
}
