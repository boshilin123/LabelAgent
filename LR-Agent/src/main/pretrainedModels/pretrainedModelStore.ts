import path from 'path';
import fs from 'fs-extra';
import { app } from 'electron';
import {
  KEYPOINT_BACKEND_PRESETS,
  REGISTRY_VERSION,
  type KeypointAssetScanResult,
  type KeypointBackend,
  type KeypointBundleScanResult,
  type PretrainedModelConfig,
  type PretrainedModelType,
  type PretrainedModelValidationResult,
  type Sam2ScanResult,
} from '../../shared/pretrainedModelTypes';

export type {
  KeypointAssetScanResult,
  KeypointAuxiliaryPaths,
  KeypointBackend,
  KeypointBundleScanResult,
  PretrainedModelConfig,
  PretrainedModelParams,
  PretrainedModelType,
  PretrainedModelValidationResult,
  Sam2ScanResult,
} from '../../shared/pretrainedModelTypes';

interface RegistryFile {
  version: number;
  models: PretrainedModelConfig[];
}

const SAM2_VARIANTS: Array<{
  key: string;
  label: string;
  configFile: string;
  checkpointHints: string[];
}> = [
  {
    key: 'tiny',
    label: 'Tiny',
    configFile: 'sam2.1_hiera_t.yaml',
    checkpointHints: ['tiny', '_t.pt', '_t_'],
  },
  {
    key: 'small',
    label: 'Small',
    configFile: 'sam2.1_hiera_s.yaml',
    checkpointHints: ['small', '_s.pt', '_s_'],
  },
  {
    key: 'base_plus',
    label: 'Base+',
    configFile: 'sam2.1_hiera_b+.yaml',
    checkpointHints: ['base_plus', 'b+', 'base-plus'],
  },
  {
    key: 'large',
    label: 'Large',
    configFile: 'sam2.1_hiera_l.yaml',
    checkpointHints: ['large', '_l.pt', '_l_'],
  },
];

const FAN_CHECKPOINT_HINTS = ['2dfan', '2dfan4'];
const S3FD_CHECKPOINT_HINTS = ['s3fd'];

function getRegistryPath(): string {
  return path.join(app.getPath('userData'), 'pretrained-models.json');
}

async function readRegistry(): Promise<RegistryFile> {
  const registryPath = getRegistryPath();
  try {
    if (!(await fs.pathExists(registryPath))) {
      return { version: REGISTRY_VERSION, models: [] };
    }
    const data = await fs.readJson(registryPath);
    if (!data || typeof data !== 'object' || !Array.isArray(data.models)) {
      return { version: REGISTRY_VERSION, models: [] };
    }
    return {
      version: REGISTRY_VERSION,
      models: data.models as PretrainedModelConfig[],
    };
  } catch {
    return { version: REGISTRY_VERSION, models: [] };
  }
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

function normalizeDefaultFlags(
  models: PretrainedModelConfig[],
): PretrainedModelConfig[] {
  normalizeTypeDefaults(models, 'object_detection');
  normalizeTypeDefaults(models, 'image_segmentation');
  normalizeKeypointDefaults(models);
  return models;
}

export async function getPretrainedModels(): Promise<PretrainedModelConfig[]> {
  const registry = await readRegistry();
  return registry.models;
}

export async function savePretrainedModels(
  models: PretrainedModelConfig[],
): Promise<void> {
  const normalized = normalizeDefaultFlags(models.map((m) => ({ ...m })));
  const registryPath = getRegistryPath();
  await fs.ensureDir(path.dirname(registryPath));
  await fs.writeJson(
    registryPath,
    { version: REGISTRY_VERSION, models: normalized },
    { spaces: 2 },
  );
}

function matchSam2Variant(
  checkpointName: string,
): (typeof SAM2_VARIANTS)[number] | null {
  const lower = checkpointName.toLowerCase();
  for (const variant of SAM2_VARIANTS) {
    if (variant.checkpointHints.some((hint) => lower.includes(hint))) {
      return variant;
    }
  }
  return null;
}

function matchesHint(name: string, hints: string[]): boolean {
  const lower = name.toLowerCase();
  return hints.some((hint) => lower.includes(hint));
}

async function findFileRecursive(
  rootDir: string,
  predicate: (name: string) => boolean,
): Promise<string | null> {
  if (!(await fs.pathExists(rootDir))) return null;

  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && predicate(entry.name)) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = await findFileRecursive(fullPath, predicate);
      if (nested) return nested;
    }
  }
  return null;
}

async function findYoloPoseCheckpoint(rootDir: string): Promise<string | null> {
  const yoloDir = path.join(rootDir, 'yolo');
  if (await fs.pathExists(yoloDir)) {
    const files = await fs.readdir(yoloDir);
    const match = files.find(
      (name) => name.endsWith('.pt') && /pose/i.test(name),
    );
    if (match) return path.join(yoloDir, match);
  }

  return findFileRecursive(
    rootDir,
    (name) => name.endsWith('.pt') && /pose/i.test(name),
  );
}

async function findMediapipeHandTask(rootDir: string): Promise<string | null> {
  const mediapipeDir = path.join(rootDir, 'mediapipe');
  if (await fs.pathExists(mediapipeDir)) {
    const files = await fs.readdir(mediapipeDir);
    const match = files.find(
      (name) => name.endsWith('.task') && /hand/i.test(name),
    );
    if (match) return path.join(mediapipeDir, match);
  }

  return findFileRecursive(
    rootDir,
    (name) => name.endsWith('.task') && /hand/i.test(name),
  );
}

async function findFaceAlignmentAssets(rootDir: string): Promise<{
  fanPath: string | null;
  detectorPath: string | null;
  torchHome: string;
}> {
  const resolved = path.resolve(rootDir);
  const fanPath = await findFileRecursive(resolved, (name) =>
    matchesHint(name, FAN_CHECKPOINT_HINTS),
  );
  const detectorPath = await findFileRecursive(resolved, (name) =>
    matchesHint(name, S3FD_CHECKPOINT_HINTS),
  );

  return {
    fanPath,
    detectorPath,
    torchHome: resolved,
  };
}

export async function scanFaceAlignmentDirectory(
  rootDir: string,
): Promise<KeypointAssetScanResult | null> {
  const { fanPath, detectorPath, torchHome } =
    await findFaceAlignmentAssets(rootDir);
  if (!fanPath || !detectorPath) return null;

  const preset = KEYPOINT_BACKEND_PRESETS.face_alignment;
  return {
    backend: 'face_alignment',
    name: preset.label,
    checkpointPath: fanPath,
    keypointTemplateIds: [...preset.defaultTemplateIds],
    auxiliaryPaths: {
      detector: detectorPath,
      torchHome,
    },
  };
}

export async function scanKeypointBundleDirectory(
  rootDir: string,
): Promise<KeypointBundleScanResult> {
  const models: KeypointAssetScanResult[] = [];

  const posePath = await findYoloPoseCheckpoint(rootDir);
  if (posePath) {
    const preset = KEYPOINT_BACKEND_PRESETS.yolo_pose;
    models.push({
      backend: 'yolo_pose',
      name: preset.label,
      checkpointPath: posePath,
      keypointTemplateIds: [...preset.defaultTemplateIds],
    });
  }

  const handPath = await findMediapipeHandTask(rootDir);
  if (handPath) {
    const preset = KEYPOINT_BACKEND_PRESETS.mediapipe_hand;
    models.push({
      backend: 'mediapipe_hand',
      name: preset.label,
      checkpointPath: handPath,
      keypointTemplateIds: [...preset.defaultTemplateIds],
    });
  }

  const face = await scanFaceAlignmentDirectory(
    path.join(rootDir, 'face_alignment'),
  );
  if (face) {
    models.push(face);
  } else {
    const faceRoot = await scanFaceAlignmentDirectory(rootDir);
    if (faceRoot) models.push(faceRoot);
  }

  return { models };
}

export async function scanSam2Directory(
  rootDir: string,
): Promise<Sam2ScanResult[]> {
  const resolvedRoot = path.resolve(rootDir);
  if (!(await fs.pathExists(resolvedRoot))) {
    return [];
  }

  const configDir = path.join(resolvedRoot, 'configs', 'sam2.1');
  const checkpointDir = path.join(resolvedRoot, 'checkpoints');

  const configExists = await fs.pathExists(configDir);
  const checkpointExists = await fs.pathExists(checkpointDir);
  if (!configExists || !checkpointExists) {
    return [];
  }

  const configFiles = (await fs.readdir(configDir)).filter((name) =>
    name.endsWith('.yaml'),
  );
  const checkpointFiles = (await fs.readdir(checkpointDir)).filter((name) =>
    name.endsWith('.pt'),
  );

  const results: Sam2ScanResult[] = [];

  for (const checkpointFile of checkpointFiles) {
    const variant = matchSam2Variant(checkpointFile);
    if (!variant) continue;

    const { configFile } = variant;
    if (!configFiles.includes(configFile)) continue;

    results.push({
      variant: variant.key,
      name: `SAM2.1 ${variant.label}`,
      checkpointPath: path.join(checkpointDir, checkpointFile),
      configPath: path.join(configDir, configFile),
    });
  }

  return results;
}

export async function validatePretrainedModel(
  model: Pick<
    PretrainedModelConfig,
    | 'modelType'
    | 'checkpointPath'
    | 'configPath'
    | 'keypointBackend'
    | 'keypointTemplateIds'
    | 'auxiliaryPaths'
  >,
): Promise<PretrainedModelValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const checkpointPath = model.checkpointPath?.trim();

  if (model.modelType === 'keypoint_estimation') {
    if (!model.keypointBackend) {
      errors.push('请选择关键点后端');
    }
    if (!model.keypointTemplateIds?.length) {
      errors.push('至少绑定一个骨架模板');
    }
  }

  if (!checkpointPath) {
    errors.push('请指定权重文件路径');
  } else if (!(await fs.pathExists(checkpointPath))) {
    errors.push(`权重文件不存在：${checkpointPath}`);
  } else if (model.modelType === 'object_detection') {
    if (!checkpointPath.toLowerCase().endsWith('.pt')) {
      warnings.push('权重文件扩展名不是 .pt');
    }
  } else if (model.modelType === 'keypoint_estimation') {
    const backend = model.keypointBackend;
    if (backend === 'yolo_pose') {
      if (!checkpointPath.toLowerCase().endsWith('.pt')) {
        warnings.push('YOLO-Pose 权重扩展名通常为 .pt');
      }
      if (!/pose/i.test(path.basename(checkpointPath))) {
        warnings.push('文件名不含 pose，可能不是姿态权重');
      }
    } else if (backend === 'mediapipe_hand') {
      if (!checkpointPath.toLowerCase().endsWith('.task')) {
        errors.push('MediaPipe Hand 需要 .task 文件');
      }
    } else if (backend === 'face_alignment') {
      const lower = checkpointPath.toLowerCase();
      if (!lower.endsWith('.pth') && !lower.endsWith('.tar')) {
        warnings.push('face-alignment 主权重通常为 .pth 或 .pth.tar');
      }
      const detector = model.auxiliaryPaths?.detector?.trim();
      if (!detector) {
        errors.push('face-alignment 需要指定人脸检测器路径');
      } else if (!(await fs.pathExists(detector))) {
        errors.push(`检测器文件不存在：${detector}`);
      }
    }

    if (backend && model.keypointTemplateIds?.length) {
      const allowed = KEYPOINT_BACKEND_PRESETS[backend].defaultTemplateIds;
      const foreign = model.keypointTemplateIds.filter(
        (tid) => !allowed.includes(tid),
      );
      if (foreign.length > 0) {
        warnings.push(
          `模板 ${foreign.join(', ')} 与后端 ${backend} 可能不兼容`,
        );
      }
    }
  } else if (!checkpointPath.toLowerCase().endsWith('.pt')) {
    warnings.push('权重文件扩展名不是 .pt');
  }

  if (model.modelType === 'image_segmentation') {
    const configPath = model.configPath?.trim();
    if (!configPath) {
      errors.push('SAM2 需要指定配置文件路径（.yaml）');
    } else if (!(await fs.pathExists(configPath))) {
      errors.push(`配置文件不存在：${configPath}`);
    } else if (!configPath.toLowerCase().endsWith('.yaml')) {
      warnings.push('配置文件扩展名不是 .yaml');
    }

    if (
      checkpointPath &&
      configPath &&
      (await fs.pathExists(checkpointPath)) &&
      (await fs.pathExists(configPath))
    ) {
      const ckptVariant = matchSam2Variant(path.basename(checkpointPath));
      const cfgVariant = SAM2_VARIANTS.find((v) =>
        path.basename(configPath).includes(v.configFile.replace('.yaml', '')),
      );
      if (ckptVariant && cfgVariant && ckptVariant.key !== cfgVariant.key) {
        warnings.push(
          `权重变体（${ckptVariant.label}）与配置变体（${cfgVariant.label}）可能不匹配`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
