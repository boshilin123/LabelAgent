import { VscodeButton } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import { AnnotationProject } from '../../types/annotation';
import './DeleteProjectDialog.css';

interface DeleteProjectDialogProps {
  project: AnnotationProject;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export default function DeleteProjectDialog({
  project,
  onCancel,
  onConfirm,
}: DeleteProjectDialogProps) {
  const handleConfirm = async () => {
    await onConfirm();
  };

  return (
    <ModalMotion
      open
      onClose={onCancel}
      closeOnBackdropClick={false}
      dialogClassName="delete-project-dialog"
      labelledBy="delete-project-title"
    >
      <h3 id="delete-project-title" className="delete-project-title">
        删除标注任务？
      </h3>
      <p className="delete-project-hint">
        将删除标注任务记录「{project.name}」，本地文件夹及文件不会被删除。
      </p>
      <p className="delete-project-path" title={project.directoryPath}>
        {project.directoryPath}
      </p>
      <div className="delete-project-actions">
        <VscodeButton secondary icon="close" type="button" onClick={onCancel}>
          取消
        </VscodeButton>
        <VscodeButton
          secondary
          icon="trash"
          type="button"
          className="vscode-btn-danger"
          onClick={handleConfirm}
        >
          删除任务记录
        </VscodeButton>
      </div>
    </ModalMotion>
  );
}
