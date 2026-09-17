import type { AnnotationInstance } from '../types/annotationDocument';

export interface AnnotationHistorySnapshot {
  annotations: AnnotationInstance[];
  selectedAnnotationId: string | null;
}

const MAX_UNDO_STEPS = 50;

export function cloneAnnotationHistorySnapshot(
  snapshot: AnnotationHistorySnapshot,
): AnnotationHistorySnapshot {
  return {
    annotations: structuredClone(snapshot.annotations),
    selectedAnnotationId: snapshot.selectedAnnotationId,
  };
}

export class AnnotationHistory {
  private undoStack: AnnotationHistorySnapshot[] = [];

  private redoStack: AnnotationHistorySnapshot[] = [];

  private batchDepth = 0;

  private batchStartSnapshot: AnnotationHistorySnapshot | null = null;

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.batchDepth = 0;
    this.batchStartSnapshot = null;
  }

  isBatching(): boolean {
    return this.batchDepth > 0;
  }

  /** Remember state at gesture start; pushed to undo stack on endBatch. */
  beginBatch(snapshot: AnnotationHistorySnapshot): void {
    if (this.batchDepth === 0) {
      this.batchStartSnapshot = cloneAnnotationHistorySnapshot(snapshot);
    }
    this.batchDepth += 1;
  }

  endBatch(): void {
    if (this.batchDepth <= 0) return;
    this.batchDepth -= 1;
    if (this.batchDepth === 0 && this.batchStartSnapshot) {
      this.record(this.batchStartSnapshot);
      this.batchStartSnapshot = null;
    }
  }

  /** Push pre-mutation snapshot onto undo stack. */
  record(snapshot: AnnotationHistorySnapshot): void {
    if (this.batchDepth > 0) return;
    this.undoStack.push(cloneAnnotationHistorySnapshot(snapshot));
    if (this.undoStack.length > MAX_UNDO_STEPS) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(current: AnnotationHistorySnapshot): AnnotationHistorySnapshot | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(cloneAnnotationHistorySnapshot(current));
    return prev;
  }

  redo(current: AnnotationHistorySnapshot): AnnotationHistorySnapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(cloneAnnotationHistorySnapshot(current));
    return next;
  }
}
