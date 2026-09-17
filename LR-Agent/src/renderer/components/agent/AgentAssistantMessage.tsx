import { VscodeIcon } from '@vscode-elements/react-elements';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AnnotationPipelineTask,
  ChatMessage,
  ChatStreamPhase,
  MessageBlock,
  PipelineKind,
} from '../../types/agent';
import {
  clientToolPipelineKind,
  isFileProposalBlock,
} from '../../../shared/agentTypes';
import { formatToolCallLabel } from '../../services/toolDisplayUtils';
import { useAgentChat } from '../../context/AgentChatContext';
import AgentMarkdown from './AgentMarkdown';
import AgentReasoningBlock from './AgentReasoningBlock';
import AgentToolCallBlock from './AgentToolCallBlock';
import AgentExplorationBlock from './AgentExplorationBlock';
import AgentWorkHistory from './AgentWorkHistory';
import {
  buildAssistantRenderSegments,
  type AssistantRenderSegment,
} from './explorationRenderUtils';
import {
  collectThoughtContent,
  formatThoughtLabel,
  formatWorkedDuration,
  splitWorkHistory,
  workHistoryDurationMs,
  type IndexedBlock,
} from './workHistoryUtils';
import AgentSubagentRow from './AgentSubagentRow';
import AgentAnnotationPipelineBlock from './AgentAnnotationPipelineBlock';
import AgentFileChangeBlock from './AgentFileChangeBlock';
import AgentAnnotationChangeBlock from './AgentAnnotationChangeBlock';
import AgentFilesChangedSummary from './AgentFilesChangedSummary';
import { shouldSkipRedundantProposalText } from './agentAssistantRenderUtils';

interface AgentAssistantMessageProps {
  message: ChatMessage;
}

function getAssistantPlainText(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.content)
    .join('\n');
}

const STREAM_PHASE_LABELS: Record<ChatStreamPhase, string> = {
  'preparing-context': '正在准备上下文…',
  summarizing: '正在压缩历史对话…',
  'waiting-model': '等待模型响应…',
  'applying-changes': '正在应用变更…',
  'discarding-changes': '正在放弃提案…',
};

/** 这些阶段发生在消息已有内容之后（Keep All/Undo 空窗），不受空消息限制 */
const ALWAYS_VISIBLE_PHASES: ReadonlySet<ChatStreamPhase> = new Set([
  'applying-changes',
  'discarding-changes',
]);

/** 首 token 前的空窗状态行：展示当前阶段与已等待秒数 */
function StreamPhaseHint({
  phase,
  since,
}: {
  phase: ChatStreamPhase;
  since: number;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return (
    <div className="agent-stream-phase">
      {STREAM_PHASE_LABELS[phase]}
      {seconds > 0 ? ` ${seconds}s` : ''}
    </div>
  );
}

/** awaiting_confirmation 活跃态：暂停指示 + 等待计时 + 内联 Keep All / Undo */
function AwaitingConfirmHint({
  since,
  applying,
  dismissing,
  onKeepAll,
  onUndo,
}: {
  since: number;
  applying: boolean;
  dismissing: boolean;
  onKeepAll: () => void;
  onUndo: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const busy = applying || dismissing;
  return (
    <div className="agent-awaiting-confirm">
      <span className="agent-awaiting-confirm__label">
        <VscodeIcon name="debug-pause" size={14} />
        提案待确认{seconds > 0 ? ` · 已等待 ${seconds}s` : ''}
      </span>
      <span className="agent-awaiting-confirm__actions">
        <button
          type="button"
          className="agent-awaiting-confirm__btn"
          disabled={busy}
          onClick={onUndo}
        >
          {dismissing ? '撤销中…' : 'Undo'}
        </button>
        <button
          type="button"
          className="agent-awaiting-confirm__btn agent-awaiting-confirm__btn--primary"
          disabled={busy}
          onClick={onKeepAll}
        >
          {applying ? '应用中…' : 'Keep All'}
        </button>
      </span>
    </div>
  );
}

export default function AgentAssistantMessage({
  message,
}: AgentAssistantMessageProps) {
  const {
    toggleBlockCollapse,
    regenerateAssistant,
    isSessionStreaming,
    getSessionMessages,
    activeSessionId,
    applyAllPendingChanges,
    applyingAllPending,
    dismissAllPendingChanges,
    dismissingAllPending,
  } = useAgentChat();

  const [thoughtCollapsed, setThoughtCollapsed] = useState(true);

  const isStreaming = message.status === 'streaming';
  // awaiting_confirmation 是第三种活跃态：turn 暂停在 HITL 断点，
  // 不折叠工作历史、保留指示符，等待用户 Keep All / Undo
  const isAwaitingConfirm = message.status === 'awaiting_confirmation';
  const isActive = isStreaming || isAwaitingConfirm;
  const hasAnnotationProposal = message.blocks.some(
    (block) => block.type === 'annotation_proposal',
  );
  const documentProposalBlock = message.blocks.find(isFileProposalBlock);
  const messageTerminal =
    message.status === 'done' ||
    message.status === 'stopped' ||
    message.status === 'error' ||
    message.status === 'awaiting_confirmation';
  const pipelineCompleted =
    (hasAnnotationProposal && messageTerminal) ||
    (documentProposalBlock != null &&
      documentProposalBlock.status !== 'pending' &&
      messageTerminal);
  const textContent = getAssistantPlainText(message);
  const streamingSession =
    activeSessionId != null && isSessionStreaming(activeSessionId);

  const sessionMessages = activeSessionId
    ? getSessionMessages(activeSessionId)
    : [];
  const messageIndex = sessionMessages.findIndex(
    (item) => item.id === message.id,
  );
  const lastAssistantId = (() => {
    for (let i = sessionMessages.length - 1; i >= 0; i -= 1) {
      if (sessionMessages[i].role === 'assistant') {
        return sessionMessages[i].id;
      }
    }
    return null;
  })();

  const hasPriorUser = messageIndex > 0;

  const canRegenerate =
    (message.status === 'done' ||
      message.status === 'stopped' ||
      message.status === 'error') &&
    !streamingSession &&
    hasPriorUser &&
    Boolean(textContent.trim() || message.blocks.length > 0);

  const showActions =
    !isStreaming &&
    (message.status === 'done' ||
      message.status === 'error' ||
      message.status === 'stopped');

  useEffect(() => {
    setThoughtCollapsed(true);
  }, [message.id]);

  const handleToggle = useCallback(
    (blockIndex: number) => {
      toggleBlockCollapse(message.sessionId, message.id, blockIndex);
    },
    [message.id, message.sessionId, toggleBlockCollapse],
  );

  const handleCopy = useCallback(async () => {
    const text = getAssistantPlainText(message);
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }, [message]);

  const handleRegenerate = useCallback(() => {
    regenerateAssistant(message.id).catch(() => undefined);
  }, [message.id, regenerateAssistant]);

  const { history, rest } = splitWorkHistory(message.blocks);
  const foldWorkHistory = !isActive && history.length > 0;
  const liveBlocks: IndexedBlock[] = message.blocks.map((block, index) => ({
    block,
    index,
  }));
  const durationMs = workHistoryDurationMs(
    message.createdAt,
    message.finishedAt,
  );
  const workedLabel = formatWorkedDuration(durationMs);
  const thoughtContent = collectThoughtContent(message.blocks);
  const showThoughtFold = !isStreaming && thoughtContent.length > 0;
  const hasToolCall = message.blocks.some(
    (block) => block.type === 'tool_call' || block.type === 'subagent',
  );
  const thoughtLabel = formatThoughtLabel(durationMs, { hasToolCall });

  // 聚合标注任务卡：消息内出现的标注流水线类型
  const pipelineKindsPresent = useMemo(() => {
    const kinds = new Set<PipelineKind>();
    for (const block of message.blocks) {
      if (block.type === 'annotation_pipeline') {
        kinds.add(block.pipelineKind ?? 'batch');
      }
    }
    return kinds;
  }, [message.blocks]);

  // 已经出现过 error 步骤的流水线类型：其派生任务行也必须显示失败，
  // 不能因为 tool_call 块被收尾成 done 就伪造成「已完成」。
  const pipelineFailedKinds = useMemo(() => {
    const kinds = new Set<PipelineKind>();
    for (const block of message.blocks) {
      if (block.type !== 'annotation_pipeline') continue;
      if (block.steps.some((step) => step.status === 'error')) {
        kinds.add(block.pipelineKind ?? 'batch');
      }
    }
    return kinds;
  }, [message.blocks]);

  // 客户端标注工具（auto_annotate/mutate_annotation）按流水线类型派生为
  // 任务队列，渲染进对应 pipeline 卡，不再占用独立工具行
  const pipelineTasks = useMemo(() => {
    const byKind = new Map<PipelineKind, AnnotationPipelineTask[]>();
    for (const block of message.blocks) {
      if (block.type !== 'tool_call') continue;
      const kind = clientToolPipelineKind(block.name);
      if (!kind || !pipelineKindsPresent.has(kind)) continue;
      const list = byKind.get(kind) ?? [];
      // 历史数据修正：非活跃消息里停在 queued/running 说明任务被中断，
      // 绝不能伪造成「已完成」，否则会凭空多出一条假标注步骤。
      const interrupted =
        !isActive && (block.status === 'queued' || block.status === 'running');
      list.push({
        id: block.id,
        name: block.name,
        label: formatToolCallLabel(block.name, block.arguments),
        status:
          interrupted || pipelineFailedKinds.has(kind) ? 'error' : block.status,
      });
      byKind.set(kind, list);
    }
    return byKind;
  }, [message.blocks, pipelineKindsPresent, pipelineFailedKinds, isActive]);

  const handleKeepAll = useCallback(() => {
    applyAllPendingChanges().catch(() => undefined);
  }, [applyAllPendingChanges]);

  const handleUndoAll = useCallback(() => {
    dismissAllPendingChanges().catch(() => undefined);
  }, [dismissAllPendingChanges]);

  const renderBlock = (block: MessageBlock, index: number) => {
    if ((block as { type: string }).type === 'mode_suggestion') {
      return null;
    }
    if (block.type === 'reasoning') {
      return (
        <AgentReasoningBlock
          key={`reasoning-${index}`}
          block={block}
          streaming={isStreaming && index === message.blocks.length - 1}
          onToggle={() => handleToggle(index)}
        />
      );
    }
    if (block.type === 'subagent') {
      return (
        <AgentSubagentRow
          key={block.id}
          block={block}
          sessionId={message.sessionId}
        />
      );
    }
    if (block.type === 'tool_call') {
      // 客户端标注工具被吸收进对应 pipeline 任务卡，不再渲染独立工具行；
      // 若对应 pipeline 不存在（如工具立即报错），保留工具行便于诊断
      const taskKind = clientToolPipelineKind(block.name);
      if (taskKind && pipelineKindsPresent.has(taskKind)) {
        return null;
      }
      return (
        <AgentToolCallBlock
          key={block.id}
          block={block}
          onToggle={() => handleToggle(index)}
        />
      );
    }
    if (block.type === 'annotation_pipeline') {
      const kind = block.pipelineKind ?? 'batch';
      return (
        <AgentAnnotationPipelineBlock
          // 必须用 index 保证唯一：同一条消息可能存在多个 pipelineKind 相同的块，
          // 若用 `pipeline-${kind}` 会产生重复 key，React 会不断新增而无法回收节点，
          // 表现为拖动宽度（每帧重渲）时「标注变更步骤」卡片无限增多。
          key={`pipeline-${kind}-${index}`}
          steps={block.steps}
          collapsed={block.collapsed}
          streaming={isActive}
          pipelineCompleted={pipelineCompleted}
          pipelineKind={kind}
          tasks={pipelineTasks.get(kind)}
          onToggle={() => handleToggle(index)}
        />
      );
    }
    if (block.type === 'text' && block.content) {
      if (shouldSkipRedundantProposalText(block.content, message.blocks)) {
        return null;
      }
      return <AgentMarkdown key={`text-${index}`} content={block.content} />;
    }
    if (isFileProposalBlock(block)) {
      if (block.status === 'dismissed') {
        return null;
      }
      return (
        <AgentFileChangeBlock
          key={`file-${index}`}
          messageId={message.id}
          blockIndex={index}
          relativePath={block.suggestedRelativePath}
          newContent={block.content}
          operation={block.operation}
          oldPath={block.oldPath}
          editOld={block.oldString}
          editNew={block.newString}
          streaming={!block.contentFinalized}
        />
      );
    }
    if (block.type === 'annotation_proposal') {
      if (block.status === 'dismissed') {
        return null;
      }
      return (
        <AgentAnnotationChangeBlock
          key={`annotation-${index}`}
          messageId={message.id}
          blockIndex={index}
          proposal={block.proposal}
          status={block.status}
          sourceKind={block.sourceKind}
        />
      );
    }
    return null;
  };

  const renderSegments = (items: IndexedBlock[]) => {
    if (items.length === 0) return null;
    const segments = buildAssistantRenderSegments(
      message.blocks,
      items.map((item) => item.index),
    );
    return segments.map((segment: AssistantRenderSegment) => {
      if (segment.kind === 'exploration') {
        const streamingExploration =
          isStreaming &&
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
    });
  };

  return (
    <div className="agent-message-item agent-message-item--assistant">
      <div className="agent-assistant-content">
        {showThoughtFold ? (
          <AgentReasoningBlock
            key={`thought-${message.id}`}
            block={{
              type: 'reasoning',
              content: thoughtContent,
              collapsed: thoughtCollapsed,
            }}
            label={thoughtLabel}
            onToggle={() => setThoughtCollapsed((value) => !value)}
          />
        ) : null}
        {isActive ? (
          renderSegments(liveBlocks)
        ) : foldWorkHistory ? (
          <AgentWorkHistory key={`${message.id}-work`} label={workedLabel}>
            {renderSegments(history)}
          </AgentWorkHistory>
        ) : null}
        {isActive ? null : renderSegments(rest)}

        {isStreaming &&
        message.streamPhase &&
        (message.blocks.length === 0 ||
          ALWAYS_VISIBLE_PHASES.has(message.streamPhase)) ? (
          <StreamPhaseHint
            phase={message.streamPhase}
            since={message.updatedAt}
          />
        ) : null}

        {/* awaiting_confirmation 的暂停指示由下方 AwaitingConfirmHint 统一承担 */}
        {isStreaming && <span className="agent-stream-cursor">▍</span>}

        {message.status === 'stopped' && (
          <div className="agent-message-meta">已停止生成</div>
        )}
        {isAwaitingConfirm && (
          <AwaitingConfirmHint
            since={message.finishedAt ?? message.updatedAt}
            applying={applyingAllPending}
            dismissing={dismissingAllPending}
            onKeepAll={handleKeepAll}
            onUndo={handleUndoAll}
          />
        )}
        {message.status === 'error' && (
          <div className="agent-message-meta agent-message-meta--error">
            {message.error ?? '生成失败'}
          </div>
        )}

        {showActions && (
          <div className="agent-assistant-toolbar">
            <div className="agent-assistant-actions">
              <button
                type="button"
                className="agent-assistant-action"
                aria-label="复制"
                title="复制"
                disabled={!textContent.trim()}
                onClick={() => {
                  handleCopy().catch(() => undefined);
                }}
              >
                <VscodeIcon name="copy" size={18} />
              </button>
              <button
                type="button"
                className="agent-assistant-action"
                aria-label="重新生成"
                title="重新生成"
                disabled={!canRegenerate}
                onClick={handleRegenerate}
              >
                <VscodeIcon name="refresh" size={18} />
              </button>
            </div>
          </div>
        )}
        {showActions && lastAssistantId === message.id ? (
          <AgentFilesChangedSummary message={message} />
        ) : null}
      </div>
    </div>
  );
}
