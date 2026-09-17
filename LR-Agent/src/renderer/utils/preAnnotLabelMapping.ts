import type { LabelDefinition } from '../types/annotation';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import { resolveLabelIdForTemplate } from '../types/keypointTemplate';
import type { KeypointTemplate } from '../types/keypointTemplate';

export function resolveLabelIdByClassName(
  className: string,
  labels: LabelDefinition[],
  model: PretrainedModelConfig,
): string | null {
  const mapped = model.labelMapping?.[className];
  if (mapped && labels.some((l) => l.id === mapped)) {
    return mapped;
  }

  const key = className.trim().toLowerCase();
  if (!key) return null;
  const match = labels.find((l) => l.name.trim().toLowerCase() === key);
  return match?.id ?? null;
}

export function resolveLabelIdForPoseTemplate(
  template: KeypointTemplate,
  labels: LabelDefinition[],
): string | null {
  return resolveLabelIdForTemplate(template, labels);
}
