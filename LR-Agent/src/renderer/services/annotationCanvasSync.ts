import type {
  AnnotationInstance,
  FileAnnotationDocument,
} from '../types/annotationDocument';

export type CanvasApplyDecision =
  | { action: 'skip' }
  | { action: 'clear' }
  | { action: 'replace'; annotations: AnnotationInstance[] };

/** Decide how the open canvas should react after an external apply/rollback. */
export function decideCanvasAfterExternalApply(options: {
  parsed: FileAnnotationDocument | null;
  dirty: boolean;
  force: boolean;
}): CanvasApplyDecision {
  if (options.dirty && !options.force) {
    return { action: 'skip' };
  }
  if (!options.parsed) {
    return { action: 'clear' };
  }
  return { action: 'replace', annotations: options.parsed.annotations };
}
