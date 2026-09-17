import type { SetWorkModeOptions, WorkMode } from './workModeTypes';

export type { SetWorkModeOptions, WorkMode };

interface WorkModeController {
  setWorkMode: (mode: WorkMode, options?: SetWorkModeOptions) => void;
  trySetWorkMode: (mode: WorkMode) => boolean;
}

/** Allows AnnotationContext to switch work mode without circular provider nesting. */
export const workModeControllerRef: { current: WorkModeController | null } = {
  current: null,
};

export const workModeStateRef: { current: WorkMode } = { current: 'editor' };

export function setWorkModeExternal(
  mode: WorkMode,
  options?: SetWorkModeOptions,
): void {
  workModeControllerRef.current?.setWorkMode(mode, options);
}

export function getWorkModeExternal(): WorkMode {
  return workModeStateRef.current;
}
