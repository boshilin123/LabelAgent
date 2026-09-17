import type { ChatContextConfig, StreamEvent } from '../../shared/agentTypes';
import { DEFAULT_CHAT_CONTEXT_CONFIG } from '../../shared/agentTypes';

export interface DirectChatRequest {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  messages: Array<{ role: string; content: string }>;
  userContent: string;
  /** System prompt injected as first system message */
  systemPrompt?: string;
}

function parseSseBuffer(buffer: string): {
  events: StreamEvent[];
  rest: string;
} {
  const events: StreamEvent[] = [];
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') {
      events.push({ type: 'done' });
      continue;
    }
    if (!payload) continue;
    try {
      const json = JSON.parse(payload);
      if (json && typeof json === 'object') {
        const event = parseOpenAiChunk(json);
        if (event) {
          events.push(event);
        }
      }
    } catch {
      // ignore malformed chunks
    }
  }

  return { events, rest };
}

function parseOpenAiChunk(chunk: Record<string, unknown>): StreamEvent | null {
  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  if (!choices || choices.length === 0) return null;

  const choice = choices[0];
  const delta = choice.delta as Record<string, unknown> | undefined;

  if (delta) {
    // Handle reasoning content (DeepSeek-style)
    if (
      delta.reasoning_content &&
      typeof delta.reasoning_content === 'string'
    ) {
      return { type: 'reasoning_delta', content: delta.reasoning_content };
    }
    // Handle regular text content
    if (delta.content && typeof delta.content === 'string') {
      return { type: 'text_delta', content: delta.content };
    }
    // Handle tool calls
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      const toolCall = delta.tool_calls[0] as Record<string, unknown>;
      if (toolCall.function) {
        const func = toolCall.function as Record<string, unknown>;
        return {
          type: 'tool_start',
          toolCallId: toolCall.id as string,
          name: func.name as string,
          arguments: func.arguments as string,
        };
      }
    }
  }

  // Check finish reason
  const finishReason = choice.finish_reason as string | undefined;
  if (finishReason === 'stop') {
    return { type: 'done' };
  }
  if (finishReason === 'tool_calls') {
    // Tool calls pending - the tool calls should have been streamed in previous chunks
    // We'll let the stream complete and check for tool calls in the accumulated delta
    return { type: 'done' };
  }

  return null;
}

export async function* streamChatDirectly(
  request: DirectChatRequest,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const url = `${request.baseUrl}/chat/completions`;
  const normalizedUrl = url.replace(/([^:])\/\//g, '$1/');

  const body = {
    model: request.model,
    messages: [
      ...(request.systemPrompt
        ? [{ role: 'system', content: request.systemPrompt }]
        : []),
      ...request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: 'user', content: request.userContent },
    ],
    stream: true,
    stream_options: { include_usage: true },
  };

  let response: Response;
  try {
    response = await fetch(normalizedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : '请求失败',
    };
    return;
  }

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status}`;
    try {
      const errorBody = await response.text();
      try {
        const errJson = JSON.parse(errorBody);
        errorMsg = errJson.error?.message || errJson.message || errorMsg;
      } catch {
        errorMsg = errorBody.slice(0, 200) || errorMsg;
      }
    } catch {
      // ignore
    }
    yield { type: 'error', message: errorMsg };
    return;
  }

  if (!response.body) {
    yield { type: 'error', message: '响应体为空' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        yield event;
        if (event.type === 'done' || event.type === 'error') return;
      }
    }
    if (!signal.aborted) {
      yield { type: 'done' };
    }
  } finally {
    reader.releaseLock();
  }
}
