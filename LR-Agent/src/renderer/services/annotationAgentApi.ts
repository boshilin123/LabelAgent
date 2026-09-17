import { localAgentFetch, resolveLocalAgentBaseUrl } from '../config';
import type {
  AnnotationProjectSnapshot,
  ImageCandidate,
} from '../../shared/annotationAgentTypes';
import { parseApiError } from './authenticatedFetch';

interface ApiSuccess<T> {
  code?: number;
  data: T;
}

/**
 * 调用本地 Agent 编排服务（LR-Agent-local）。
 *
 * 无认证、不经云端：API Key 仅在请求体中直传本地服务用于本次 LLM 调用。
 */
async function postAnnotationLlm<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const baseUrl = await resolveLocalAgentBaseUrl();
  const response = await localAgentFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const json = (await response.json()) as ApiSuccess<T>;
  return json.data;
}

export interface MutationPrepareResult {
  selected_paths: string[];
  intent_summary: string;
  operations: Array<Record<string, unknown>>;
  resolved_user_request?: string;
}

export async function prepareMutationAnnotation(
  providerId: string,
  options: {
    userRequest: string;
    sessionId?: string;
    /** 对话上下文 transcript，供 LLM 理解历史意图 */
    conversationTranscript?: string;
    currentRelativePath: string;
    candidates: ImageCandidate[];
    labelCandidates: Array<{ id: string; name: string }>;
    project: AnnotationProjectSnapshot | null;
    selectedAnnotationIds?: string[];
    providerApiKey?: string;
    providerBaseUrl?: string;
    providerModel?: string;
  },
): Promise<MutationPrepareResult> {
  return postAnnotationLlm<MutationPrepareResult>(
    '/agent/annotation/mutation-prepare',
    {
      provider_id: providerId,
      api_key: options.providerApiKey ?? '',
      base_url: options.providerBaseUrl ?? '',
      model: options.providerModel ?? '',
      user_request: options.userRequest,
      session_id: options.sessionId ?? null,
      conversation_transcript: options.conversationTranscript ?? '',
      current_relative_path: options.currentRelativePath,
      candidates: options.candidates.map((c) => ({
        relative_path: c.relativePath,
        name: c.name,
        parent: c.parent,
        index: c.index,
      })),
      label_candidates: options.labelCandidates,
      selected_annotation_ids: options.selectedAnnotationIds ?? [],
      project: options.project
        ? {
            project_id: options.project.projectId,
            name: options.project.name,
            modality: options.project.modality,
            annotation_type: options.project.annotationType,
            labels: options.project.labels.map((l) => ({
              id: l.id,
              name: l.name,
              color: l.color,
            })),
          }
        : null,
    },
  );
}

export interface MapDetectionBoxesUnifiedResult {
  ok?: boolean;
  error?: string;
  method?: string;
  mappings: Array<{ box_index: number; label_id: string; reason?: string }>;
  unmapped_indices?: number[];
  hint?: string;
  next_step?: string;
  label_pool_source?: string;
  label_pool_debug?: LabelPoolDebugInfo;
  vision_map_retry_rounds?: number;
  label_candidates?: Array<{ id: string; name: string }>;
}

/** 标签候选池各阶段调试信息（与后端 map 响应一致） */
export interface LabelPoolDebugInfo {
  source: string;
  project_count: number;
  scoped_count: number;
  effective_count: number;
  project_names: string[];
  scoped_names: string[];
  effective_names: string[];
  excluded_names: string[];
  preflight_label_ids: string[];
}

export async function mapDetectionBoxesUnified(
  providerId: string,
  options: {
    userRequest: string;
    intentSummary: string;
    labelCandidates: Array<{ id: string; name: string }>;
    boxes: Array<{
      box_index: number;
      x: number;
      y: number;
      width: number;
      height: number;
      class_name: string;
      confidence?: number;
    }>;
    useVision: boolean;
    labelStrategy: string;
    singleLabelId?: string | null;
    annotationScope: Record<string, unknown>;
    imageAbsolutePath?: string;
    imageBase64?: string;
    ocrText?: string;
    providerApiKey?: string;
    providerBaseUrl?: string;
    providerModel?: string;
    providerSupportsVision?: boolean;
    signal?: AbortSignal;
  },
): Promise<MapDetectionBoxesUnifiedResult> {
  return postAnnotationLlm<MapDetectionBoxesUnifiedResult>(
    '/agent/annotation/map-detection-boxes',
    {
      provider_id: providerId,
      api_key: options.providerApiKey ?? '',
      base_url: options.providerBaseUrl ?? '',
      model: options.providerModel ?? '',
      supports_vision: options.providerSupportsVision ?? false,
      user_request: options.userRequest,
      intent_summary: options.intentSummary,
      label_candidates: options.labelCandidates,
      boxes: options.boxes,
      use_vision: options.useVision,
      label_strategy: options.labelStrategy,
      single_label_id: options.singleLabelId ?? null,
      annotation_scope: options.annotationScope,
      image_absolute_path: options.imageAbsolutePath ?? '',
      image_base64: options.imageBase64 ?? '',
      ocr_text: options.ocrText ?? '',
    },
    options.signal,
  );
}
