import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAnnotation } from './AnnotationContext';
import { useToast } from './ToastContext';
import { workModeControllerRef, workModeStateRef } from './workModeBridge';
import type { SetWorkModeOptions, WorkMode } from './workModeTypes';
import { readStoredWorkMode } from './workModeStorage';

export type { SetWorkModeOptions, WorkMode } from './workModeTypes';
export { setWorkModeExternal } from './workModeBridge';

const STORAGE_KEY = 'lr-agent:workMode';

function workModeToastMessage(mode: WorkMode): string {
  return mode === 'editor' ? '已切换到编辑器模式' : '已切换到标注模式';
}

interface WorkModeContextValue {
  workMode: WorkMode;
  setWorkMode: (mode: WorkMode, options?: SetWorkModeOptions) => void;
  trySetWorkMode: (mode: WorkMode) => boolean;
  toggleWorkMode: () => void;
}

const WorkModeContext = createContext<WorkModeContextValue | null>(null);

export function WorkModeProvider({ children }: { children: ReactNode }) {
  const { activeProject } = useAnnotation();
  const { showToast } = useToast();
  const [workMode, setWorkModeState] = useState<WorkMode>(() => {
    const mode = readStoredWorkMode();
    workModeStateRef.current = mode;
    return mode;
  });
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  const setWorkMode = useCallback(
    (mode: WorkMode, options?: SetWorkModeOptions) => {
      if (workModeStateRef.current === mode) return;

      workModeStateRef.current = mode;
      setWorkModeState(mode);
      localStorage.setItem(STORAGE_KEY, mode);

      if (!options?.silent) {
        showToast(workModeToastMessage(mode), { type: 'success' });
      }
    },
    [showToast],
  );

  useEffect(() => {
    workModeStateRef.current = workMode;
  }, [workMode]);

  const trySetWorkMode = useCallback(
    (mode: WorkMode): boolean => {
      if (mode === 'annotation' && !activeProjectRef.current) {
        showToast('请先打开或创建标注任务', { type: 'info' });
        return false;
      }
      setWorkMode(mode);
      return true;
    },
    [setWorkMode, showToast],
  );

  const toggleWorkMode = useCallback(() => {
    if (workMode === 'editor') {
      trySetWorkMode('annotation');
      return;
    }
    setWorkMode('editor');
  }, [workMode, setWorkMode, trySetWorkMode]);

  useEffect(() => {
    workModeControllerRef.current = { setWorkMode, trySetWorkMode };
    return () => {
      workModeControllerRef.current = null;
    };
  }, [setWorkMode, trySetWorkMode]);

  useEffect(() => {
    if (workMode === 'annotation' && !activeProject) {
      setWorkMode('editor', { silent: true });
    }
  }, [workMode, activeProject, setWorkMode]);

  const value = useMemo<WorkModeContextValue>(
    () => ({
      workMode,
      setWorkMode,
      trySetWorkMode,
      toggleWorkMode,
    }),
    [workMode, setWorkMode, trySetWorkMode, toggleWorkMode],
  );

  return (
    <WorkModeContext.Provider value={value}>
      {children}
    </WorkModeContext.Provider>
  );
}

export function useWorkMode(): WorkModeContextValue {
  const ctx = useContext(WorkModeContext);
  if (!ctx) {
    throw new Error('useWorkMode must be used within WorkModeProvider');
  }
  return ctx;
}
