import type { MessageBlock } from '../../types/agent';
import { formatToolCallLabel } from '../../services/toolDisplayUtils';
import {
  formatSubagentElapsed,
  runningStepLabel,
  truncateSubagentQuery,
} from '../../services/subagentBlocks';
import { useAgentChat } from '../../context/AgentChatContext';
import './AgentSubagentRow.css';

interface AgentSubagentRowProps {
  block: Extract<MessageBlock, { type: 'subagent' }>;
  sessionId: string;
}

export default function AgentSubagentRow({
  block,
  sessionId,
}: AgentSubagentRowProps) {
  const { openSubagentTab } = useAgentChat();
  const running = block.status === 'running';
  const failed = block.status === 'error';
  const query = truncateSubagentQuery(block.query, 40);
  const current = running ? runningStepLabel(block) : null;
  const currentLabel = current
    ? formatToolCallLabel(
        current,
        block.steps.find((step) => step.name === current)?.arguments ?? '{}',
      )
    : null;
  const elapsed =
    !running && block.startedAt
      ? formatSubagentElapsed(block.startedAt, block.finishedAt)
      : null;

  const title = failed ? '查阅失败' : query;
  const className = [
    'agent-subagent-row',
    failed ? 'agent-subagent-row--error' : '',
    running ? 'agent-subagent-row--running' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      role="link"
      onClick={() => openSubagentTab(block.id, sessionId)}
    >
      <span className="agent-subagent-row-label">
        <span
          className={`agent-session-tab-dot agent-subagent-row-dot${
            running ? ' agent-subagent-row-dot--running' : ''
          }`}
        />
        subagent
      </span>
      <span className="agent-subagent-row-sep">·</span>
      <span className="agent-subagent-row-query">{title}</span>
      {currentLabel ? (
        <span className="agent-subagent-row-current">正在 {currentLabel}</span>
      ) : null}
      {elapsed ? (
        <span className="agent-subagent-row-elapsed">{elapsed}</span>
      ) : null}
    </button>
  );
}
