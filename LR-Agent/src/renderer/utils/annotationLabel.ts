import type { LabelDefinition } from '../types/annotation';
import {
  isUnlabeledLabelId,
  shouldSkipForTrainingExport,
} from '../../shared/annotationLabel';

export type AnnotationLabelState = 'labeled' | 'unlabeled' | 'orphaned';

export function isUnlabeled(labelId: string | null | undefined): boolean {
  return isUnlabeledLabelId(labelId);
}

export { shouldSkipForTrainingExport };

export function getAnnotationLabelState(
  labelId: string | null | undefined,
  labels: LabelDefinition[],
): AnnotationLabelState {
  if (isUnlabeled(labelId)) return 'unlabeled';
  return labels.some((l) => l.id === labelId) ? 'labeled' : 'orphaned';
}

export function parseStoredLabelId(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
