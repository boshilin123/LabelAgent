import type {
  AgentChatPersistedState,
  AgentPanelTab,
  ChatMessage,
  MessageBlock,
} from '../../shared/agentTypes';

export type SubagentBlock = Extract<MessageBlock, { type: 'subagent' }>;

export function panelTabKey(tab: AgentPanelTab): string {
  return tab.kind === 'session'
    ? `session:${tab.sessionId}`
    : `subagent:${tab.runId}`;
}

export function isSamePanelTab(
  left: AgentPanelTab | null,
  right: AgentPanelTab | null,
): boolean {
  if (!left || !right) return left === right;
  return panelTabKey(left) === panelTabKey(right);
}

export function truncateSubagentQuery(query: string, max = 20): string {
  const text = query.trim().replace(/\s+/g, ' ');
  if (!text) return '查阅';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function formatSubagentElapsed(
  startedAt: number,
  finishedAt?: number,
  now = Date.now(),
): string {
  const ms = Math.max(0, (finishedAt ?? now) - startedAt);
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function findSubagentBlock(
  messagesBySession:
    | AgentChatPersistedState['messagesBySession']
    | Record<string, Record<string, ChatMessage>>,
  runId: string,
): { sessionId: string; message: ChatMessage; block: SubagentBlock } | null {
  for (const [sessionId, messages] of Object.entries(messagesBySession)) {
    for (const message of Object.values(messages)) {
      const block = message.blocks.find(
        (item): item is SubagentBlock =>
          item.type === 'subagent' && item.id === runId,
      );
      if (block) {
        return { sessionId, message, block };
      }
    }
  }
  return null;
}

export function runningStepLabel(block: SubagentBlock): string | null {
  const running = [...block.steps]
    .reverse()
    .find((step) => step.status === 'running');
  if (!running) return null;
  return running.name || null;
}

export function subagentTranscriptBlocks(block: SubagentBlock): MessageBlock[] {
  const inners = block.innerBlocks ?? [];
  if (inners.length > 0) {
    const hasText = inners.some(
      (item) => item.type === 'text' && item.content.trim(),
    );
    if (!hasText && block.summary.trim()) {
      return [...inners, { type: 'text', content: block.summary }];
    }
    return inners;
  }
  const tools: MessageBlock[] = block.steps.map((step) => ({
    type: 'tool_call',
    id: step.id,
    name: step.name,
    arguments: step.arguments,
    status: step.status,
    result: step.result,
    collapsed: true,
  }));
  if (block.summary.trim()) {
    return [...tools, { type: 'text', content: block.summary }];
  }
  return tools;
}
