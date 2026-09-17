import { VscodeIcon } from '@vscode-elements/react-elements';
import FloatingActionMenuPortal from '../../motion/FloatingActionMenuPortal';
import './SkillsPanel.css';

interface SkillsMenuPortalProps {
  open: boolean;
  anchorEl: HTMLElement;
  onClose: () => void;
  onExitComplete?: () => void;
  onReveal: () => void;
}

export default function SkillsMenuPortal({
  open,
  anchorEl,
  onClose,
  onExitComplete,
  onReveal,
}: SkillsMenuPortalProps) {
  return (
    <FloatingActionMenuPortal
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      onExitComplete={onExitComplete}
      className="skills-menu skills-menu-portal"
      openUpClassName="skills-menu-open-up"
    >
      <button type="button" role="menuitem" onClick={onReveal}>
        <VscodeIcon name="folder-opened" size={14} />
        在资源管理器中显示
      </button>
    </FloatingActionMenuPortal>
  );
}
