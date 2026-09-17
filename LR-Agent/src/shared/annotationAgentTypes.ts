import type {
  AnnotationType,
  LabelDefinition,
  Modality,
} from '../renderer/types/annotation';
import type {
  AnnotationInstance,
  CaptionGranularity,
  ConversationTurn,
  CotStep,
  PoseKeypoint,
} from '../renderer/types/annotationDocument';

export interface ImageCandidate {
  relativePath: string;
  name: string;
  parent: string;
  absolutePath: string;
  index: number;
}

export interface AnnotationScopePayload {
  scope_summary?: string;
  include_detection_labels?: string[];
  exclude_detection_labels?: string[];
  include_label_names?: string[];
  exclude_label_names?: string[];
}

export interface DetectionHints {
  needs_object_detection?: boolean;
  model_id?: string | null;
  conf_threshold?: number;
  iou_threshold?: number;
  notes?: string;
}

/**
 * auto_annotate 工具透传的检测约束（主 Agent 从用户请求中解析，见后端 AutoAnnotateArgs）。
 * 仅几何标注管线（bbox/rotated_bbox/polygon/keypoint）消费；生成类管线忽略。
 */
export interface DetectionOverrides {
  confThreshold?: number;
  iouThreshold?: number;
  /** 指定检测模型 id（预训练模型配置 id），未命中时回退默认模型 */
  modelId?: string;
  /** 只保留这些检测类名的框 */
  includeClasses?: string[];
  /** 排除这些检测类名的框 */
  excludeClasses?: string[];
  /** 覆盖是否使用视觉映射；undefined 时按系统默认策略 */
  useVisionMapping?: boolean;
}

export interface SubAgentConstraints {
  require_per_box_mapping?: boolean;
  allow_unlabeled_boxes?: boolean;
  min_labeled_box_count?: number;
}

export interface JudgeConfig {
  enabled: boolean;
  maxRetries: number;
  /** reject 重试耗尽后仍提交部分标注（默认 true） */
  rejectSubmitPartial?: boolean;
}

export interface BatchAnnotationPlan {
  intent_summary: string;
  label_strategy: 'map_each_box_to_label' | 'single_label_for_all_boxes';
  use_vision_mapping?: boolean;
  detection_hints: DetectionHints;
  sub_agent_constraints: SubAgentConstraints;
  annotation_scope: AnnotationScopePayload;
  judge_config?: JudgeConfig;
  plan_steps: string[];
}

/** Single-shot batch prepare: scope + plan (replaces parse-task + parse-scope + create-plan). */
export interface BatchPrepareResult extends BatchAnnotationPlan {
  selected_paths: string[];
  scope_reason: string;
  /** 后端指代消解后的可执行请求（有 session 时） */
  resolved_user_request?: string;
}

/** Unified mutation operations for batch proposals (append/replace/patch/delete). */
export type AnnotationChangeOperation =
  'append' | 'replace' | 'replace_bboxes' | 'patch' | 'delete';

export interface AnnotationPatch {
  id: string;
  labelId?: string;
  note?: string;
  /** bbox geometry (normalized 0–1) */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** rotated_bbox / pose center + rotation（width/height 与 bbox 共用） */
  cx?: number;
  cy?: number;
  /** 旋转角度（度） */
  angle?: number;
  /** polygon vertices (normalized 0–1) */
  points?: { x: number; y: number }[];
  /** pose 关键点（整表替换，长度须与骨架模板一致） */
  keypoints?: PoseKeypoint[];
  /** span_ner 文本偏移（字符索引，start < end） */
  start?: number;
  end?: number;
  /** caption */
  text?: string;
  granularity?: CaptionGranularity;
  language?: string;
  /** cot */
  steps?: CotStep[];
  answer?: string;
  /** cot / instruction 的指令文本 */
  instruction?: string;
  /** instruction 的输入/输出 */
  input?: string;
  output?: string;
  /** preference */
  prompt?: string;
  chosen?: string;
  rejected?: string;
  /** conversation（整表替换） */
  turns?: ConversationTurn[];
}

export interface AnnotationBatchChange {
  relativePath: string;
  absolutePath: string;
  operation: AnnotationChangeOperation;
  /** append / replace / replace_bboxes */
  annotations?: AnnotationInstance[];
  /** patch */
  patches?: AnnotationPatch[];
  /** delete */
  deleteIds?: string[];
  judge?: AnnotationJudgeSummary;
}

export const MAX_MUTATIONS_PER_PROPOSAL = 200;

export type AnnotationJudgeVerdict = 'accept' | 'weak_accept' | 'reject';

export interface AnnotationJudgeIssue {
  boxIndex?: number;
  code?: string;
  message: string;
  expectedLabelId?: string;
  actualLabelId?: string;
}

export interface AnnotationJudgeSummary {
  verdict: AnnotationJudgeVerdict;
  confidence?: number;
  summary?: string;
  issues?: AnnotationJudgeIssue[];
  retryFeedback?: string;
  checkedBoxes?: number;
  attempts?: number;
  retryRounds?: number;
}

/** Bbox-specific stats (backward compat) */
export interface BboxProposalStats {
  kind: 'bbox';
  processed: number;
  succeeded: number;
  skipped: number;
  totalBoxes: number;
  judged?: number;
  accepted?: number;
  weakAccepted?: number;
  rejected?: number;
  retryRounds?: number;
  unlabeledBoxes?: number;
  cancelled?: boolean;
}

/** Generic stats for non-bbox annotation types */
export interface GenericProposalStats {
  kind: 'generic';
  processed: number;
  succeeded: number;
  skipped: number;
  cancelled?: boolean;
}

/** Geometry pipeline stats (rotated_bbox, polygon, keypoint) */
export interface GeometryProposalStats {
  kind: 'geometry';
  processed: number;
  succeeded: number;
  skipped: number;
  totalInstances: number;
  unlabeledInstances?: number;
  judged?: number;
  accepted?: number;
  weakAccepted?: number;
  rejected?: number;
  retryRounds?: number;
  cancelled?: boolean;
}

export type AnnotationProposalStats =
  BboxProposalStats | GenericProposalStats | GeometryProposalStats;

export interface AnnotationBatchProposal {
  id: string;
  projectId: string;
  summary: string;
  changes: AnnotationBatchChange[];
  stats: AnnotationProposalStats;
  plan?: BatchAnnotationPlan;
  createdAt: number;
}

export interface AnnotationProjectSnapshot {
  projectId: string;
  name: string;
  directoryPath: string;
  modality: Modality;
  annotationType: AnnotationType;
  /** Human-readable label for annotationType */
  annotationTypeLabel?: string;
  labels: LabelDefinition[];
  detectionModels?: DetectionModelSummary[];
  /** Active keypoint template when annotationType is keypoint */
  keypointTemplateId?: string;
}

export type AgentInteractionMode = 'chat' | 'annotation';

export interface DetectionModelSummary {
  id: string;
  name: string;
  isDefault?: boolean;
}

export const ANNOTATION_BATCH_MAX_FILES = 100;
export const ANNOTATION_BATCH_CONCURRENCY = 4;
export const ANNOTATION_GENERATE_CONCURRENCY = 3;
