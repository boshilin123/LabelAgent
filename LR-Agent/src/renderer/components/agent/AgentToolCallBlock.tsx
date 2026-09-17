import { VscodeIcon } from '@vscode-elements/react-elements';
import type { MessageBlock } from '../../types/agent';
import {
  formatToolCallLabel,
  summarizeToolResultForDisplay,
} from '../../services/toolDisplayUtils';
import { resolveTerminalApproval } from '../../services/terminalApproval';
import AgentScrollablePre from './AgentScrollablePre';
import './AgentReasoningBlock.css'; /* shared tool + reasoning tokens */

interface AgentToolCallBlockProps {
  block: Extract<MessageBlock, { type: 'tool_call' }>;
  onToggle: () => void;
}

export default function AgentToolCallBlock({
  block,
  onToggle,
}: AgentToolCallBlockProps) {
  const label = formatToolCallLabel(block.name, block.arguments);
  const displayResult = block.result
    ? summarizeToolResultForDisplay(block.name, block.result)
    : undefined;
  const statusSuffix = block.awaitingApproval
    ? ' · 等待批准'
    : block.status === 'running'
      ? ' · 进行中'
      : block.status === 'queued'
        ? ' · 排队中'
        : '';

  const onDecide = (approved: boolean) => {
    resolveTerminalApproval(block.id, approved);
  };

  return (
    <div className="agent-tool-block">
      <button type="button" className="agent-block-toggle" onClick={onToggle}>
        <VscodeIcon
          name={block.collapsed ? 'chevron-right' : 'chevron-down'}
          size={12}
        />
        <span>
          {label}
          {statusSuffix}
        </span>
      </button>
      {block.awaitingApproval && (
        <div className="agent-tool-body agent-terminal-approval">
          <div className="agent-terminal-approval-hint">
            Agent 请求在当前工作区执行以上命令，是否批准？
          </div>
          <div className="agent-terminal-approval-actions">
            <button
              type="button"
              className="agent-terminal-btn approve"
              onClick={() => onDecide(true)}
            >
              批准执行
            </button>
            <button
              type="button"
              className="agent-terminal-btn reject"
              onClick={() => onDecide(false)}
            >
              拒绝
            </button>
          </div>
        </div>
      )}
      {!block.collapsed && (
        <div className="agent-tool-body">
          <div className="agent-tool-section">
            <div className="agent-tool-label">参数</div>
            <AgentScrollablePre>{block.arguments || '{}'}</AgentScrollablePre>
          </div>
          {block.terminalOutput && (
            <div className="agent-tool-section">
              <div className="agent-tool-label">输出</div>
              <AgentScrollablePre>{block.terminalOutput}</AgentScrollablePre>
            </div>
          )}
          {displayResult && (
            <div className="agent-tool-section">
              <div className="agent-tool-label">结果</div>
              <AgentScrollablePre>{displayResult}</AgentScrollablePre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
