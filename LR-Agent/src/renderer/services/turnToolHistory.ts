import type { StreamEvent } from '../../shared/agentTypes';

export type TurnHistoryToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type TurnHistoryAssistantMessage = {
  role: 'assistant';
  content: string;
  tool_calls?: TurnHistoryToolCall[];
};

export type TurnHistoryToolMessage = {
  role: 'tool';
  content: string;
  tool_call_id: string;
};

export type TurnHistoryMessage =
  TurnHistoryAssistantMessage | TurnHistoryToolMessage;

type OpenRound = {
  content: string;
  toolCalls: TurnHistoryToolCall[];
  awaiting: Set<string>;
};

function eventToolCallId(event: StreamEvent): string {
  const rec = event as Record<string, unknown>;
  return String(rec.toolCallId ?? rec.tool_call_id ?? '').trim();
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // keep empty args when the payload is not JSON
  }
  return {};
}

function pendingCallsFromEvent(event: StreamEvent): Array<{
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
}> {
  if (event.type !== 'tool_pending') return [];
  const rec = event as Record<string, unknown>;
  const raw = (rec.toolCalls ??
    rec.client_tool_calls ??
    rec.clientToolCalls) as unknown | undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const call = item as Record<string, unknown>;
    return {
      toolCallId: String(call.toolCallId ?? call.tool_call_id ?? '').trim(),
      name: String(call.name ?? ''),
      arguments: parseToolArgs(call.arguments ?? call.args),
    };
  });
}

/**
 * 从本轮 SSE 原文累积 OpenAI 兼容的 assistant/tool 消息。
 * 不读 UI block（展示层会截断 result）。
 */
export class TurnToolHistoryAccumulator {
  private readonly messages: TurnHistoryMessage[] = [];

  private textBuffer = '';

  private open: OpenRound | null = null;

  apply(event: StreamEvent): void {
    if (event.type === 'text_delta' && event.content) {
      this.textBuffer += event.content;
      return;
    }

    if (event.type === 'tool_start') {
      this.beginOrContinueRound();
      const id = eventToolCallId(event);
      if (!id || !this.open) return;
      if (this.open.toolCalls.some((call) => call.id === id)) {
        this.open.awaiting.add(id);
        return;
      }
      this.open.toolCalls.push({
        id,
        name: event.name,
        args: parseToolArgs(event.arguments),
      });
      this.open.awaiting.add(id);
      return;
    }

    if (event.type === 'tool_result') {
      const id = eventToolCallId(event);
      if (!id) return;
      this.messages.push({
        role: 'tool',
        content: event.result,
        tool_call_id: id,
      });
      this.open?.awaiting.delete(id);
      if (this.open && this.open.awaiting.size === 0) {
        this.open = null;
      }
      return;
    }

    if (event.type === 'tool_pending') {
      const pending = pendingCallsFromEvent(event);
      if (pending.length > 0 && (!this.open || this.open.awaiting.size === 0)) {
        this.beginOrContinueRound();
        for (const call of pending) {
          if (!call.toolCallId || !this.open) continue;
          if (
            !this.open.toolCalls.some((item) => item.id === call.toolCallId)
          ) {
            this.open.toolCalls.push({
              id: call.toolCallId,
              name: call.name,
              args: call.arguments,
            });
          }
        }
      }
      for (const call of pending) {
        this.open?.awaiting.delete(call.toolCallId);
      }
      if (this.open && this.open.awaiting.size === 0) {
        this.open = null;
      }
    }
  }

  snapshot(): TurnHistoryMessage[] {
    const out: TurnHistoryMessage[] = this.messages.map((message) => {
      if (message.role === 'tool') {
        return { ...message };
      }
      const copy: TurnHistoryAssistantMessage = {
        role: 'assistant',
        content: message.content,
      };
      if (message.tool_calls?.length) {
        copy.tool_calls = message.tool_calls.map((call) => ({ ...call }));
      }
      return copy;
    });
    if (this.textBuffer.trim()) {
      out.push({ role: 'assistant', content: this.textBuffer });
    }
    return out;
  }

  private beginOrContinueRound(): void {
    if (this.open && this.open.awaiting.size > 0) return;
    const toolCalls: TurnHistoryToolCall[] = [];
    this.open = {
      content: this.textBuffer,
      toolCalls,
      awaiting: new Set(),
    };
    this.textBuffer = '';
    this.messages.push({
      role: 'assistant',
      content: this.open.content,
      tool_calls: toolCalls,
    });
  }
}

export function mergeResumeMessages<
  T extends { role: string; content: string },
>(
  prior: T[],
  turnHistory: TurnHistoryMessage[],
): Array<T | TurnHistoryMessage> {
  return [...prior, ...turnHistory];
}
