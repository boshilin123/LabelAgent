import { localAgentFetch, resolveLocalAgentBaseUrl } from '../config';
import type {
  ChatContextConfig,
  ChatMessage,
  ClientContextPayload,
  ClientToolResult,
  StreamEvent,
} from '../../shared/agentTypes';
import { buildApiClientContext } from './agentClientContext';
import type { TurnHistoryMessage } from './turnToolHistory';

export type BackendChatMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  tool_call_id?: string;
};

export interface BackendChatRequest {
  providerId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  messages: Array<BackendChatMessage | TurnHistoryMessage>;
  context: {
    summary?: string;
    summaryUpToMessageId?: string;
    config: ChatContextConfig;
  };
  clientJobId: string;
  truncateFromMessageId?: string | null;
  userContent: string;
  clientContext?: ClientContextPayload;
  /** 上轮客户端工具执行结果，resume 时携带 */
  clientToolResults?: ClientToolResult[];
  // Stateless backend fields (provider config from frontend)
  apiKey: string;
  baseUrl: string;
  model: string;
  supportsVision?: boolean;
  systemPrompt?: string;
  /** 辅助模型凭据（子代理查阅等轻量调用）；缺省时后端跟随主模型 */
  auxiliary?: { model: string; apiKey: string; baseUrl: string } | null;
}

const HISTORY_TOOL_NAMES = new Set([
  'auto_annotate',
  'mutate_annotation',
  'write_workspace_file',
  'str_replace_workspace_file',
  'delete_workspace_file',
  'move_workspace_file',
]);
const MAX_ASSISTANT_TOOL_TURNS = 6;

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // display-summarized args are not JSON
  }
  return {};
}

function compactToolResult(result: string | undefined): string {
  if (!result?.trim()) {
    return JSON.stringify({ status: 'unknown' });
  }
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return JSON.stringify({
      status: parsed.status,
      summary: parsed.summary,
      proposal_pending: parsed.proposal_pending,
      file_written: parsed.file_written,
    });
  } catch {
    return result.length > 400 ? `${result.slice(0, 400)}…` : result;
  }
}

function assistantText(message: ChatMessage): string {
  return message.blocks
    .filter(
      (block): block is Extract<typeof block, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.content)
    .join('\n')
    .trim();
}

export function buildBackendMessages(
  messageIds: string[],
  sessionMessages: Record<string, ChatMessage>,
  options?: { excludeMessageIds?: ReadonlySet<string> },
): BackendChatMessage[] {
  const exclude = options?.excludeMessageIds;
  const ordered = messageIds
    .map((id) => sessionMessages[id])
    .filter((message): message is ChatMessage => Boolean(message))
    .filter((message) => !exclude?.has(message.id))
    .filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    );

  const assistantIndexes = ordered
    .map((message, index) => (message.role === 'assistant' ? index : -1))
    .filter((index) => index >= 0);
  const toolRestoreFrom =
    assistantIndexes.length > MAX_ASSISTANT_TOOL_TURNS
      ? assistantIndexes[assistantIndexes.length - MAX_ASSISTANT_TOOL_TURNS]
      : 0;

  const out: BackendChatMessage[] = [];
  ordered.forEach((message, index) => {
    if (message.role === 'user') {
      const text = assistantText(message);
      if (text) out.push({ role: 'user', content: text });
      return;
    }

    const text = assistantText(message);
    const restoreTools = index >= toolRestoreFrom;
    const toolBlocks = restoreTools
      ? message.blocks.filter(
          (block): block is Extract<typeof block, { type: 'tool_call' }> =>
            block.type === 'tool_call' &&
            Boolean(block.id) &&
            HISTORY_TOOL_NAMES.has(block.name),
        )
      : [];

    if (toolBlocks.length === 0) {
      if (text) out.push({ role: 'assistant', content: text });
      return;
    }

    out.push({
      role: 'assistant',
      content: text,
      tool_calls: toolBlocks.map((block) => ({
        id: block.id,
        name: block.name,
        args: parseToolArgs(block.arguments),
      })),
    });
    for (const block of toolBlocks) {
      out.push({
        role: 'tool',
        content: compactToolResult(block.result),
        tool_call_id: block.id,
      });
    }
  });
  return out;
}

export function serializeBackendMessages(
  messages: Array<BackendChatMessage | TurnHistoryMessage>,
): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const payload: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };
    if (
      message.role === 'assistant' &&
      'tool_calls' in message &&
      message.tool_calls?.length
    ) {
      payload.tool_calls = message.tool_calls;
    }
    if (
      message.role === 'tool' &&
      'tool_call_id' in message &&
      message.tool_call_id
    ) {
      payload.tool_call_id = message.tool_call_id;
    }
    return payload;
  });
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
    if (!payload) continue;
    try {
      const json = JSON.parse(payload) as StreamEvent;
      if (json && typeof json === 'object' && 'type' in json) {
        events.push(json);
      }
    } catch {
      // ignore malformed chunks
    }
  }

  return { events, rest };
}

export async function* streamChatViaBackend(
  request: BackendChatRequest,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    api_key: request.apiKey,
    base_url: request.baseUrl,
    model: request.model,
    messages: serializeBackendMessages(request.messages),
    user_content: request.userContent,
    client_job_id: request.clientJobId,
  };

  if (request.systemPrompt) {
    body.system_prompt = request.systemPrompt;
  }
  if (
    request.auxiliary &&
    request.auxiliary.model.trim() &&
    request.auxiliary.apiKey.trim() &&
    request.auxiliary.baseUrl.trim()
  ) {
    body.aux_model = request.auxiliary.model;
    body.aux_api_key = request.auxiliary.apiKey;
    body.aux_base_url = request.auxiliary.baseUrl;
  }
  if (request.supportsVision !== undefined) {
    body.supports_vision = request.supportsVision;
  }
  if (request.context.summary) {
    body.context_summary = request.context.summary;
  }
  if (request.context.summaryUpToMessageId) {
    body.context_summary_up_to_message_id =
      request.context.summaryUpToMessageId;
  }
  if (request.clientContext) {
    body.client_context = buildApiClientContext(request.clientContext);
  }
  if (request.clientToolResults?.length) {
    body.client_tool_results = request.clientToolResults.map((r) => ({
      tool_call_id: r.toolCallId,
      name: r.name,
      result: r.result,
    }));
  }

  let response: Response;
  try {
    const localAgentBaseUrl = await resolveLocalAgentBaseUrl();
    response = await localAgentFetch(`${localAgentBaseUrl}/agent/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : '网络请求失败',
    };
    return;
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      detail = errBody?.detail ?? detail;
    } catch {
      // ignore
    }
    yield { type: 'error', message: detail };
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
        if (event.type === 'tool_pending') return;
      }
    }
    if (!signal.aborted) {
      yield { type: 'done' };
    }
  } finally {
    reader.releaseLock();
  }
}
