import { useCallback, useEffect, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import { useAnnotation } from '../../context/AnnotationContext';
import { useToast } from '../../context/ToastContext';
import {
  computeMemoryScopeKey,
  getMemoryOpenTarget,
  listMemoryEntries,
  memoryOpenErrorMessage,
  openMemoryFile,
  setMemoryOpenTarget,
  type MemoryEntry,
  type MemoryOpenTarget,
} from '../../services/agentMemory';
import { syncWorkspaceFactMemory } from '../../services/workspaceFactMemory';
import type { AnnotationProject } from '../../types/annotation';
import WorkspaceMemoryOpenSplit from './WorkspaceMemoryOpenSplit';
import WorkspaceMemoryToggle from './WorkspaceMemoryToggle';
import './WorkspaceMemoryPanel.css';

interface WorkspaceMemoryPanelProps {
  project: AnnotationProject;
  onClose: () => void;
}

export default function WorkspaceMemoryPanel({
  project,
  onClose,
}: WorkspaceMemoryPanelProps) {
  const { updateProject } = useAnnotation();
  const { showToast } = useToast();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [openTarget, setOpenTarget] =
    useState<MemoryOpenTarget>(getMemoryOpenTarget);

  const scopeKey = computeMemoryScopeKey(project.id);
  const enabled = Boolean(project.workspaceMemoryEnabled);

  const refreshEntries = useCallback(async () => {
    if (!scopeKey) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      if (enabled) {
        await syncWorkspaceFactMemory(project);
      }
      setEntries(await listMemoryEntries(scopeKey));
    } finally {
      setLoading(false);
    }
  }, [enabled, project, scopeKey]);

  useEffect(() => {
    void refreshEntries();
  }, [refreshEntries]);

  const handleToggle = async (next: boolean) => {
    if (toggling) return;
    setToggling(true);
    try {
      await updateProject(
        project.id,
        {
          name: project.name,
          description: project.description,
          labels: project.labels,
          workspaceMemoryEnabled: next,
        },
        { silent: true },
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : '无法更新工作区记忆开关', {
        type: 'error',
      });
    } finally {
      setToggling(false);
    }
  };

  const handleSelectTarget = (target: MemoryOpenTarget) => {
    setOpenTarget(target);
    setMemoryOpenTarget(target);
  };

  const handleOpenFile = async (
    entry: MemoryEntry,
    target: MemoryOpenTarget,
  ) => {
    setOpeningId(entry.id);
    try {
      if (!scopeKey) {
        throw new Error('无法打开记忆文件');
      }
      await openMemoryFile(scopeKey, entry.relativePath, target);
    } catch (err) {
      showToast(memoryOpenErrorMessage(err), { type: 'error' });
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <ModalMotion
      open
      onClose={onClose}
      closeOnBackdropClick={false}
      dialogClassName="workspace-memory-panel"
      labelledBy="workspace-memory-panel-title"
    >
      <div className="workspace-memory-panel-header">
        <div className="workspace-memory-panel-heading">
          <h3 id="workspace-memory-panel-title">工作区记忆</h3>
          <p className="workspace-memory-panel-subtitle" title={project.name}>
            {project.name}
          </p>
        </div>
        <button
          type="button"
          className="workspace-memory-panel-close"
          aria-label="关闭"
          onClick={onClose}
        >
          <VscodeIcon name="close" size={16} />
        </button>
      </div>

      <div className="workspace-memory-panel-toggle">
        <WorkspaceMemoryToggle
          id={`workspace-memory-panel-${project.id}`}
          checked={enabled}
          disabled={toggling}
          onChange={(next) => {
            void handleToggle(next);
          }}
        />
      </div>

      <div className="workspace-memory-panel-list" aria-busy={loading}>
        {loading ? (
          <p className="workspace-memory-panel-empty">正在读取记忆文件…</p>
        ) : entries.length === 0 ? (
          <div className="workspace-memory-panel-empty-card">
            <VscodeIcon name="thinking" size={22} />
            <p>尚未生成记忆文件</p>
            <span>
              打开开关后，确认标注或保存时系统会更新进度与已标文件；Agent
              可另记偏好
            </span>
          </div>
        ) : (
          <ul className="workspace-memory-card-list">
            {entries.map((entry) => (
              <li key={entry.id} className="workspace-memory-card">
                <div className="workspace-memory-card-icon" aria-hidden>
                  <VscodeIcon name="thinking" size={16} />
                </div>
                <div className="workspace-memory-card-body">
                  <div className="workspace-memory-card-title">
                    {entry.title}
                  </div>
                  {entry.excerpt ? (
                    <p className="workspace-memory-card-excerpt">
                      {entry.excerpt}
                    </p>
                  ) : null}
                  <div className="workspace-memory-card-path">
                    {entry.relativePath}
                  </div>
                </div>
                <WorkspaceMemoryOpenSplit
                  disabled={openingId === entry.id}
                  selectedTarget={openTarget}
                  onSelectTarget={handleSelectTarget}
                  onOpen={(target) => {
                    void handleOpenFile(entry, target);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="workspace-memory-panel-actions">
        <VscodeButton
          secondary
          icon="refresh"
          type="button"
          onClick={() => {
            void refreshEntries();
          }}
        >
          刷新
        </VscodeButton>
      </div>
    </ModalMotion>
  );
}
