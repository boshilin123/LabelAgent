import { VscodeIcon } from '@vscode-elements/react-elements';
import FloatingActionMenuPortal from '../../motion/FloatingActionMenuPortal';
import './McpServerMenuPortal.css';

interface McpServerMenuPortalProps {
  open: boolean;
  anchorEl: HTMLElement;
  enabled: boolean;
  probing: boolean;
  onClose: () => void;
  onExitComplete?: () => void;
  onProbe: () => void;
  onToggleEnabled: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export default function McpServerMenuPortal({
  open,
  anchorEl,
  enabled,
  probing,
  onClose,
  onExitComplete,
  onProbe,
  onToggleEnabled,
  onEdit,
  onDelete,
}: McpServerMenuPortalProps) {
  return (
    <FloatingActionMenuPortal
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      onExitComplete={onExitComplete}
      className="mcp-server-menu mcp-server-menu-portal"
      openUpClassName="mcp-server-menu-open-up"
      repositionDeps={[enabled, probing]}
    >
      <button
        type="button"
        role="menuitem"
        disabled={probing}
        onClick={onProbe}
      >
        <VscodeIcon name="sync" size={14} />
        {probing ? '测试中…' : '测试连接'}
      </button>
      <button type="button" role="menuitem" onClick={onToggleEnabled}>
        <VscodeIcon name={enabled ? 'circle-slash' : 'check'} size={14} />
        {enabled ? '停用' : '启用'}
      </button>
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
