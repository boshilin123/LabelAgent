import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  AnnotationProject,
  CreateAnnotationProjectInput,
  UpdateAnnotationProjectInput,
} from '../types/annotation';
import {
  createAnnotationProject,
  deleteAnnotationProjectRecord,
  loadAnnotationProjects,
  touchAnnotationProject,
  updateAnnotationProject,
  validateProjectDirectory,
} from '../services/annotationProjectStore';
import { useApp } from './AppContext';
import { useToast } from './ToastContext';
import { setWorkModeExternal } from './workModeBridge';

const STORAGE_KEYS = {
  lastAnnotationProjectId: 'lr-agent:lastAnnotationProjectId',
};

interface AnnotationContextValue {
  projects: AnnotationProject[];
  activeProject: AnnotationProject | null;
  loading: boolean;
  createWizardOpen: boolean;
  editingProject: AnnotationProject | null;
  exportingProject: AnnotationProject | null;
  memoryProject: AnnotationProject | null;
  openCreateWizard: () => void;
  closeCreateWizard: () => void;
  openEditProject: (project: AnnotationProject) => void;
  closeEditProject: () => void;
  openExportProject: (project: AnnotationProject) => void;
  closeExportProject: () => void;
  openWorkspaceMemory: (project: AnnotationProject) => void;
  closeWorkspaceMemory: () => void;
  refreshProjects: () => Promise<void>;
  createProject: (
    input: CreateAnnotationProjectInput,
  ) => Promise<AnnotationProject>;
  updateProject: (
    projectId: string,
    input: UpdateAnnotationProjectInput,
    options?: { silent?: boolean },
  ) => Promise<AnnotationProject>;
  openProject: (projectId: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  clearActiveProject: () => void;
  showProjectInFolder: (project: AnnotationProject) => void;
}

const AnnotationContext = createContext<AnnotationContextValue | null>(null);

export function AnnotationProvider({ children }: { children: ReactNode }) {
  const { openFolder } = useApp();
  const { showToast } = useToast();

  const [projects, setProjects] = useState<AnnotationProject[]>([]);
  const [activeProject, setActiveProject] = useState<AnnotationProject | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [createWizardOpen, setCreateWizardOpen] = useState(false);
  const [editingProject, setEditingProject] =
    useState<AnnotationProject | null>(null);
  const [exportingProject, setExportingProject] =
    useState<AnnotationProject | null>(null);
  const [memoryProject, setMemoryProject] = useState<AnnotationProject | null>(
    null,
  );

  const refreshProjects = useCallback(async () => {
    const list = await loadAnnotationProjects();
    setProjects(list);
    setActiveProject((current) => {
      if (!current) return null;
      return list.find((item) => item.id === current.id) ?? null;
    });
    setMemoryProject((current) => {
      if (!current) return null;
      return list.find((item) => item.id === current.id) ?? current;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      setLoading(true);
      try {
        const list = await loadAnnotationProjects();
        if (cancelled) return;
        setProjects(list);

        const lastId = localStorage.getItem(
          STORAGE_KEYS.lastAnnotationProjectId,
        );
        if (!lastId) return;

        const lastProject = list.find((item) => item.id === lastId);
        if (!lastProject) return;

        const valid = await validateProjectDirectory(lastProject.directoryPath);
        if (!valid || cancelled) return;

        setActiveProject(lastProject);
        setWorkModeExternal('annotation', { silent: true });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    init().catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const openCreateWizard = useCallback(() => {
    setCreateWizardOpen(true);
  }, []);

  const closeCreateWizard = useCallback(() => {
    setCreateWizardOpen(false);
  }, []);

  const openEditProject = useCallback((project: AnnotationProject) => {
    setEditingProject(project);
  }, []);

  const closeEditProject = useCallback(() => {
    setEditingProject(null);
  }, []);

  const openExportProject = useCallback((project: AnnotationProject) => {
    setExportingProject(project);
  }, []);

  const closeExportProject = useCallback(() => {
    setExportingProject(null);
  }, []);

  const openWorkspaceMemory = useCallback((project: AnnotationProject) => {
    setMemoryProject(project);
  }, []);

  const closeWorkspaceMemory = useCallback(() => {
    setMemoryProject(null);
  }, []);

  const createProject = useCallback(
    async (input: CreateAnnotationProjectInput) => {
      const valid = await validateProjectDirectory(input.directoryPath);
      if (!valid) {
        throw new Error('所选目录不存在或无法访问');
      }

      const project = await createAnnotationProject(input);
      await refreshProjects();
      return project;
    },
    [refreshProjects],
  );

  const updateProject = useCallback(
    async (
      projectId: string,
      input: UpdateAnnotationProjectInput,
      options?: { silent?: boolean },
    ) => {
      if (!input.name.trim()) {
        throw new Error('任务名称不能为空');
      }

      const updated = await updateAnnotationProject(projectId, input);
      if (!updated) {
        throw new Error('标注任务不存在或已被删除');
      }

      await refreshProjects();
      setActiveProject((current) =>
        current?.id === projectId ? updated : current,
      );
      setEditingProject((current) =>
        current?.id === projectId ? updated : current,
      );
      setMemoryProject((current) =>
        current?.id === projectId ? updated : current,
      );
      if (!options?.silent) {
        showToast(`已更新标注任务「${updated.name}」`, { type: 'success' });
      }
      return updated;
    },
    [refreshProjects, showToast],
  );

  const openProject = useCallback(
    async (projectId: string) => {
      let project = projects.find((item) => item.id === projectId);
      if (!project) {
        const list = await loadAnnotationProjects();
        project = list.find((item) => item.id === projectId);
        if (project) {
          setProjects(list);
        }
      }
      if (!project) {
        showToast('标注任务不存在或已被删除', { type: 'error' });
        await refreshProjects();
        return;
      }

      const valid = await validateProjectDirectory(project.directoryPath);
      if (!valid) {
        showToast('项目目录不存在，请检查路径或重新绑定', { type: 'error' });
        return;
      }

      const updated = await touchAnnotationProject(projectId);
      const nextProject = updated ?? project;

      await openFolder(project.directoryPath);
      setActiveProject(nextProject);
      setWorkModeExternal('annotation');
      localStorage.setItem(STORAGE_KEYS.lastAnnotationProjectId, projectId);
      await refreshProjects();
      showToast(`已打开标注任务「${nextProject.name}」`, { type: 'success' });
    },
    [projects, openFolder, refreshProjects, showToast],
  );

  const deleteProject = useCallback(
    async (projectId: string) => {
      const removed = await deleteAnnotationProjectRecord(projectId);
      if (!removed) {
        showToast('删除失败，任务可能已不存在', { type: 'error' });
        await refreshProjects();
        return;
      }

      if (activeProject?.id === projectId) {
        setActiveProject(null);
        setWorkModeExternal('editor', { silent: true });
        localStorage.removeItem(STORAGE_KEYS.lastAnnotationProjectId);
      }
      if (memoryProject?.id === projectId) {
        setMemoryProject(null);
      }

      await refreshProjects();
      showToast(`已删除标注任务「${removed.name}」`, { type: 'success' });
    },
    [activeProject, memoryProject, refreshProjects, showToast],
  );

  const clearActiveProject = useCallback(() => {
    setActiveProject(null);
    setWorkModeExternal('editor', { silent: true });
    localStorage.removeItem(STORAGE_KEYS.lastAnnotationProjectId);
  }, []);

  const showProjectInFolder = useCallback((project: AnnotationProject) => {
    window.electron.annotation.showItemInFolder(project.directoryPath);
  }, []);

  const value = useMemo<AnnotationContextValue>(
    () => ({
      projects,
      activeProject,
      loading,
      createWizardOpen,
      editingProject,
      exportingProject,
      memoryProject,
      openCreateWizard,
      closeCreateWizard,
      openEditProject,
      closeEditProject,
      openExportProject,
      closeExportProject,
      openWorkspaceMemory,
      closeWorkspaceMemory,
      refreshProjects,
      createProject,
      updateProject,
      openProject,
      deleteProject,
      clearActiveProject,
      showProjectInFolder,
    }),
    [
      projects,
      activeProject,
      loading,
      createWizardOpen,
      editingProject,
      exportingProject,
      memoryProject,
      openCreateWizard,
      closeCreateWizard,
      openEditProject,
      closeEditProject,
      openExportProject,
      closeExportProject,
      openWorkspaceMemory,
      closeWorkspaceMemory,
      refreshProjects,
      createProject,
      updateProject,
      openProject,
      deleteProject,
      clearActiveProject,
      showProjectInFolder,
    ],
  );

  return (
    <AnnotationContext.Provider value={value}>
      {children}
    </AnnotationContext.Provider>
  );
}

export function useAnnotation(): AnnotationContextValue {
  const ctx = useContext(AnnotationContext);
  if (!ctx) {
    throw new Error('useAnnotation must be used within AnnotationProvider');
  }
  return ctx;
}
