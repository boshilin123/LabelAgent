import type {
  PretrainedModelConfig,
  PretrainedModelParams,
  ObjectDetectionMode,
} from './pretrainedModelTypes';

export type PreAnnotJobKind =
  'yolo_detect' | 'yolo_obb' | 'sam2_box' | 'keypoint_full' | 'keypoint_roi';

export interface PreAnnotNormBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PreAnnotRequest {
  jobId: string;
  kind: PreAnnotJobKind;
  imagePath: string;
  model: PretrainedModelConfig;
  box?: PreAnnotNormBox;
  templateId?: string;
  overrides?: Partial<PretrainedModelParams>;
}

export interface PreAnnotDetectItem {
  className: string;
  classId: number;
  confidence: number;
  geometry:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
      }
    | {
        cx: number;
        cy: number;
        width: number;
        height: number;
        angle: number;
      };
}

export interface PreAnnotDetectResult {
  items: PreAnnotDetectItem[];
  classNames?: string[];
}

export interface PreAnnotPolygonResult {
  points: { x: number; y: number }[];
  score?: number;
}

export interface PreAnnotPoseItem {
  templateId: string;
  confidence: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  keypoints: {
    x: number;
    y: number;
    visibility: 0 | 1 | 2;
    confidence: number;
  }[];
}

export interface PreAnnotPoseResult {
  poses: PreAnnotPoseItem[];
}

export type PreAnnotResult =
  PreAnnotDetectResult | PreAnnotPolygonResult | PreAnnotPoseResult;

export interface PreAnnotRuntimeInfo {
  pythonOk: boolean;
  pythonVersion?: string;
  pythonPath?: string;
  inferenceRoot?: string;
  torchVersion?: string | null;
  cudaAvailable?: boolean;
  ultralytics?: boolean;
  sam2?: boolean;
  mediapipe?: boolean;
  faceAlignment?: boolean;
  opencv?: boolean;
  error?: string;
}

export interface PreAnnotRunResponse {
  ok: boolean;
  result?: PreAnnotResult;
  error?: string;
  trace?: string;
}

export type AnnotationSource = 'manual' | 'preannot';

export type { ObjectDetectionMode };

export function isDetectResult(
  result: PreAnnotResult,
): result is PreAnnotDetectResult {
  return 'items' in result;
}

export function isPolygonResult(
  result: PreAnnotResult,
): result is PreAnnotPolygonResult {
  return 'points' in result && !('items' in result);
}

export function isPoseResult(
  result: PreAnnotResult,
): result is PreAnnotPoseResult {
  return 'poses' in result;
}

export function inferDetectionMode(
  model: PretrainedModelConfig,
): ObjectDetectionMode {
  if (model.detectionMode === 'obb' || model.detectionMode === 'detect') {
    return model.detectionMode;
  }
  const base = model.checkpointPath.replace(/\\/g, '/').split('/').pop() ?? '';
  return /obb/i.test(base) ? 'obb' : 'detect';
}
