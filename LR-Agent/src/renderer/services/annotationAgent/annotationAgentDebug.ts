/**
 * 批量标注诊断日志（DevTools Console / Electron 终端可见）。
 * 过滤：annotation-agent
 */

import type {
  LabelPoolDebugInfo,
  MapDetectionBoxesUnifiedResult,
} from '../annotationAgentApi';
import { formatDurationMs } from './annotationTiming';

const PREFIX = '[annotation-agent]';

export type LabelCandidateRef = { id: string; name: string };

export type MapMappingRow = {
  box_index: number;
  label_id: string;
  label: string;
  reason: string;
};

function enabled(): boolean {
  if (typeof window === 'undefined') return true;
  const w = window as Window & { __LR_AGENT_ANNOTATION_DEBUG__?: boolean };
  return w.__LR_AGENT_ANNOTATION_DEBUG__ !== false;
}

export function labelNameById(
  candidates: LabelCandidateRef[],
  id: string,
): string {
  if (!id) return '(空)';
  return candidates.find((c) => c.id === id)?.name ?? id;
}

export function formatMapMappingRows(
  mappings: Array<{ box_index: number; label_id: string; reason?: string }>,
  labelCandidates: LabelCandidateRef[],
): MapMappingRow[] {
  return [...mappings]
    .sort((a, b) => a.box_index - b.box_index)
    .map((m) => ({
      box_index: m.box_index,
      label_id: m.label_id || '',
      label: labelNameById(labelCandidates, m.label_id),
      reason: (m.reason || '').trim(),
    }));
}

export function logAnnotationDebug(
  stage: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!enabled()) return;
  const elapsed =
    data?.elapsed_ms != null ? Number(data.elapsed_ms) : undefined;
  const suffix =
    elapsed != null && !Number.isNaN(elapsed)
      ? ` (+${formatDurationMs(elapsed)})`
      : '';
  if (data !== undefined) {
    console.log(`${PREFIX} [${stage}] ${message}${suffix}`, data);
  } else {
    console.log(`${PREFIX} [${stage}] ${message}${suffix}`);
  }
}

export function logAnnotationDebugLabelPool(
  relativePath: string,
  pool: LabelPoolDebugInfo | undefined,
  fallback?: {
    label_pool_source?: string;
    project_names?: string[];
  },
): void {
  if (!pool && !fallback?.label_pool_source) return;
  logAnnotationDebug('label-pool', relativePath, {
    source: pool?.source ?? fallback?.label_pool_source,
    project_count: pool?.project_count,
    scoped_count: pool?.scoped_count,
    effective_count: pool?.effective_count,
    project_names: pool?.project_names ?? fallback?.project_names,
    scoped_names: pool?.scoped_names,
    effective_names: pool?.effective_names,
    excluded_names: pool?.excluded_names?.length
      ? pool.excluded_names
      : undefined,
    preflight_label_ids: pool?.preflight_label_ids?.length
      ? pool.preflight_label_ids
      : undefined,
  });
}

export function logAnnotationDebugMapDetail(
  relativePath: string,
  options: {
    elapsed_ms?: number;
    mapResult: MapDetectionBoxesUnifiedResult;
    labelCandidates: LabelCandidateRef[];
    userRequest?: string;
    intentSummary?: string;
    attempt?: number;
  },
): void {
  const { mapResult, labelCandidates } = options;
  const mappingRows = formatMapMappingRows(
    mapResult.mappings ?? [],
    labelCandidates,
  );

  logAnnotationDebugLabelPool(relativePath, mapResult.label_pool_debug, {
    label_pool_source: mapResult.label_pool_source,
    project_names: labelCandidates.map((l) => l.name),
  });

  logAnnotationDebug('map-response', relativePath, {
    elapsed_ms: options.elapsed_ms,
    ok: mapResult.ok,
    method: mapResult.method,
    mapped: mappingRows.filter((r) => r.label_id).length,
    unmapped: mapResult.unmapped_indices?.length ?? 0,
    vision_map_retry_rounds: mapResult.vision_map_retry_rounds,
    hint: mapResult.hint || undefined,
    user_request: options.userRequest?.trim() || undefined,
    intent_summary: options.intentSummary?.trim() || undefined,
    attempt: options.attempt,
    mappings: mappingRows,
  });
}

export function logAnnotationDebugImageResult(
  relativePath: string,
  result: {
    ok: boolean;
    reason?: string;
    rawCount?: number;
    keptCount?: number;
    mappedCount?: number;
    unmappedCount?: number;
    method?: string;
    mapHint?: string;
    autoFinalized?: boolean;
    mappings?: MapMappingRow[];
    geometryType?: string;
  },
): void {
  logAnnotationDebug(result.ok ? 'image-ok' : 'image-skip', relativePath, {
    ok: result.ok,
    reason: result.reason,
    rawCount: result.rawCount,
    keptCount: result.keptCount,
    mappedCount: result.mappedCount,
    unmappedCount: result.unmappedCount,
    method: result.method,
    mapHint: result.mapHint,
    autoFinalized: result.autoFinalized,
    geometryType: result.geometryType,
    mappings: result.mappings?.length ? result.mappings : undefined,
  });
}
