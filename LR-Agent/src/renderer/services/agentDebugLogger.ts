/**
 * Agent Console 调试日志器。
 *
 * 当 window.__LR_AGENT_DEBUG__ === true 时，将 SSE 事件、请求上下文、
 * Job 状态转换以整齐格式输出到 F12 Console。
 *
 * 使用方式：
 *   window.__LR_AGENT_DEBUG__ = true   // 开启
 *   window.__LR_AGENT_DEBUG__ = false  // 关闭
 *
 * 不影响任何现有逻辑或事件流。
 */

import type {
  ChatMessage,
  ClientContextPayload,
  ClientToolCall,
  ClientToolResult,
  JobState,
  StreamEvent,
} from '../../shared/agentTypes';

// ─── 开关 ───────────────────────────────────────────────────────────────────

function isDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as Window & { __LR_AGENT_DEBUG__?: boolean };
  return w.__LR_AGENT_DEBUG__ === true;
}

// ─── 样式 ───────────────────────────────────────────────────────────────────

const CSS = {
  header: 'color: #ff9800; font-weight: bold; font-size: 13px;',
  eventType: 'color: #2196f3; font-weight: bold;',
  key: 'color: #888;',
  value: 'color: #e0e0e0;',
  tool: 'color: #4caf50;',
  error: 'color: #f44336; font-weight: bold;',
  state: 'color: #9c27b0; font-weight: bold;',
  dim: 'color: #666;',
  muted: 'color: #999; font-style: italic;',
};

const LABEL_PREFIX = '[LR-Agent]';

// ─── 帮助函数 ────────────────────────────────────────────────────────────────

function truncate(s: string, maxLen = 200): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}… (${s.length} 字符)`;
}

function toOneLineJson(obj: unknown, maxLen = 300): string {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen)}… (${s.length} 字符)`;
  } catch {
    return String(obj);
  }
}

function groupId(jobId: string): string {
  return `${LABEL_PREFIX} ${jobId}`;
}

// ─── 日志类 ──────────────────────────────────────────────────────────────────

interface SendContext {
  jobId: string;
  providerId: string;
  sessionId: string;
  messages: { role: string; content: string; messageId?: string | null }[];
  userContent: string;
  clientContext?: ClientContextPayload;
  clientToolResults?: ClientToolResult[];
  isEdit?: boolean;
}

export class AgentDebugLogger {
  private jobId: string;

  private prevState: JobState | null = null;

  /** 内部计数器，给 console.group 生成唯一 ID */
  private _groupSeq = 0;

  constructor(jobId: string) {
    this.jobId = jobId;
  }

  // ── 请求上下文 ──────────────────────────────────────────────────────────

  logSendContext(ctx: SendContext): void {
    if (!isDebugEnabled()) return;

    console.groupCollapsed(
      `%c${LABEL_PREFIX}%c 发送请求 %c${this.jobId}`,
      CSS.header,
      CSS.dim,
      CSS.muted,
    );

    // session & provider
    console.log(`%cprovider%c ${ctx.providerId}`, CSS.key, CSS.value);
    console.log(`%csession%c ${ctx.sessionId}`, CSS.key, CSS.value);

    // clientContext 摘要
    if (ctx.clientContext) {
      const cc = ctx.clientContext;
      console.groupCollapsed('%cclientContext', CSS.key);
      if (cc.workspaceRoot) console.log(`workspaceRoot: ${cc.workspaceRoot}`);
      if (cc.activeFilePath) console.log(`activeFile: ${cc.activeFilePath}`);
      if (cc.annotationProjectSnapshot) {
        const snap = cc.annotationProjectSnapshot;
        console.log(`annotationProject: ${snap.name} (${snap.projectId})`);
        console.log(
          `  modality: ${snap.modality}, type: ${snap.annotationType}`,
        );
        console.log(`  labels: ${snap.labels?.length ?? 0}`);
        console.log(
          `  detectionModels: ${snap.detectionModels?.map((m) => m.name).join(', ') ?? 'none'}`,
        );
      }
      if (cc.mcpServerUrl) console.log(`mcpServer: ${cc.mcpServerUrl}`);
      // 远程 MCP 只打 id/transport：headers 含 Key，部分厂商 URL query 也带 Key
      if (cc.mcpServers?.length) {
        console.log(
          `mcpRemoteServers: ${cc.mcpServers
            .map((server) => `${server.id}(${server.transport})`)
            .join(', ')}`,
        );
      }
      if (cc.agentMode) console.log(`agentMode: ${cc.agentMode}`);
      if (cc.workMode) console.log(`workMode: ${cc.workMode}`);
      console.groupEnd();
    }

    // userContent
    console.log(
      `%cuserContent%c ${truncate(ctx.userContent, 300)}`,
      CSS.key,
      CSS.value,
    );

    // resume ctx
    if (ctx.clientToolResults && ctx.clientToolResults.length > 0) {
      console.groupCollapsed(
        `%cclientToolResults%c (${ctx.clientToolResults.length})`,
        CSS.key,
        CSS.muted,
      );
      for (const r of ctx.clientToolResults) {
        console.log(`${r.name} → ${truncate(r.result, 120)}`);
      }
      console.groupEnd();
    }

    // isEdit
    if (ctx.isEdit) {
      console.log(`%c(isEdit)`, CSS.muted);
    }

    // messages
    console.groupCollapsed(
      `%cmessages%c (${ctx.messages.length})`,
      CSS.key,
      CSS.muted,
    );
    for (const m of ctx.messages) {
      const roleTag =
        m.role === 'system'
          ? '🔧'
          : m.role === 'user'
            ? '👤'
            : m.role === 'assistant'
              ? '🤖'
              : '❓';
      console.log(
        `%c${roleTag} [${m.role}]%c ${truncate(m.content, 200)}`,
        CSS.key,
        CSS.value,
      );
    }
    console.groupEnd();

    console.groupEnd();
  }

  // ── SSE 事件 ──────────────────────────────────────────────────────────────

  logEvent(event: StreamEvent): void {
    if (!isDebugEnabled()) return;

    // Normalize snake_case SSE fields (from model_dump_json) to camelCase
    const e = event as Record<string, unknown>;

    switch (event.type) {
      case 'text_delta':
        // 每个 text_delta 单独打印太啰嗦，跳过；仅第一次输出特殊处理
        break;
      case 'reasoning_delta':
        // 同上，跳过逐条 reasoning
        break;
      case 'tool_start':
        this._logToolStart(event.name, event.arguments);
        break;
      case 'tool_result': {
        const toolCallId = (e.toolCallId ?? e.tool_call_id ?? '') as string;
        this._logToolResult(toolCallId, event.result);
        break;
      }
      case 'tool_pending': {
        const toolCalls = (e.toolCalls ??
          e.client_tool_calls ??
          []) as ClientToolCall[];
        this._logToolPending(toolCalls);
        break;
      }
      case 'route_decided':
        this._logRouteDecided(event.mode, event.domain);
        break;
      case 'preparing':
        this._logPreparing(event.stage);
        break;
      case 'context_updated': {
        const summary = (e.summary ?? '') as string;
        const msgId = (e.summaryUpToMessageId ??
          e.summary_up_to_message_id ??
          '') as string;
        const tokens = (e.tokenEstimate ?? e.token_estimate ?? undefined) as
          number | undefined;
        this._logContextUpdated(summary, msgId, tokens);
        break;
      }
      case 'error':
        this._logError(event.message);
        break;
      case 'file_proposal_start':
        console.log(
          `%c${LABEL_PREFIX}%c 📄 file_proposal_start %c${truncate((e.title ?? e.summary ?? '') as string, 40)}`,
          CSS.header,
          CSS.dim,
          CSS.value,
        );
        break;
      case 'file_proposal':
        console.log(
          `%c${LABEL_PREFIX}%c ✅ file_proposal      %c${(e.suggestedRelativePath ?? e.image_path ?? '') as string}%c (${String((e.content ?? '') as string).length} 字符)`,
          CSS.header,
          CSS.dim,
          CSS.value,
          CSS.muted,
        );
        break;
      case 'file_proposal_delta':
        // 跳过逐条，太啰嗦
        break;
      case 'done':
        console.log(`%c${LABEL_PREFIX}%c ✅ done`, CSS.header, CSS.dim);
        break;
      case 'annotation_progress':
        console.log(
          `%c${LABEL_PREFIX}%c 🏷 annotation_progress %c${event.stage}%c ${event.message}`,
          CSS.header,
          CSS.dim,
          CSS.value,
          CSS.muted,
        );
        break;
      case 'annotation_proposal':
        console.log(
          `%c${LABEL_PREFIX}%c 🏷 annotation_proposal`,
          CSS.header,
          CSS.dim,
        );
        break;
      case 'document_proposal':
        console.log(
          `%c${LABEL_PREFIX}%c 📋 document_proposal %c${truncate((e.title ?? e.summary ?? '') as string, 40)}`,
          CSS.header,
          CSS.dim,
          CSS.value,
        );
        break;
      default:
        console.log(
          `%c${LABEL_PREFIX}%c ? %c${(event as any).type}`,
          CSS.header,
          CSS.dim,
          CSS.muted,
        );
    }
  }

  /** 一轮流式结束后，打印该轮累积的 text 摘要。 */
  logTextOutput(text: string): void {
    if (!isDebugEnabled()) return;
    if (!text.trim()) return;

    console.log(
      `%c${LABEL_PREFIX}%c 💬 LLM 输出 (%c${text.length} 字符%c)`,
      CSS.header,
      CSS.dim,
      CSS.muted,
      CSS.dim,
    );

    const lines = text.split('\n');
    const preview = lines.slice(0, 8).join('\n');
    if (lines.length > 8) {
      console.log(preview);
      const moreLines = lines.length - 8;
      const moreChars = lines.slice(8).join('\n').length;
      console.log(`%c    … (${moreLines} 行 / ${moreChars} 字符)`, CSS.muted);
    } else {
      console.log(preview);
    }
  }

  // ── 状态机 ────────────────────────────────────────────────────────────────

  logJobState(newState: JobState): void {
    if (!isDebugEnabled()) return;

    const from = this.prevState;
    this.prevState = newState;

    const arrow = from ? `${from} → ` : '';
    console.log(
      `%c${LABEL_PREFIX}%c 🔄 State %c${arrow}%c${newState}`,
      CSS.header,
      CSS.dim,
      CSS.state,
      CSS.state,
    );
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private _logToolStart(name: string, args: string): void {
    console.groupCollapsed(
      `%c${LABEL_PREFIX}%c 🔧 ${name}`,
      CSS.header,
      CSS.tool,
    );

    let parsedArgs: unknown = args;
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      // 保持原字符串
    }

    if (typeof parsedArgs === 'object' && parsedArgs !== null) {
      const obj = parsedArgs as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const val = typeof v === 'string' ? v : toOneLineJson(v);
        console.log(`%c${k}:%c ${truncate(val, 200)}`, CSS.key, CSS.value);
      }
    } else {
      console.log(`%cargs:%c ${truncate(args, 300)}`, CSS.key, CSS.value);
    }

    console.groupEnd();
  }

  private _logToolResult(toolCallId: string, result: string): void {
    console.groupCollapsed(
      `%c${LABEL_PREFIX}%c ✅ tool_result %c${toolCallId.slice(0, 10)}`,
      CSS.header,
      CSS.dim,
      CSS.muted,
    );
    console.log(`%cresult:%c ${truncate(result, 500)}`, CSS.key, CSS.value);
    console.groupEnd();
  }

  private _logToolPending(toolCalls: ClientToolCall[]): void {
    console.groupCollapsed(
      `%c${LABEL_PREFIX}%c ⏳ tool_pending (%c${toolCalls.length}%c)`,
      CSS.header,
      CSS.dim,
      CSS.muted,
      CSS.dim,
    );
    for (const tc of toolCalls) {
      console.log(
        `%c${tc.name}%c → ${toOneLineJson(tc.arguments, 200)}`,
        CSS.tool,
        CSS.value,
      );
    }
    console.groupEnd();
  }

  private _logRouteDecided(mode: string, domain: string): void {
    console.log(
      `%c${LABEL_PREFIX}%c 🧭 route_decided %cmode=%c${mode}%c domain=%c${domain}`,
      CSS.header,
      CSS.dim,
      CSS.key,
      CSS.value,
      CSS.key,
      CSS.value,
    );
  }

  private _logPreparing(stage: string): void {
    console.log(
      `%c${LABEL_PREFIX}%c ⏳ preparing %c${stage}`,
      CSS.header,
      CSS.dim,
      CSS.muted,
    );
  }

  private _logContextUpdated(
    summary: string,
    msgId: string,
    tokenEstimate?: number,
  ): void {
    console.groupCollapsed(
      `%c${LABEL_PREFIX}%c 📝 context_updated %c${truncate(summary, 60)}`,
      CSS.header,
      CSS.dim,
      CSS.muted,
    );
    console.log(`summaryUpToMessageId: ${msgId.slice(0, 12)}…`);
    if (tokenEstimate !== undefined) {
      console.log(`tokenEstimate: ${tokenEstimate}`);
    }
    console.groupEnd();
  }

  private _logError(message: string): void {
    console.log(
      `%c${LABEL_PREFIX}%c ❌ error %c${message}`,
      CSS.header,
      CSS.error,
      CSS.error,
    );
  }
}

// ─── 工厂 ────────────────────────────────────────────────────────────────────

export function createDebugLogger(jobId: string): AgentDebugLogger {
  return new AgentDebugLogger(jobId);
}
