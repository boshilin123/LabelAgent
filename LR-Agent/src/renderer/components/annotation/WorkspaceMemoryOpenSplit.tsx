import { useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import FloatingActionMenuPortal from '../../motion/FloatingActionMenuPortal';
import type { MemoryOpenTarget } from '../../services/agentMemory';

interface WorkspaceMemoryOpenSplitProps {
  disabled?: boolean;
  selectedTarget: MemoryOpenTarget;
  onSelectTarget: (target: MemoryOpenTarget) => void;
  onOpen: (target: MemoryOpenTarget) => void;
}

const TARGETS: Array<{
  id: MemoryOpenTarget;
  label: string;
  icon: string;
}> = [
  { id: 'explorer', label: '资源管理器', icon: 'folder' },
  { id: 'vscode', label: 'VS Code', icon: 'vscode' },
];

export default function WorkspaceMemoryOpenSplit({
  disabled,
  selectedTarget,
  onSelectTarget,
  onOpen,
}: WorkspaceMemoryOpenSplitProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const selected = TARGETS.find((item) => item.id === selectedTarget);
  const mainLabel =
    selected?.id === 'vscode' ? '用 VS Code 打开' : '在资源管理器中显示';

  return (
    <div className="workspace-memory-open-split">
      <button
        type="button"
        className="workspace-memory-open-main"
        disabled={disabled}
        aria-label={mainLabel}
        title={mainLabel}
        onClick={() => {
          onOpen(selectedTarget);
        }}
      >
        <VscodeIcon name="folder" size={14} />
      </button>
      <button
        ref={setAnchorEl}
        type="button"
        className="workspace-memory-open-chevron"
        disabled={disabled}
        aria-label="选择打开方式"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="选择打开方式"
        onClick={() => {
          setMenuOpen((open) => !open);
        }}
      >
        <VscodeIcon name="chevron-down" size={12} />
      </button>
      {anchorEl ? (
        <FloatingActionMenuPortal
          open={menuOpen}
          anchorEl={anchorEl}
          onClose={() => setMenuOpen(false)}
          className="workspace-memory-open-menu"
          openUpClassName="workspace-memory-open-menu-up"
          menuMinWidth={160}
        >
          {TARGETS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === selectedTarget}
              onClick={() => {
                onSelectTarget(item.id);
                setMenuOpen(false);
                onOpen(item.id);
              }}
            >
              <span className="workspace-memory-open-menu-label">
                <VscodeIcon name={item.icon} size={14} />
                {item.label}
              </span>
              {item.id === selectedTarget ? (
                <VscodeIcon name="check" size={14} />
              ) : (
                <span className="workspace-memory-open-menu-check-slot" />
              )}
            </button>
          ))}
        </FloatingActionMenuPortal>
      ) : null}
    </div>
  );
}
