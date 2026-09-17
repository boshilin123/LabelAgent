import { VscodeIcon } from '@vscode-elements/react-elements';
import { useState } from 'react';
import {
  formatToolCallLabel,
  summarizeToolResultForDisplay,
} from '../../services/toolDisplayUtils';
import type { ToolCallBlock } from './explorationRenderUtils';
import AgentScrollablePre from './AgentScrollablePre';
import './AgentReasoningBlock.css';

interface AgentExplorationBlockProps {
  tools: ToolCallBlock[];
  summary: string;
  streaming?: boolean;
}

export default function AgentExplorationBlock({
  tools,
  summary,
  streaming = false,
}: AgentExplorationBlockProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [expandedToolIds, setExpandedToolIds] = useState<
    Record<string, boolean>
  >({});

  const label = streaming ? `${summary} · 进行中` : summary;

  const toggleTool = (toolId: string) => {
    setExpandedToolIds((prev) => ({
      ...prev,
      [toolId]: !prev[toolId],
    }));
  };

  return (
    <div className="agent-reasoning-block agent-tool-block">
      <button
        type="button"
        className="agent-reasoning-toggle"
        onClick={() => setCollapsed((value) => !value)}
      >
        <VscodeIcon
          name={collapsed ? 'chevron-right' : 'chevron-down'}
          size={12}
        />
        <span>{label}</span>
      </button>
      {!collapsed && (
        <div className="agent-reasoning-body">
          {tools.map((tool) => {
            const toolLabel = formatToolCallLabel(tool.name, tool.arguments);
            const toolExpanded = expandedToolIds[tool.id] ?? false;
            const displayResult = tool.result
              ? summarizeToolResultForDisplay(tool.name, tool.result)
              : undefined;

            return (
              <div key={tool.id} className="agent-tool-block">
                <button
                  type="button"
                  className="agent-block-toggle"
                  onClick={() => toggleTool(tool.id)}
                >
                  <VscodeIcon
                    name={toolExpanded ? 'chevron-down' : 'chevron-right'}
                    size={12}
                  />
                  <span>
                    {toolLabel}
                    {tool.status === 'running' ? ' · 进行中' : ''}
                  </span>
                </button>
                {toolExpanded && (
                  <div className="agent-tool-body">
                    <div className="agent-tool-section">
                      <div className="agent-tool-label">参数</div>
                      <AgentScrollablePre>
                        {tool.arguments || '{}'}
                      </AgentScrollablePre>
                    </div>
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
          })}
        </div>
      )}
    </div>
  );
}
