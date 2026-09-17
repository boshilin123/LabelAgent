import { VscodeIcon } from '@vscode-elements/react-elements';
import FloatingActionMenuPortal from '../../motion/FloatingActionMenuPortal';
import './AnnotationProjectMenuPortal.css';

interface AnnotationProjectMenuPortalProps {
  open: boolean;
  anchorEl: HTMLElement;
  onClose: () => void;
  onExitComplete?: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onWorkspaceMemory: () => void;
  onExport: () => void;
  onShowInFolder: () => void;
  onDelete: () => void;
}

export default function AnnotationProjectMenuPortal({
  open,
  anchorEl,
  onClose,
  onExitComplete,
  onOpen,
  onEdit,
  onWorkspaceMemory,
  onExport,
  onShowInFolder,
  onDelete,
}: AnnotationProjectMenuPortalProps) {
  return (
    <FloatingActionMenuPortal
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      onExitComplete={onExitComplete}
      className="annotation-project-menu annotation-project-menu-portal"
      openUpClassName="annotation-project-menu-open-up"
    >
      <button type="button" role="menuitem" onClick={onOpen}>
        <VscodeIcon name="folder-opened" size={14} />
        打开
      </button>
      <button type="button" role="menuitem" onClick={onEdit}>
        <VscodeIcon name="edit" size={14} />
        编辑设置
      </button>
      <button type="button" role="menuitem" onClick={onWorkspaceMemory}>
        <VscodeIcon name="thinking" size={14} />
        工作区记忆
      </button>
      <button type="button" role="menuitem" onClick={onExport}>
        <VscodeIcon name="export" size={14} />
        导出标注…
      </button>
      <button type="button" role="menuitem" onClick={onShowInFolder}>
        <VscodeIcon name="folder" size={14} />
        在文件夹中显示
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={onDelete}
      >
        <VscodeIcon name="trash" size={14} />
        删除任务记录
      </button>
    </FloatingActionMenuPortal>
  );
}
