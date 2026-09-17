import './WorkspaceMemoryToggle.css';

interface WorkspaceMemoryToggleProps {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}

export default function WorkspaceMemoryToggle({
  id,
  checked,
  disabled,
  onChange,
}: WorkspaceMemoryToggleProps) {
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;

  return (
    <div className="workspace-memory-toggle">
      <div className="workspace-memory-toggle-row">
        <span id={labelId} className="workspace-memory-toggle-title">
          工作区记忆
        </span>
        <label className="workspace-memory-switch">
          <input
            id={id}
            type="checkbox"
            role="switch"
            aria-labelledby={labelId}
            aria-describedby={hintId}
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="workspace-memory-switch-track" aria-hidden />
        </label>
      </div>
      <p id={hintId} className="workspace-memory-toggle-hint">
        打开后，确认标注或保存时系统会更新进度与已标文件；Agent 可另记标注偏好
      </p>
    </div>
  );
}
