import { useState } from 'react';
import { VscodeToolbarContainer } from '@vscode-elements/react-elements';
import VscodeClickableToolbarButton from '../VscodeClickableButton';
import VscodeScrollHost from '../VscodeScrollHost';
import { useAnnotation } from '../../context/AnnotationContext';
import { AnnotationProject } from '../../types/annotation';
import AnnotationProjectList from './AnnotationProjectList';
import DeleteProjectDialog from './DeleteProjectDialog';
import './AnnotationProjectPanel.css';

interface AnnotationProjectPanelProps {
  onProjectOpened?: () => void;
}

export default function AnnotationProjectPanel({
  onProjectOpened,
}: AnnotationProjectPanelProps) {
  const {
    projects,
    activeProject,
    loading,
    openCreateWizard,
    openEditProject,
    openWorkspaceMemory,
    openExportProject,
    refreshProjects,
    openProject,
    deleteProject,
    showProjectInFolder,
  } = useAnnotation();

  const [deleteTarget, setDeleteTarget] = useState<AnnotationProject | null>(
    null,
  );

  const handleOpen = async (projectId: string) => {
    await openProject(projectId);
    onProjectOpened?.();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteProject(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <div className="annotation-project-panel">
      <VscodeToolbarContainer className="annotation-project-toolbar">
        <VscodeClickableToolbarButton
          icon="add"
          label="新建标注任务"
          onClick={openCreateWizard}
        />
        <VscodeClickableToolbarButton
          icon="refresh"
          label="刷新"
          onClick={() => refreshProjects()}
        />
      </VscodeToolbarContainer>

      <VscodeScrollHost
        className="annotation-project-scroll-host"
        scrollableClassName="annotation-project-scrollable"
      >
        <AnnotationProjectList
          projects={projects}
          activeProjectId={activeProject?.id ?? null}
          loading={loading}
          onOpen={handleOpen}
          onEdit={openEditProject}
          onWorkspaceMemory={openWorkspaceMemory}
          onExport={openExportProject}
          onDelete={setDeleteTarget}
          onShowInFolder={showProjectInFolder}
        />
      </VscodeScrollHost>

      {deleteTarget && (
        <DeleteProjectDialog
          project={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}
