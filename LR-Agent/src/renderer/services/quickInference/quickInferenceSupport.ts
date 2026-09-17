import type { LlmProviderConfig } from '../../../shared/agentTypes';
import type {
  AnnotationProject,
  AnnotationType,
  ImageAnnotationType,
} from '../../types/annotation';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { pickDefaultPreAnnotModel } from '../../utils/preAnnotModelFilter';

const SUPPORTED_TYPES = new Set<AnnotationType>([
  'caption',
  'classification',
  'instruction',
  'cot',
  'conversation',
  'preference',
  'bbox',
  'rotated_bbox',
  'polygon',
  'keypoint',
  'span_ner',
  'text_classification',
]);

const VISION_REQUIRED_TYPES = new Set<AnnotationType>([
  'caption',
  'classification',
]);

const PREANNOT_REQUIRED_TYPES = new Set<ImageAnnotationType>([
  'bbox',
  'rotated_bbox',
  'polygon',
  'keypoint',
]);

export function isQuickInferenceSupported(
  annotationType: AnnotationType,
): boolean {
  return SUPPORTED_TYPES.has(annotationType);
}

export function getQuickInferenceUnsupportedReason(
  annotationType: AnnotationType,
): string | null {
  if (isQuickInferenceSupported(annotationType)) return null;
  return '当前标注类型暂不支持快捷推理';
}

export function requiresVisionForQuickInference(
  annotationType: AnnotationType,
): boolean {
  return VISION_REQUIRED_TYPES.has(annotationType);
}

export interface QuickInferenceReadinessInput {
  annotationModeActive: boolean;
  project: AnnotationProject | null;
  projectRootMatched: boolean;
  relativeFilePath: string | null;
  provider: LlmProviderConfig | null;
  detectionModels: PretrainedModelConfig[];
  keypointTemplateId?: string | null;
  running: boolean;
}

function preAnnotReadinessReason(
  annotationType: ImageAnnotationType,
  models: PretrainedModelConfig[],
  keypointTemplateId?: string | null,
): string | null {
  if (annotationType === 'polygon') {
    if (!pickDefaultPreAnnotModel('polygon', models)) {
      return '多边形快捷推理需配置 SAM2 分割预训练模型';
    }
    if (!pickDefaultPreAnnotModel('bbox', models)) {
      return '多边形快捷推理需配置目标检测预训练模型';
    }
    return null;
  }
  if (annotationType === 'keypoint') {
    if (!keypointTemplateId) {
      return '关键点快捷推理需先在画布选择骨架模板';
    }
    if (!pickDefaultPreAnnotModel('keypoint', models, keypointTemplateId)) {
      return '关键点快捷推理需配置可用的关键点预训练模型';
    }
    return null;
  }
  const model = pickDefaultPreAnnotModel(
    annotationType,
    models,
    keypointTemplateId ?? undefined,
  );
  if (!model) {
    return `${annotationType} 快捷推理需配置可用的预训练模型`;
  }
  return null;
}

export function evaluateQuickInferenceReadiness(
  input: QuickInferenceReadinessInput,
): { canRun: boolean; disabledReason: string | null } {
  const reasons: string[] = [];

  if (!input.annotationModeActive) {
    reasons.push('请在标注模式下使用快捷推理');
  }
  if (!input.project) {
    reasons.push('请先打开标注项目');
  } else if (!input.projectRootMatched) {
    reasons.push('工作区根目录须与标注项目目录一致');
  } else if (!isQuickInferenceSupported(input.project.annotationType)) {
    const unsupported = getQuickInferenceUnsupportedReason(
      input.project.annotationType,
    );
    if (unsupported) reasons.push(unsupported);
  }
  if (!input.relativeFilePath) {
    reasons.push('请先打开要标注的文件');
  }
  if (!input.provider) {
    reasons.push('请先选择并启用大模型 Provider');
  } else if (
    input.project &&
    requiresVisionForQuickInference(input.project.annotationType) &&
    !input.provider.supportsVision
  ) {
    reasons.push('当前任务需要支持视觉的大模型');
  }
  if (
    input.project &&
    PREANNOT_REQUIRED_TYPES.has(
      input.project.annotationType as ImageAnnotationType,
    )
  ) {
    const modelReason = preAnnotReadinessReason(
      input.project.annotationType as ImageAnnotationType,
      input.detectionModels,
      input.keypointTemplateId,
    );
    if (modelReason) reasons.push(modelReason);
  }
  if (input.running) {
    reasons.push('正在生成中…');
  }

  const disabledReason = reasons[0] ?? null;
  return { canRun: reasons.length === 0, disabledReason };
}
