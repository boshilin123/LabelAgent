import {
  DEFAULT_CHAT_CONTEXT_CONFIG,
  type AgentInteractionMode,
  type AgentSession,
  type ChatMessage,
} from '../../shared/agentTypes';

export type TurnRole = 'user' | 'assistant';

export interface TurnLine {
  messageId: string;
  role: TurnRole;
  interactionMode: AgentInteractionMode | null;
  content: string;
}

export interface TurnContext {
  lines: TurnLine[];
  transcript: string;
  windowedLines: TurnLine[];
  summary: string | null;
  summaryUpToMessageId: string | null;
  currentUserContent: string;
}

const MAX_TRANSCRIPT_CHARS = 12_000;

function roleLabel(role: TurnRole): string {
  return role === 'user' ? '用户' : '助手';
}

export function formatTurnLine(role: TurnRole, content: string): string {
  return `${roleLabel(role)}: ${content.trim()}`;
}

function blocksToText(blocks: ChatMessage['blocks']): string {
  return blocks
    .filter((b): b is { type: 'text'; content: string } => b.type === 'text')
    .map((b) => b.content)
    .join('\n')
    .trim();
}

function blocksToPreview(blocks: ChatMessage['blocks'], maxLen = 400): string {
  const text = blocksToText(blocks);
  if (text) return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  for (const block of blocks) {
    if (block.type === 'annotation_pipeline') {
      const step = block.steps.find((s) => s.message?.trim());
      if (step?.message) {
        const msg = step.message.trim();
        return msg.length > maxLen ? `${msg.slice(0, maxLen)}…` : msg;
      }
    }
    if (block.type === 'annotation_proposal') {
      const summary = block.proposal?.summary?.trim();
      if (summary) {
        return summary.length > maxLen
          ? `${summary.slice(0, maxLen)}…`
          : summary;
      }
    }
  }
  return '';
}

function windowMessages<T extends { role: string }>(
  items: T[],
  maxTurns: number,
): T[] {
  if (maxTurns <= 0) return items;
  const maxMessages = maxTurns * 2;
  if (items.length <= maxMessages) return items;
  return items.slice(-maxMessages);
}

function truncateTranscript(
  transcript: string,
  maxChars = MAX_TRANSCRIPT_CHARS,
): string {
  if (transcript.length <= maxChars) return transcript;
  const lines = transcript.split('\n');
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const extra = line.length + (kept.length ? 1 : 0);
    if (total + extra > maxChars) break;
    kept.unshift(line);
    total += extra;
  }
  return kept.join('\n');
}

export function buildTurnContextFromState(
  session: AgentSession | null,
  messageIds: string[],
  messagesBySession: Record<string, ChatMessage[]>,
  options: {
    currentUserContent?: string;
    excludeMessageIds?: Set<string>;
    maxTurnsInWindow?: number;
  } = {},
): TurnContext {
  const exclude = options.excludeMessageIds ?? new Set<string>();
  const maxTurns =
    options.maxTurnsInWindow ?? DEFAULT_CHAT_CONTEXT_CONFIG.maxTurnsInWindow;
  const sessionId = session?.id ?? '';
  const all = messagesBySession[sessionId] ?? [];
  const byId = new Map(all.map((m) => [m.id, m]));

  const lines: TurnLine[] = [];
  for (const id of messageIds) {
    if (exclude.has(id)) continue;
    const msg = byId.get(id);
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    if (msg.status === 'streaming') continue;
    let content = blocksToText(msg.blocks);
    if (!content) content = blocksToPreview(msg.blocks);
    if (!content) continue;
    const mode =
      msg.interactionMode === 'annotation' || msg.interactionMode === 'chat'
        ? msg.interactionMode
        : null;
    lines.push({
      messageId: msg.id,
      role: msg.role as TurnRole,
      interactionMode: mode,
      content,
    });
  }

  const windowedLines = windowMessages(lines, maxTurns);
  const transcript = truncateTranscript(
    windowedLines.map((ln) => formatTurnLine(ln.role, ln.content)).join('\n'),
  );

  return {
    lines,
    transcript,
    windowedLines,
    summary: session?.contextSummary ?? null,
    summaryUpToMessageId: session?.summaryUpToMessageId ?? null,
    currentUserContent: (options.currentUserContent ?? '').trim(),
  };
}
