import { createAgentId } from '../../../shared/agentTypes';
import type {
  AnnotationBatchChange,
  AnnotationBatchProposal,
  AnnotationProjectSnapshot,
  DetectionOverrides,
  GenericProposalStats,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import { ANNOTATION_BATCH_MAX_FILES } from '../../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { getRelativeProjectPath } from '../../utils/projectPaths';
import type { AnnotationInstance } from '../../types/annotationDocument';
import {
  resolveAnnotationScopePaths,
  type AnnotationScopeResult,
  type InputPathEntry,
} from './scopePathUtil';
import {
  attachRewriteDeletes,
  inferAnnotationWritePolicy,
} from './annotationWritePolicy';
import { runGeometryPipeline } from './geometryBatchPipeline';
import {
  isGeometryAnnotationType,
  type GeometryAnnotationType,
} from './geometryTypes';

export type AnnotationProgressEvent =
  | {
      type: 'progress';
      stage: string;
      message: string;
      status?: 'running' | 'done' | 'error';
      detail?: string;
      imagePath?: string;
    }
  | {
      type: 'tool';
      toolCallId: string;
      name: string;
      arguments: string;
      status: 'running' | 'done';
      result?: string;
    }
  | { type: 'proposal'; proposal: AnnotationBatchProposal }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string }
  | {
      type: 'scope_truncated';
      omittedCount: number;
      omittedPaths: string[];
    };

function progress(
  stage: string,
  message: string,
  status: 'running' | 'done' | 'error' = 'running',
  detail?: string,
  imagePath?: string,
): AnnotationProgressEvent {
  return { type: 'progress', stage, message, status, detail, imagePath };
}

export async function* runAnnotationBatchJob(options: {
  providerId: string;
  userRequest: string;
  preselectedPaths?: string[];
  sessionId?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
  detectionModels: PretrainedModelConfig[];
  isCancelled?: () => boolean;
  abortSignal?: AbortSignal;
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
}): AsyncGenerator<AnnotationProgressEvent> {
  const { project } = options;
  const isCancelled = () =>
    options.isCancelled?.() === true || options.abortSignal?.aborted === true;

  const { annotationType } = project;

  if (isGeometryAnnotationType(annotationType)) {
    yield* runGeometryPipeline(
      options,
      isCancelled,
      annotationType as GeometryAnnotationType,
    );
    return;
  }

  if (SUPPORTED_GENERATE_TYPES.has(annotationType)) {
    yield* runGeneratePipeline(
      options,
      isCancelled,
      annotationType as GenerateType,
    );
    return;
  }

  yield {
    type: 'error',
    message: `当前标注类型 "${project.annotationType}" 暂不支持 Agent 自动标注。`,
  };
}

const SUPPORTED_GENERATE_TYPES: Set<string> = new Set([
  'caption',
  'classification',
  'instruction',
  'cot',
  'conversation',
  'preference',
  'text_classification',
  'span_ner',
]);

type GenerateType =
  | 'caption'
  | 'classification'
  | 'instruction'
  | 'cot'
  | 'conversation'
  | 'preference'
  | 'text_classification'
  | 'span_ner';

const TEXT_SOURCE_ANNOTATION_TYPES: Set<string> = new Set([
  'instruction',
  'cot',
  'conversation',
  'preference',
  'text_classification',
  'span_ner',
]);

async function resolveScopePathsForProject(
  allPaths: InputPathEntry[],
  options: {
    scopeHint?: string;
    scopePaths?: string[];
    allFiles?: boolean;
    preselectedPaths?: string[];
  },
  projectDir: string,
): Promise<AnnotationScopeResult> {
  const preselected = (options.preselectedPaths ?? []).filter(Boolean);
  return resolveAnnotationScopePaths(
    allPaths,
    {
      paths:
        options.scopePaths && options.scopePaths.length > 0
          ? options.scopePaths
          : preselected.length > 0
            ? preselected
            : undefined,
      allFiles: options.allFiles,
      scopeHint: options.scopeHint,
    },
    ANNOTATION_BATCH_MAX_FILES,
    async (relativePath) =>
      window.electron?.annotationAgent?.resolveRelativeFile?.(
        projectDir,
        relativePath,
      ) ?? null,
  );
}

async function* runGeneratePipeline(
  options: {
    providerId: string;
    userRequest: string;
    sessionId?: string;
    project: AnnotationProjectSnapshot;
    currentFileAbsolutePath: string | null;
    providerApiKey?: string;
    providerBaseUrl?: string;
    providerModel?: string;
    providerSupportsVision?: boolean;
    abortSignal?: AbortSignal;
    scopeHint?: string;
    scopePaths?: string[];
    allFiles?: boolean;
    writeMode?: 'append' | 'replace_matching';
    preselectedPaths?: string[];
  },
  isCancelled: () => boolean,
  annotationType: GenerateType,
): AsyncGenerator<AnnotationProgressEvent> {
  const { project, userRequest } = options;

  const annotationTypeLabel = getAnnotationTypeLabel(annotationType);
  yield progress('prepare', `正在准备${annotationTypeLabel}标注数据生成…`);

  if (isCancelled()) {
    yield progress('prepare', '已取消', 'error');
    return;
  }

  let inputPaths: InputPathEntry[] = [];
  if (project.modality === 'image') {
    inputPaths = await collectImagePaths(
      project,
      options.currentFileAbsolutePath,
    );
  } else if (TEXT_SOURCE_ANNOTATION_TYPES.has(project.annotationType)) {
    inputPaths = await collectTextPaths(
      project,
      options.currentFileAbsolutePath,
    );
  }

  const scoped = await resolveScopePathsForProject(
    inputPaths,
    options,
    project.directoryPath,
  );
  if (scoped.error) {
    yield { type: 'error', message: scoped.error };
    return;
  }
  inputPaths = scoped.paths;
  if (scoped.omittedCount && scoped.omittedCount > 0) {
    yield {
      type: 'scope_truncated',
      omittedCount: scoped.omittedCount,
      omittedPaths: scoped.omittedPaths ?? [],
    };
  }

  if (isCancelled()) return;

  const progressMessages: string[] = [];
  const onGenerateProgress = (msg: string): void => {
    progressMessages.push(msg);
  };

  let genAnnotations: AnnotationInstance[] = [];
  let builtChanges: AnnotationBatchChange[] = [];

  try {
    switch (annotationType) {
      case 'caption': {
        const { runCaptionPipeline } =
          await import('./pipelines/captionPipeline');
        const result = await runCaptionPipeline({
          inputPaths,
          userRequest,
          providerId: options.providerId,
          providerApiKey: options.providerApiKey ?? '',
          providerBaseUrl: options.providerBaseUrl ?? '',
          providerModel: options.providerModel ?? '',
          project,
          isCancelled,
          onProgress: onGenerateProgress,
        });
        genAnnotations = result.annotations;
        builtChanges = result.changes;
        break;
      }
      case 'classification': {
        const { runClassificationPipeline } =
          await import('./pipelines/classificationPipeline');
        const result = await runClassificationPipeline({
          inputPaths,
          userRequest,
          providerId: options.providerId,
          providerApiKey: options.providerApiKey ?? '',
          providerBaseUrl: options.providerBaseUrl ?? '',
          providerModel: options.providerModel ?? '',
          project,
          isCancelled,
          onProgress: onGenerateProgress,
        });
        genAnnotations = result.annotations;
        builtChanges = result.changes;
        break;
      }
      case 'instruction': {
        const { runInstructionPipeline } =
          await import('./pipelines/instructionPipeline');
        const result = await runInstructionPipeline({
          inputPaths,
          userRequest,
          providerId: options.providerId,
          providerApiKey: options.providerApiKey ?? '',
          providerBaseUrl: options.providerBaseUrl ?? '',
          providerModel: options.providerModel ?? '',
          project,
          isCancelled,
          onProgress: onGenerateProgress,
        });
        genAnnotations = result.annotations;
        builtChanges = result.changes;
        break;
      }
      case 'cot': {
        const { runCotPipeline } = await import('./pipelines/cotPipeline');
        const result = await runCotPipeline({
          inputPaths,
          userRequest,
          providerId: options.providerId,
          providerApiKey: options.providerApiKey ?? '',
          providerBaseUrl: options.providerBaseUrl ?? '',
          providerModel: options.providerModel ?? '',
          project,
          isCancelled,
          onProgress: onGenerateProgress,
        });
        genAnnotations = result.annotations;
        builtChanges = result.changes;
        break;
      }
      case 'conversation': {
        const { runConversationPipeline } =
          await import('./pipelines/conversationPipeline');
        const result = await runConversationPipeline({
          inputPaths,
          userRequest,
          count: Math.min(1, ANNOTATION_BATCH_MAX_FILES),
          providerId: options.providerId,
          providerApiKey: options.providerApiKey ?? '',
          providerBaseUrl: options.providerBaseUrl ?? '',
          providerModel: options.providerModel ?? '',
          project,
          isCancelled,
          onProgress: onGenerateProgress,
        });
        genAnnotations = result.annotations;
        builtChanges = result.changes;
        break;
      }
      case 'preference': {
        const { runPreferencePipeline } =
          await import('./pipelines/preferencePipeline');
        const result = await runPreferencePipeline({
          inputPaths,
          userRequest,
          count: Math.min(1, ANNOTATION_BATCH_MAX_FILES),
          providerId: options.providerId,
          providerApiKey: options.providerApiKey ?? '',
          providerBaseUrl: options.providerBaseUrl ?? '',
          providerModel: options.providerModel ?? '',
          project,
          isCancelled,
          onProgress: onGenerateProgress,
        });
        genAnnotations = result.annotations;
        builtChanges = result.changes;
        break;
      }
      case 'text_classification': {
        const { runTextClassificationPipeline } =
          await import('./pipelines/textClassificationPipeline');
        const result = await runTextClassificationPipeline({
          inputPaths,
          userRequest,
          providerId: options.providerId,
          providerApiKey: options.providerApiKey ?? '',
          providerBaseUrl: options.providerBaseUrl ?? '',
          providerModel: options.providerModel ?? '',
          project,
          isCancelled,
          onProgress: onGenerateProgress,
        });
        genAnnotations = result.annotations;
        builtChanges = result.changes;
        break;
      }
      case 'span_ner': {
        const { runSpanNerPipeline } =
          await import('./pipelines/spanNerPipeline');
        const result = await runSpanNerPipeline({
          inputPaths,
          userRequest,
          providerId: options.providerId,
          providerApiKey: options.providerApiKey ?? '',
          providerBaseUrl: options.providerBaseUrl ?? '',
          providerModel: options.providerModel ?? '',
          project,
          isCancelled,
          onProgress: onGenerateProgress,
        });
        genAnnotations = result.annotations;
        builtChanges = result.changes;
        break;
      }
    }
  } catch (err) {
    yield {
      type: 'error',
      message:
        err instanceof Error
          ? err.message
          : `${annotationTypeLabel}生成流水线执行失败`,
    };
    return;
  }

  for (const msg of progressMessages) {
    yield progress('generate', msg, 'running');
  }

  const succeeded = builtChanges.filter(
    (c) => (c.annotations?.length ?? 0) > 0,
  );
  const totalAnnotations = succeeded.reduce(
    (sum, c) => sum + (c.annotations?.length ?? 0),
    0,
  );
  const processed = builtChanges.length;
  const skipped = processed - succeeded.length;

  if (totalAnnotations === 0) {
    yield {
      type: 'error',
      message: `未能生成有效的${annotationTypeLabel}标注数据。`,
    };
    return;
  }

  yield progress(
    'generate',
    `生成完成：${totalAnnotations} 条${annotationTypeLabel}`,
    'done',
    `处理 ${processed}，成功 ${succeeded.length}，跳过 ${skipped}`,
  );

  const stats: GenericProposalStats = {
    kind: 'generic',
    processed,
    succeeded: succeeded.length,
    skipped,
    cancelled: isCancelled(),
  };

  const writePolicy = inferAnnotationWritePolicy(
    userRequest,
    annotationType,
    options.writeMode ?? 'append',
  );
  const proposalChanges = await attachRewriteDeletes(
    succeeded,
    project.directoryPath,
    writePolicy,
  );

  const proposal: AnnotationBatchProposal = {
    id: createAgentId('proposal'),
    projectId: project.projectId,
    summary: `批量${annotationTypeLabel}标注生成：${succeeded.length} 项，共 ${totalAnnotations} 条`,
    changes: proposalChanges,
    stats,
    createdAt: Date.now(),
  };

  const summaryText = isCancelled()
    ? `标注生成已取消；已完成 ${succeeded.length} 项，跳过 ${skipped} 项。`
    : `已生成 ${totalAnnotations} 条${annotationTypeLabel}标注数据（${succeeded.length} 项）。`;

  yield { type: 'text', content: summaryText };
  yield { type: 'proposal', proposal };
}

async function collectImagePaths(
  project: AnnotationProjectSnapshot,
  currentFileAbsolutePath: string | null,
): Promise<InputPathEntry[]> {
  try {
    const catalog = await window.electron?.annotationAgent?.listImages(
      project.directoryPath,
      ANNOTATION_BATCH_MAX_FILES,
    );
    return (catalog ?? []).map((c) => ({
      relativePath: c.relativePath,
      absolutePath: c.absolutePath,
    }));
  } catch {
    if (currentFileAbsolutePath) {
      const rel = getRelativeProjectPath(
        project.directoryPath,
        currentFileAbsolutePath,
      );
      if (rel) {
        return [{ relativePath: rel, absolutePath: currentFileAbsolutePath }];
      }
    }
    return [];
  }
}

async function collectTextPaths(
  project: AnnotationProjectSnapshot,
  currentFileAbsolutePath: string | null,
): Promise<InputPathEntry[]> {
  try {
    const catalog = await window.electron?.annotationAgent?.listTextFiles(
      project.directoryPath,
      ANNOTATION_BATCH_MAX_FILES,
    );
    return (catalog ?? []).map((c) => ({
      relativePath: c.relativePath,
      absolutePath: c.absolutePath,
    }));
  } catch {
    if (currentFileAbsolutePath) {
      const rel = getRelativeProjectPath(
        project.directoryPath,
        currentFileAbsolutePath,
      );
      if (rel) {
        return [{ relativePath: rel, absolutePath: currentFileAbsolutePath }];
      }
    }
    return [];
  }
}

function getAnnotationTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    caption: '图片描述',
    classification: '图片分类',
    instruction: '指令数据',
    cot: '思维链',
    conversation: '多轮对话',
    preference: '偏好数据',
    text_classification: '文本分类',
    span_ner: '实体识别',
  };
  return labels[type] || type;
}
