import { VscodeIcon } from '@vscode-elements/react-elements';
import FloatingActionMenuPortal from '../../motion/FloatingActionMenuPortal';
import './LlmProviderMenuPortal.css';

interface LlmProviderMenuPortalProps {
  open: boolean;
  anchorEl: HTMLElement;
  canSetDefault: boolean;
  onClose: () => void;
  onExitComplete?: () => void;
  onSetDefault: () => void;
  onEdit: () => void;
  onProbeVision: () => void;
  onProbeContext: () => void;
  onDelete: () => void;
}

export default function LlmProviderMenuPortal({
  open,
  anchorEl,
  canSetDefault,
  onClose,
  onExitComplete,
  onSetDefault,
  onEdit,
  onProbeVision,
  onProbeContext,
  onDelete,
}: LlmProviderMenuPortalProps) {
  return (
    <FloatingActionMenuPortal
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      onExitComplete={onExitComplete}
      className="llm-provider-menu llm-provider-menu-portal"
      openUpClassName="llm-provider-menu-open-up"
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
      <button type="button" role="menuitem" onClick={onProbeVision}>
        <VscodeIcon name="eye" size={14} />
        重新检测视觉
      </button>
      <button type="button" role="menuitem" onClick={onProbeContext}>
        <VscodeIcon name="window" size={14} />
        检测上下文窗口
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
