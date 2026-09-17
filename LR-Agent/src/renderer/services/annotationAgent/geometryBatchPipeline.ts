import { createAgentId } from '../../../shared/agentTypes';
import type {
  AnnotationBatchProposal,
  AnnotationProjectSnapshot,
  BatchAnnotationPlan,
  DetectionOverrides,
  GeometryProposalStats,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import {
  ANNOTATION_BATCH_CONCURRENCY,
  ANNOTATION_BATCH_MAX_FILES,
} from '../../../shared/annotationAgentTypes';
import {
  logAnnotationDebug,
  logAnnotationDebugImageResult,
} from './annotationAgentDebug';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { getKeypointTemplate } from '../../types/keypointTemplate';
import { resolveLabelIdForPoseTemplate } from '../../utils/preAnnotLabelMapping';
import { AsyncEventQueue } from './asyncEventQueue';
import { formatDurationMs, formatSubImageTiming } from './annotationTiming';
import { getGeometryAdapter } from './geometryPipelineAdapter';
import { runGeometrySubImageAgent } from './geometrySubImageRunner';
import type { GeometryAnnotationType } from './geometryTypes';
import type { FusionSubImageResult } from './fusionSubImageTypes';
import {
  resolveAnnotationScopePaths,
  type AnnotationScopeResult,
  type InputPathEntry,
} from './scopePathUtil';
import {
  attachRewriteDeletes,
  inferAnnotationWritePolicy,
} from './annotationWritePolicy';

type WorkerResult = FusionSubImageResult;

type GeometryProgressEvent =
  | {
      type: 'progress';
      stage: string;
      message: string;
      status?: 'running' | 'done' | 'error';
      detail?: string;
      imagePath?: string;
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
): GeometryProgressEvent {
  return { type: 'progress', stage, message, status, detail, imagePath };
}

function defaultGeometryPlan(
  providerSupportsVision?: boolean,
): BatchAnnotationPlan {
  return {
    intent_summary: '几何实例检测 + 标签映射',
    label_strategy: 'map_each_box_to_label',
    use_vision_mapping: providerSupportsVision ?? false,
    detection_hints: {},
    sub_agent_constraints: {},
    annotation_scope: {},
    plan_steps: [],
  };
}

/** 将 auto_annotate 透传的检测约束覆盖到 plan（仅覆盖显式给出的字段）。 */
export function applyDetectionOverrides(
  plan: BatchAnnotationPlan,
  overrides: DetectionOverrides | undefined,
  providerSupportsVision?: boolean,
): void {
  if (!overrides) return;
  if (overrides.confThreshold !== undefined) {
    plan.detection_hints.conf_threshold = overrides.confThreshold;
  }
  if (overrides.iouThreshold !== undefined) {
    plan.detection_hints.iou_threshold = overrides.iouThreshold;
  }
  if (overrides.modelId) {
    plan.detection_hints.model_id = overrides.modelId;
  }
  if (overrides.includeClasses?.length) {
    plan.annotation_scope.include_detection_labels = [
      ...overrides.includeClasses,
    ];
  }
  if (overrides.excludeClasses?.length) {
    plan.annotation_scope.exclude_detection_labels = [
      ...overrides.excludeClasses,
    ];
  }
  if (overrides.useVisionMapping !== undefined) {
    // 视觉映射需要提供商通过视觉探针；未通过时强制关闭，避免逐框失败
    plan.use_vision_mapping =
      overrides.useVisionMapping && (providerSupportsVision ?? false);
  }
}

/** 按 id 指定检测模型；未命中返回 null，由调用方回退默认模型。 */
function pickModelById(
  models: PretrainedModelConfig[],
  modelId: string | undefined,
): PretrainedModelConfig | null {
  if (!modelId) return null;
  return models.find((m) => m.id === modelId) ?? null;
}

function formatWorkerDetailParts(result: WorkerResult): string[] {
  const parts = [
    result.mappedCount != null ? `已标 ${result.mappedCount} 实例` : '',
    result.unlabeledInProposal != null && result.unlabeledInProposal > 0
      ? `留空 ${result.unlabeledInProposal}`
      : result.unmappedCount != null && result.unmappedCount > 0
        ? `未映射 ${result.unmappedCount}`
        : '',
    result.rawCount != null
      ? `检测 ${result.rawCount}→保留 ${result.keptCount ?? 0}`
      : '',
    result.method ? `方式 ${result.method}` : '',
  ].filter(Boolean) as string[];
  if (result.timing) {
    parts.push(formatSubImageTiming(result.timing));
  } else if (result.elapsedMs != null) {
    parts.push(`总 ${formatDurationMs(result.elapsedMs)}`);
  }
  return parts;
}

async function* drainConcurrentPipelines(
  images: ImageCandidate[],
  concurrency: number,
  runOne: (
    image: ImageCandidate,
    index: number,
    push: (e: GeometryProgressEvent) => void,
  ) => Promise<WorkerResult>,
  isCancelled?: () => boolean,
): AsyncGenerator<GeometryProgressEvent, WorkerResult[]> {
  const queue = new AsyncEventQueue<GeometryProgressEvent>();
  const results: WorkerResult[] = new Array(images.length);
  let nextIndex = 0;
  let active = 0;
  let completed = 0;
  let cancelled = false;

  const maybeClose = (): void => {
    if (completed >= images.length || (cancelled && active === 0)) {
      queue.close();
    }
  };

  const pump = (): void => {
    if (isCancelled?.()) cancelled = true;
    while (!cancelled && active < concurrency && nextIndex < images.length) {
      const idx = nextIndex;
      nextIndex += 1;
      active += 1;
      const image = images[idx];
      void runOne(image, idx, (e) => queue.push(e))
        .then((result) => {
          results[idx] = result;
        })
        .catch((err) => {
          results[idx] = {
            ok: false,
            relativePath: image.relativePath,
            absolutePath: image.absolutePath,
            reason: err instanceof Error ? err.message : '处理失败',
          };
        })
        .finally(() => {
          active -= 1;
          completed += 1;
          maybeClose();
          if (!cancelled) pump();
          else maybeClose();
        });
    }
    if (cancelled) maybeClose();
  };

  pump();
  while (true) {
    const ev = await queue.take();
    if (ev === null) break;
    yield ev;
  }
  return results;
}

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

function getGeometryTypeLabel(type: GeometryAnnotationType): string {
  const labels: Record<GeometryAnnotationType, string> = {
    bbox: '矩形框',
    rotated_bbox: '旋转矩形框',
    polygon: '多边形',
    keypoint: '关键点',
  };
  return labels[type];
}

export async function* runGeometryPipeline(
  options: {
    providerId: string;
    userRequest: string;
    sessionId?: string;
    project: AnnotationProjectSnapshot;
    currentFileAbsolutePath: string | null;
    detectionModels: PretrainedModelConfig[];
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
    /** auto_annotate 透传的检测约束 */
    detectionOverrides?: DetectionOverrides;
  },
  isCancelled: () => boolean,
  geometryType: GeometryAnnotationType,
): AsyncGenerator<GeometryProgressEvent> {
  const { project, userRequest, providerId, detectionModels } = options;
  const adapter = getGeometryAdapter(geometryType);
  const typeLabel = getGeometryTypeLabel(geometryType);

  if (!adapter) {
    yield {
      type: 'error',
      message: `不支持的标注类型：${geometryType}`,
    };
    return;
  }

  const adapterContext = {
    keypointTemplateId: project.keypointTemplateId,
    labelCount: project.labels.length,
    labels: project.labels,
  };

  const requestedModelId = options.detectionOverrides?.modelId;
  let primaryModel = requestedModelId
    ? pickModelById(detectionModels, requestedModelId)
    : null;
  if (requestedModelId && !primaryModel) {
    yield progress(
      'prepare',
      `未找到指定检测模型（id: ${requestedModelId}），回退默认模型`,
      'running',
    );
  }
  primaryModel ??= adapter.pickPrimaryModel(detectionModels, adapterContext);
  if (!primaryModel) {
    yield {
      type: 'error',
      message: `未找到可用的 ${typeLabel} 预训练模型，请先在「预训练模型」中配置并启用。`,
    };
    return;
  }

  const secondaryModel = adapter.pickSecondaryModel?.(
    detectionModels,
    adapterContext,
  );

  if (geometryType === 'polygon' && !secondaryModel) {
    yield {
      type: 'error',
      message: '多边形标注需要同时配置目标检测模型与 SAM2 分割模型。',
    };
    return;
  }

  if (geometryType === 'keypoint') {
    if (!project.keypointTemplateId) {
      yield {
        type: 'error',
        message: '关键点批量标注需要先选择骨架模板。',
      };
      return;
    }
    const template = getKeypointTemplate(project.keypointTemplateId);
    if (template && !resolveLabelIdForPoseTemplate(template, project.labels)) {
      yield {
        type: 'error',
        message: `请先在项目中添加与模板匹配的标签「${template.defaultLabel}」。`,
      };
      return;
    }
  }

  const labelCandidates = project.labels.map((l) => ({
    id: l.id,
    name: l.name,
  }));
  const plan = defaultGeometryPlan(options.providerSupportsVision);
  applyDetectionOverrides(
    plan,
    options.detectionOverrides,
    options.providerSupportsVision,
  );
  logAnnotationDebug('plan-overrides', project.projectId, {
    overrides: options.detectionOverrides,
    detection_hints: plan.detection_hints,
    annotation_scope: plan.annotation_scope,
    use_vision_mapping: plan.use_vision_mapping,
  });

  yield progress('prepare', `正在准备${typeLabel}批量标注…`);

  if (isCancelled()) {
    yield progress('prepare', '已取消', 'error');
    return;
  }

  let images: ImageCandidate[] = [];
  try {
    const catalog = await window.electron?.annotationAgent?.listImages(
      project.directoryPath,
      ANNOTATION_BATCH_MAX_FILES * 4,
    );
    const candidates: ImageCandidate[] = (catalog ?? []).map((c) => ({
      relativePath: c.relativePath,
      name: c.name,
      parent: c.parent,
      absolutePath: c.absolutePath,
      index: c.index,
    }));
    const candidatePaths: InputPathEntry[] = candidates.map((c) => ({
      relativePath: c.relativePath,
      absolutePath: c.absolutePath,
    }));
    const scoped = await resolveScopePathsForProject(
      candidatePaths,
      options,
      project.directoryPath,
    );
    if (scoped.error) {
      yield { type: 'error', message: scoped.error };
      return;
    }
    if (scoped.omittedCount && scoped.omittedCount > 0) {
      yield {
        type: 'scope_truncated',
        omittedCount: scoped.omittedCount,
        omittedPaths: scoped.omittedPaths ?? [],
      };
    }
    const scopedByPath = new Map(scoped.paths.map((p) => [p.relativePath, p]));
    images = candidates.filter((c) => scopedByPath.has(c.relativePath));
    const seenRels = new Set(images.map((c) => c.relativePath));
    for (const extra of scoped.paths) {
      if (seenRels.has(extra.relativePath)) continue;
      const parts = extra.relativePath.split('/');
      images.push({
        relativePath: extra.relativePath,
        name: parts[parts.length - 1] || extra.relativePath,
        parent: parts.slice(0, -1).join('/'),
        absolutePath: extra.absolutePath,
        index: images.length,
      });
      seenRels.add(extra.relativePath);
    }

    yield progress(
      'prepare',
      images.length ? '批量准备完成' : '未选定图片',
      images.length ? 'done' : 'error',
      images.length ? `已选定 ${images.length} 张图片` : undefined,
    );
  } catch (err) {
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : '批量准备失败',
    };
    return;
  }

  if (images.length === 0) {
    yield {
      type: 'error',
      message: '未选定图片。请提供 paths 或将 all_files 设为 true。',
    };
    return;
  }

  const total = images.length;
  yield progress(
    'workers',
    `共 ${total} 张图片，并发处理 ${typeLabel}`,
    'running',
  );

  const pipelineGen = drainConcurrentPipelines(
    images,
    geometryType === 'polygon' ? 2 : ANNOTATION_BATCH_CONCURRENCY,
    async (image, index, push) => {
      if (isCancelled()) {
        return {
          ok: false,
          relativePath: image.relativePath,
          absolutePath: image.absolutePath,
          reason: '已取消',
        };
      }
      push(
        progress(
          'worker',
          `处理中 (${index + 1}/${total})：${image.relativePath}`,
          'running',
          undefined,
          image.relativePath,
        ),
      );
      return runGeometrySubImageAgent({
        annotationType: geometryType,
        providerId,
        userRequest,
        plan,
        image,
        primaryModel,
        secondaryModel,
        labelCandidates,
        adapterContext,
        onProgress: (event) =>
          push(
            progress(
              event.stage,
              event.message,
              event.status ?? 'running',
              event.detail,
              event.imagePath ?? image.relativePath,
            ),
          ),
        providerApiKey: options.providerApiKey ?? '',
        providerBaseUrl: options.providerBaseUrl ?? '',
        providerModel: options.providerModel ?? '',
        providerSupportsVision: options.providerSupportsVision ?? false,
        signal: options.abortSignal,
      });
    },
    isCancelled,
  );

  let workerResults: WorkerResult[] = [];
  while (true) {
    const next = await pipelineGen.next();
    if (next.done) {
      workerResults = (next.value ?? []).filter(
        (r): r is WorkerResult => r != null,
      );
      break;
    }
    yield next.value;
  }

  const cancelled = isCancelled();
  for (const result of workerResults) {
    if (result.ok) {
      logAnnotationDebugImageResult(result.relativePath, {
        ok: true,
        geometryType,
      });
      yield progress(
        'worker',
        `完成：${result.relativePath}`,
        'done',
        formatWorkerDetailParts(result).join(' · ') || undefined,
        result.relativePath,
      );
    } else {
      yield progress(
        'worker',
        `跳过：${result.relativePath}`,
        'error',
        result.reason,
        result.relativePath,
      );
    }
  }

  const succeeded = workerResults.filter((r) => r.ok && r.change);
  const skipped = workerResults.filter((r) => !r.ok);
  const totalInstances = succeeded.reduce(
    (sum, r) => sum + (r.change?.annotations?.length ?? 0),
    0,
  );

  if (succeeded.length === 0) {
    if (!cancelled) {
      yield {
        type: 'error',
        message: `未能生成可应用的${typeLabel}标注。`,
      };
    }
    return;
  }

  const stats: GeometryProposalStats = {
    kind: 'geometry',
    processed: workerResults.length,
    succeeded: succeeded.length,
    skipped: skipped.length,
    totalInstances,
    cancelled,
  };

  const writePolicy = inferAnnotationWritePolicy(
    userRequest,
    geometryType,
    options.writeMode ?? 'append',
  );
  const proposalChanges = await attachRewriteDeletes(
    succeeded.map((r) => r.change!),
    project.directoryPath,
    writePolicy,
  );

  const proposal: AnnotationBatchProposal = {
    id: createAgentId('proposal'),
    projectId: project.projectId,
    summary: `${typeLabel}批量标注：${succeeded.length} 张图片，共 ${totalInstances} 个实例`,
    changes: proposalChanges,
    stats,
    plan,
    createdAt: Date.now(),
  };

  yield {
    type: 'text',
    content: cancelled
      ? `标注已取消；已完成 ${succeeded.length} 张。`
      : `已处理 ${images.length} 张图片，成功 ${succeeded.length} 张，共 ${totalInstances} 个实例。`,
  };
  yield { type: 'proposal', proposal };
}
