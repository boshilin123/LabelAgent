import { useCallback, useState } from 'react';
import type { MessageBlock } from '../../types/agent';
import {
  findSubagentBlock,
  formatSubagentElapsed,
  subagentTranscriptBlocks,
} from '../../services/subagentBlocks';
import { useAgentChat } from '../../context/AgentChatContext';
import AgentMarkdown from './AgentMarkdown';
import AgentToolCallBlock from './AgentToolCallBlock';
import AgentExplorationBlock from './AgentExplorationBlock';
import {
  buildAssistantRenderSegments,
  type AssistantRenderSegment,
} from './explorationRenderUtils';
import './AgentMessageItem.css';
import './AgentSubagentTabView.css';

interface AgentSubagentTabViewProps {
  runId: string;
}

function statusLabel(status: 'running' | 'done' | 'error'): string {
  if (status === 'running') return '查阅中';
  if (status === 'error') return '失败';
  return '已完成';
}

export default function AgentSubagentTabView({
  runId,
}: AgentSubagentTabViewProps) {
  const { messagesBySession, switchSession, stopGeneration } = useAgentChat();
  const found = findSubagentBlock(messagesBySession, runId);
  const [expandedToolIds, setExpandedToolIds] = useState<
    Record<string, boolean>
  >({});

  const handleToggle = useCallback((toolId: string) => {
    setExpandedToolIds((prev) => ({ ...prev, [toolId]: !prev[toolId] }));
  }, []);

  if (!found) {
    return (
      <div className="agent-subagent-tab">
        <div className="agent-subagent-tab-empty">找不到这次查阅记录。</div>
      </div>
    );
  }

  const { block, sessionId } = found;
  const elapsed = formatSubagentElapsed(block.startedAt, block.finishedAt);
  const running = block.status === 'running';
  const failed = block.status === 'error';
  const transcript = subagentTranscriptBlocks(block).map((item) =>
    item.type === 'tool_call'
      ? { ...item, collapsed: !expandedToolIds[item.id] }
      : item,
  );
  const emptyRunning = running && transcript.length === 0;
  const segments = buildAssistantRenderSegments(transcript);

  const renderBlock = (inner: MessageBlock, index: number) => {
    if (inner.type === 'tool_call') {
      return (
        <AgentToolCallBlock
          key={inner.id}
          block={inner}
          onToggle={() => handleToggle(inner.id)}
        />
      );
    }
    if (inner.type === 'text' && inner.content) {
      return <AgentMarkdown key={`text-${index}`} content={inner.content} />;
    }
    return null;
  };

  return (
    <div className="agent-subagent-tab">
      <header className="agent-subagent-tab-header">
        <div className="agent-subagent-tab-heading">
          <div className="agent-subagent-tab-query">
            {block.query || '查阅'}
          </div>
          <div className="agent-subagent-tab-meta">
            <span>{statusLabel(block.status)}</span>
            {block.status !== 'running' ? <span>{elapsed}</span> : null}
            {block.focusPath ? <span>{block.focusPath}</span> : null}
          </div>
        </div>
        <div className="agent-subagent-tab-actions">
          {running ? (
            <button
              type="button"
              className="agent-assistant-action"
              title="停止本轮"
              aria-label="停止本轮"
              onClick={() => stopGeneration(sessionId)}
            >
              <span className="codicon codicon-debug-stop" />
            </button>
          ) : null}
          <button
            type="button"
            className="agent-assistant-action"
            title="返回对话"
            aria-label="返回对话"
            onClick={() => switchSession(sessionId)}
          >
            <span className="codicon codicon-arrow-left" />
          </button>
        </div>
      </header>

      <div className="agent-subagent-tab-body">
        {emptyRunning ? (
          <div className="agent-subagent-tab-empty">正在查阅工作区…</div>
        ) : failed && transcript.length === 0 ? (
          <div className="agent-subagent-tab-empty">已停止</div>
        ) : (
          <div className="agent-assistant-content">
            {segments.map((segment: AssistantRenderSegment) => {
              if (segment.kind === 'exploration') {
                const streamingExploration =
                  running &&
                  segment.tools.some((tool) => tool.status === 'running');
                return (
                  <AgentExplorationBlock
                    key={segment.key}
                    tools={segment.tools}
                    summary={segment.summary}
                    streaming={streamingExploration}
                  />
                );
              }
              return renderBlock(segment.block, segment.index);
            })}
            {running ? <span className="agent-stream-cursor">▍</span> : null}
            {failed && transcript.length > 0 ? (
              <div className="agent-message-meta agent-message-meta--error">
                已停止 / 工具出错
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
