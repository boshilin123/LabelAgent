/** Shared label helpers (main + renderer). */

export function isUnlabeledLabelId(labelId: unknown): boolean {
  if (labelId === null || labelId === undefined) return true;
  if (typeof labelId === 'string' && labelId.trim() === '') return true;
  return false;
}

/** Training exports skip explicitly unlabeled annotations only. */
export function shouldSkipForTrainingExport(labelId: unknown): boolean {
  return isUnlabeledLabelId(labelId);
}
