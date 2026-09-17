import { VscodeIcon } from '@vscode-elements/react-elements';
import { useState, type ReactNode } from 'react';
import './AgentReasoningBlock.css';
import './AgentWorkHistory.css';

interface AgentWorkHistoryProps {
  label: string;
  children: ReactNode;
}

export default function AgentWorkHistory({
  label,
  children,
}: AgentWorkHistoryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="agent-work-history">
      <button
        type="button"
        className="agent-reasoning-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <VscodeIcon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={12}
        />
        <span>{label}</span>
      </button>
      {expanded && <div className="agent-work-history-body">{children}</div>}
    </div>
  );
}
