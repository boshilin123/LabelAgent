import { VscodeIcon } from '@vscode-elements/react-elements';
import './ActivityBar.css';

interface ActivityIconProps {
  name: string;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export default function ActivityIcon({
  name,
  label,
  active,
  disabled = false,
  onClick,
}: ActivityIconProps) {
  return (
    <button
      type="button"
      className={`activity-icon-wrap${active ? ' activity-icon-active' : ''}${disabled ? ' activity-icon-disabled' : ''}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <VscodeIcon name={name} size={24} label={label} />
    </button>
  );
}
