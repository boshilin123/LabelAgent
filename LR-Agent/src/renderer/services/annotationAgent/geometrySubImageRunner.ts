/**
 * Generalized geometry sub-image agent: PreAnnot inference → map → finalize.
 */
import {
  mapDetectionBoxesUnified,
  type MapDetectionBoxesUnifiedResult,
} from '../annotationAgentApi';
import type {
  BatchAnnotationPlan,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import type { SubImageTimingBreakdown } from './annotationTiming';
import { tryAutoFinalizeFromGeometry } from './geometryFinalize';
import {
  buildPresetMappings,
  getGeometryAdapter,
  type GeometryAdapterContext,
} from './geometryPipelineAdapter';
import type { GeometryAnnotationType, GeometryInstance } from './geometryTypes';
import { instancesToMapBoxes } from './geometryTypes';
import {
  formatMapMappingRows,
  logAnnotationDebug,
  logAnnotationDebugMapDetail,
} from './annotationAgentDebug';
import type { FusionSubImageResult } from './fusionSubImageTypes';
import { readImageBase64 } from './fusionSubImageTools';

type MappingRow = { box_index: number; label_id: string; reason?: string };

export async function runGeometrySubImageAgent(options: {
  annotationType: GeometryAnnotationType;
  providerId: string;
  userRequest: string;
  plan: BatchAnnotationPlan;
  image: ImageCandidate;
  primaryModel: PretrainedModelConfig;
  secondaryModel?: PretrainedModelConfig | null;
  labelCandidates: Array<{ id: string; name: string }>;
  adapterContext: GeometryAdapterContext;
  onProgress?: (event: {
    stage: string;
    message: string;
    status?: 'running' | 'done' | 'error';
    detail?: string;
    imagePath?: string;
  }) => void;
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerSupportsVision?: boolean;
  signal?: AbortSignal;
}): Promise<FusionSubImageResult> {
  const { image, plan, annotationType } = options;
  const adapter = getGeometryAdapter(annotationType);
  const base = {
    ok: false as const,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
  };
  if (!adapter) {
    return { ...base, reason: `不支持的标注类型：${annotationType}` };
  }

  const minLabeled = plan.sub_agent_constraints.min_labeled_box_count ?? 1;
  const useVision = Boolean(plan.use_vision_mapping);
  const skipMapping =
    adapter.skipLabelMapping?.(options.adapterContext) ?? false;
  const totalStarted = performance.now();
  const timing: SubImageTimingBreakdown = { total_ms: 0 };

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
  };

  logAnnotationDebug('sub-agent-start', image.relativePath, {
    mode: 'geometry',
    geometry_type: annotationType,
    provider_id: options.providerId,
    use_vision_mapping: useVision,
    skip_label_mapping: skipMapping,
    primary_model: options.primaryModel.id,
    secondary_model: options.secondaryModel?.id,
    user_request: options.userRequest.trim() || undefined,
  });

  let instances: GeometryInstance[] = [];
  let rawCount = 0;
  let keptCount = 0;
  let mapMethod = '';
  let mapHint = '';

  throwIfAborted();
  const tInfer = performance.now();
  try {
    const inferResult = await adapter.runInference({
      image,
      plan,
      primaryModel: options.primaryModel,
      secondaryModel: options.secondaryModel,
      adapterContext: options.adapterContext,
      onProgress: (message) =>
        options.onProgress?.({
          stage: 'infer',
          message,
          status: 'running',
          imagePath: image.relativePath,
        }),
    });
    instances = inferResult.instances;
    rawCount = inferResult.rawCount;
    keptCount = inferResult.keptCount;
  } catch (err) {
    timing.total_ms = Math.round(performance.now() - totalStarted);
    return {
      ...base,
      reason: err instanceof Error ? err.message : '几何推理失败',
      elapsedMs: timing.total_ms,
      timing,
    };
  }
  timing.detect_ms = Math.round(performance.now() - tInfer);

  const withTiming = (result: FusionSubImageResult): FusionSubImageResult => ({
    ...result,
    elapsedMs: timing.total_ms,
    timing,
  });

  if (keptCount === 0) {
    const reason =
      rawCount > 0
        ? `检测到 ${rawCount} 个实例但全部在范围外或未生成分割/关键点`
        : '推理未返回实例';
    timing.total_ms = Math.round(performance.now() - totalStarted);
    return withTiming({
      ...base,
      reason,
      rawCount,
      keptCount: 0,
    });
  }

  const mapBoxesPayload = instancesToMapBoxes(instances);
  const singleLabelId =
    plan.label_strategy === 'single_label_for_all_boxes' &&
    options.labelCandidates.length === 1
      ? options.labelCandidates[0].id
      : null;

  let imageBase64 = '';
  const ensureImageBase64 = async (): Promise<string> => {
    if (imageBase64) return imageBase64;
    const tRead = performance.now();
    imageBase64 = await readImageBase64(image.absolutePath);
    timing.read_image_ms =
      (timing.read_image_ms ?? 0) + Math.round(performance.now() - tRead);
    return imageBase64;
  };

  const runMap = async (): Promise<MapDetectionBoxesUnifiedResult> => {
    throwIfAborted();
    const tMap = performance.now();
    let mapResult = await mapDetectionBoxesUnified(options.providerId, {
      userRequest: options.userRequest,
      intentSummary: plan.intent_summary,
      labelCandidates: options.labelCandidates,
      boxes: mapBoxesPayload,
      useVision,
      labelStrategy: plan.label_strategy,
      singleLabelId,
      annotationScope: { ...plan.annotation_scope },
      imageAbsolutePath: image.absolutePath,
      providerApiKey: options.providerApiKey ?? '',
      providerBaseUrl: options.providerBaseUrl ?? '',
      providerModel: options.providerModel ?? '',
      providerSupportsVision: options.providerSupportsVision ?? false,
      signal: options.signal,
    });

    if (
      useVision &&
      mapResult.ok === false &&
      (mapResult as { error?: string }).error === 'image_unavailable'
    ) {
      const fallbackBase64 = await ensureImageBase64();
      mapResult = await mapDetectionBoxesUnified(options.providerId, {
        userRequest: options.userRequest,
        intentSummary: plan.intent_summary,
        labelCandidates: options.labelCandidates,
        boxes: mapBoxesPayload,
        useVision,
        labelStrategy: plan.label_strategy,
        singleLabelId,
        annotationScope: { ...plan.annotation_scope },
        imageBase64: fallbackBase64,
        providerApiKey: options.providerApiKey ?? '',
        providerBaseUrl: options.providerBaseUrl ?? '',
        providerModel: options.providerModel ?? '',
        providerSupportsVision: options.providerSupportsVision ?? false,
        signal: options.signal,
      });
    }
    timing.map_ms = (timing.map_ms ?? 0) + Math.round(performance.now() - tMap);
    return mapResult;
  };

  let lastMapMappings = formatMapMappingRows([], options.labelCandidates);
  let ctxMappings: MappingRow[] = skipMapping
    ? buildPresetMappings(instances)
    : [];

  throwIfAborted();

  if (!skipMapping) {
    const mapResult = await runMap();
    ctxMappings = mapResult.mappings ?? [];
    mapMethod = mapResult.method ?? '';
    mapHint = mapResult.hint ?? '';
    lastMapMappings = formatMapMappingRows(
      ctxMappings,
      options.labelCandidates,
    );
    logAnnotationDebugMapDetail(image.relativePath, {
      elapsed_ms: timing.map_ms,
      mapResult,
      labelCandidates: options.labelCandidates,
      userRequest: options.userRequest,
      attempt: 0,
    });
  } else if (singleLabelId) {
    ctxMappings = instances.map((inst) => ({
      box_index: inst.instance_index,
      label_id: singleLabelId,
      reason: 'single_label_strategy',
    }));
    mapMethod = 'preset';
    lastMapMappings = formatMapMappingRows(
      ctxMappings,
      options.labelCandidates,
    );
  }

  const auto = tryAutoFinalizeFromGeometry({
    plan,
    imageRelativePath: image.relativePath,
    imageAbsolutePath: image.absolutePath,
    instances,
    mappings: ctxMappings,
    labelCandidates: options.labelCandidates,
  });

  if (!auto.ok || !auto.change) {
    const mappedCount = ctxMappings.filter((m) => m.label_id).length;
    timing.total_ms = Math.round(performance.now() - totalStarted);
    return withTiming({
      ...base,
      reason:
        auto.reason ||
        mapHint ||
        `成功映射 ${mappedCount} 个实例，不足 ${minLabeled}`,
      rawCount,
      keptCount,
      mappedCount,
      unmappedCount: Math.max(0, keptCount - mappedCount),
      unlabeledInProposal: auto.unlabeledInProposal,
      method: mapMethod,
      mapHint,
      mapMappings: lastMapMappings,
    });
  }

  timing.total_ms = Math.round(performance.now() - totalStarted);
  return withTiming({
    ok: true,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
    change: auto.change,
    rawCount,
    keptCount,
    mappedCount: auto.mappedCount,
    unmappedCount: Math.max(0, keptCount - auto.mappedCount),
    unlabeledInProposal: auto.unlabeledInProposal,
    autoFinalized: true,
    method: mapMethod,
    mapMappings: lastMapMappings,
  });
}
