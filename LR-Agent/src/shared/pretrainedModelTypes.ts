export type PretrainedModelType =
  'object_detection' | 'image_segmentation' | 'keypoint_estimation';

export type KeypointBackend = 'yolo_pose' | 'mediapipe_hand' | 'face_alignment';

export type ObjectDetectionMode = 'detect' | 'obb';

export interface KeypointAuxiliaryPaths {
  detector?: string;
  torchHome?: string;
}

export interface PretrainedModelParams {
  device?: 'auto' | 'cuda' | 'cpu';
  confThreshold?: number;
  iouThreshold?: number;
  minArea?: number;
  epsilonRatio?: number;
  kptConfThreshold?: number;
  maxInstances?: number;
}

export interface PretrainedModelConfig {
  id: string;
  name: string;
  modelType: PretrainedModelType;
  enabled: boolean;
  isDefault: boolean;
  checkpointPath: string;
  configPath?: string;
  /** YOLO detect vs OBB; inferred from filename when omitted */
  detectionMode?: ObjectDetectionMode;
  /** Class names from model metadata (YOLO) */
  classNames?: string[];
  /** model class name -> project label id */
  labelMapping?: Record<string, string>;
  keypointBackend?: KeypointBackend;
  keypointTemplateIds?: string[];
  auxiliaryPaths?: KeypointAuxiliaryPaths;
  params?: PretrainedModelParams;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PretrainedModelValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface Sam2ScanResult {
  variant: string;
  name: string;
  checkpointPath: string;
  configPath: string;
}

export interface KeypointAssetScanResult {
  backend: KeypointBackend;
  name: string;
  checkpointPath: string;
  keypointTemplateIds: string[];
  auxiliaryPaths?: KeypointAuxiliaryPaths;
}

export interface KeypointBundleScanResult {
  models: KeypointAssetScanResult[];
}

export const PRETRAINED_MODEL_TYPE_LABELS: Record<PretrainedModelType, string> =
  {
    object_detection: '目标检测 (YOLO)',
    image_segmentation: '图像分割 (SAM2)',
    keypoint_estimation: '关键点估计',
  };

export const KEYPOINT_BACKEND_LABELS: Record<KeypointBackend, string> = {
  yolo_pose: 'YOLO-Pose',
  mediapipe_hand: 'MediaPipe Hand',
  face_alignment: 'face-alignment (68点)',
};

export const KEYPOINT_BACKEND_PRESETS: Record<
  KeypointBackend,
  {
    label: string;
    defaultTemplateIds: string[];
    checkpointExtensions: string[];
    defaultParams: Pick<
      PretrainedModelParams,
      'kptConfThreshold' | 'maxInstances'
    >;
    hint: string;
  }
> = {
  yolo_pose: {
    label: 'YOLO-Pose',
    defaultTemplateIds: ['person_coco'],
    checkpointExtensions: ['pt'],
    defaultParams: { kptConfThreshold: 0.5, maxInstances: 20 },
    hint: '需使用 *-pose.pt 权重，与 detect 权重不同',
  },
  mediapipe_hand: {
    label: 'MediaPipe Hand',
    defaultTemplateIds: ['hand'],
    checkpointExtensions: ['task'],
    defaultParams: { kptConfThreshold: 0.5, maxInstances: 2 },
    hint: '使用 hand_landmarker.task',
  },
  face_alignment: {
    label: 'face-alignment (68点)',
    defaultTemplateIds: ['face_68_pts'],
    checkpointExtensions: ['pth', 'tar'],
    defaultParams: { kptConfThreshold: 0.5, maxInstances: 10 },
    hint: '需 2DFAN + s3fd 检测器成对使用',
  },
};

export const DEFAULT_YOLO_PARAMS: Required<
  Pick<PretrainedModelParams, 'confThreshold' | 'iouThreshold'>
> = {
  confThreshold: 0.7,
  iouThreshold: 0.5,
};

export const DEFAULT_SAM2_PARAMS: Required<
  Pick<PretrainedModelParams, 'minArea' | 'epsilonRatio'>
> = {
  minArea: 100,
  epsilonRatio: 0.006,
};

export const REGISTRY_VERSION = 2;

export function createModelId(name?: string): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = Date.now().toString(36);
  return slug ? `${slug}-${suffix}` : `model-${suffix}`;
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

export function getModelDisplayName(model: PretrainedModelConfig): string {
  if (model.name.trim()) return model.name.trim();
  if (model.checkpointPath.trim()) {
    return basename(model.checkpointPath).replace(/\.(pt|task|pth|tar)$/i, '');
  }
  return PRETRAINED_MODEL_TYPE_LABELS[model.modelType];
}

export function defaultParamsForBackend(
  backend: KeypointBackend,
): PretrainedModelParams {
  return {
    device: 'auto',
    ...KEYPOINT_BACKEND_PRESETS[backend].defaultParams,
  };
}

export function defaultParamsForType(
  modelType: PretrainedModelType,
  keypointBackend?: KeypointBackend,
): PretrainedModelParams {
  if (modelType === 'object_detection') {
    return { ...DEFAULT_YOLO_PARAMS, device: 'auto' };
  }
  if (modelType === 'image_segmentation') {
    return { ...DEFAULT_SAM2_PARAMS, device: 'auto' };
  }
  if (keypointBackend) {
    return defaultParamsForBackend(keypointBackend);
  }
  return defaultParamsForBackend('yolo_pose');
}

function normalizeTypeDefaults(
  models: PretrainedModelConfig[],
  type: PretrainedModelType,
): void {
  const list = models.filter((m) => m.modelType === type);
  const enabledDefaults = list.filter((m) => m.enabled && m.isDefault);
  if (enabledDefaults.length === 1) return;

  const pick = enabledDefaults[0] ?? list.find((m) => m.enabled) ?? list[0];
  if (!pick) return;

  for (const model of list) {
    model.isDefault = model.id === pick.id;
  }
}

function normalizeKeypointDefaults(models: PretrainedModelConfig[]): void {
  const templateIds = new Set<string>();
  for (const model of models) {
    if (model.modelType !== 'keypoint_estimation') continue;
    for (const tid of model.keypointTemplateIds ?? []) {
      templateIds.add(tid);
    }
  }

  for (const templateId of templateIds) {
    const candidates = models.filter(
      (m) =>
        m.modelType === 'keypoint_estimation' &&
        m.keypointTemplateIds?.includes(templateId),
    );
    if (candidates.length === 0) continue;

    const enabledDefaults = candidates.filter((m) => m.enabled && m.isDefault);
    if (enabledDefaults.length === 1) continue;

    const pick =
      enabledDefaults[0] ?? candidates.find((m) => m.enabled) ?? candidates[0];

    for (const model of candidates) {
      if (model.id === pick.id) {
        model.isDefault = true;
      } else if (enabledDefaults.length > 1 || enabledDefaults.length === 0) {
        model.isDefault = false;
      }
    }
  }
}

export function normalizeModelsOnSave(
  models: PretrainedModelConfig[],
  changed?: PretrainedModelConfig,
): PretrainedModelConfig[] {
  const next = models.map((m) => ({ ...m }));

  if (changed?.isDefault) {
    if (changed.modelType === 'keypoint_estimation') {
      const templateIds = changed.keypointTemplateIds ?? [];
      for (const model of next) {
        if (model.id === changed.id) continue;
        if (model.modelType !== 'keypoint_estimation') continue;
        const overlaps = model.keypointTemplateIds?.some((tid) =>
          templateIds.includes(tid),
        );
        if (overlaps) model.isDefault = false;
      }
    } else {
      for (const model of next) {
        if (model.modelType === changed.modelType && model.id !== changed.id) {
          model.isDefault = false;
        }
      }
    }
  }

  normalizeTypeDefaults(next, 'object_detection');
  normalizeTypeDefaults(next, 'image_segmentation');
  normalizeKeypointDefaults(next);

  return next;
}

export function templatesOverlap(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (!a?.length || !b?.length) return false;
  return a.some((tid) => b.includes(tid));
}
