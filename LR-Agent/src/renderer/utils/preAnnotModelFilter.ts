import type { ImageAnnotationType } from '../types/annotation';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import { inferDetectionMode } from '../../shared/preAnnotTypes';

export function getEligiblePreAnnotModels(
  annotationType: ImageAnnotationType,
  models: PretrainedModelConfig[],
  activeTemplateId?: string,
): PretrainedModelConfig[] {
  const enabled = models.filter((m) => m.enabled);

  switch (annotationType) {
    case 'bbox':
      return enabled.filter(
        (m) =>
          m.modelType === 'object_detection' &&
          inferDetectionMode(m) === 'detect',
      );
    case 'rotated_bbox':
      return enabled.filter(
        (m) =>
          m.modelType === 'object_detection' && inferDetectionMode(m) === 'obb',
      );
    case 'polygon':
      return enabled.filter((m) => m.modelType === 'image_segmentation');
    case 'keypoint':
      return enabled.filter(
        (m) =>
          m.modelType === 'keypoint_estimation' &&
          (!activeTemplateId ||
            m.keypointTemplateIds?.includes(activeTemplateId)),
      );
    default:
      return [];
  }
}

export function pickDefaultPreAnnotModel(
  annotationType: ImageAnnotationType,
  models: PretrainedModelConfig[],
  activeTemplateId?: string,
): PretrainedModelConfig | null {
  const eligible = getEligiblePreAnnotModels(
    annotationType,
    models,
    activeTemplateId,
  );
  if (eligible.length === 0) return null;
  return eligible.find((m) => m.isDefault) ?? eligible[0];
}

const STORAGE_PREFIX = 'lr-agent-preannot-model:';

export function loadSavedPreAnnotModelId(projectId: string): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
  } catch {
    return null;
  }
}

export function savePreAnnotModelId(projectId: string, modelId: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, modelId);
  } catch {
    // ignore quota errors
  }
}
