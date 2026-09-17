import { VscodeIcon } from '@vscode-elements/react-elements';
import FloatingActionMenuPortal from '../../motion/FloatingActionMenuPortal';
import './PretrainedModelMenuPortal.css';

interface PretrainedModelMenuPortalProps {
  open: boolean;
  anchorEl: HTMLElement;
  canSetDefault: boolean;
  onClose: () => void;
  onExitComplete?: () => void;
  onSetDefault: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export default function PretrainedModelMenuPortal({
  open,
  anchorEl,
  canSetDefault,
  onClose,
  onExitComplete,
  onSetDefault,
  onEdit,
  onDelete,
}: PretrainedModelMenuPortalProps) {
  return (
    <FloatingActionMenuPortal
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      onExitComplete={onExitComplete}
      className="pretrained-model-menu pretrained-model-menu-portal"
      openUpClassName="pretrained-model-menu-open-up"
      repositionDeps={[canSetDefault]}
    >
      {canSetDefault && (
        <button type="button" role="menuitem" onClick={onSetDefault}>
          <VscodeIcon name="star" size={14} />
          设为默认
        </button>
      )}
      <button type="button" role="menuitem" onClick={onEdit}>
        <VscodeIcon name="edit" size={14} />
        编辑
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={onDelete}
      >
        <VscodeIcon name="trash" size={14} />
        删除
      </button>
    </FloatingActionMenuPortal>
  );
}
