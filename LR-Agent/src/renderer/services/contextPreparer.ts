/**
 * 发消息前的上下文准备：窗口裁剪 + token 估算 + 自动摘要触发。
 *
 * - 始终应用 maxTurnsInWindow 硬窗口裁剪（含已有摘要覆盖点之后的消息）
 * - 估算 token 超过 maxContextTokens * summarizeTriggerRatio 且轮数足够时，
 *   把即将被挤出的旧消息交给 LLM 生成增量摘要
 * - 摘要失败时降级为纯裁剪，不阻塞发消息
 */

import {
  DEFAULT_CHAT_CONTEXT_CONFIG,
  type AgentSession,
  type ChatContextConfig,
  type ChatMessage,
} from '../../shared/agentTypes';
import { buildTurnContextFromState, formatTurnLine } from './turnContext';
import {
  summarizeConversation,
  type SummarizeConversationOptions,
} from './contextSummarizer';

export interface PreparedChatContext {
  /** 实际发送给 LLM 的消息 id 列表（窗口裁剪后） */
  windowedMessageIds: string[];
  /** 新生成的摘要（仅 summarized=true 时有值） */
  contextSummary?: string;
  /** 摘要覆盖到的最后一条消息 id（仅 summarized=true 时有值） */
  summaryUpToMessageId?: string;
  /** 本次发送上下文的 token 估算值 */
  tokenEstimate: number;
  /** 本次是否生成了新摘要 */
  summarized: boolean;
}

/** 粗略 token 估算：中英混合场景按 chars/3 折算 */
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 3);
}

export type SummarizeFn = (
  options: SummarizeConversationOptions,
) => Promise<string>;

export interface PrepareChatContextOptions {
  session: AgentSession;
  /** 本次发送的全量消息 id（含新用户消息与助手占位） */
  messageIds: string[];
  sessionMessages: Record<string, ChatMessage>;
  currentUserContent: string;
  provider: { baseUrl: string; apiKey: string; model: string };
  /** 排除的消息 id（如流式中的助手占位消息） */
  excludeMessageIds?: Set<string>;
  config?: ChatContextConfig;
  /** 模型上下文窗口（tokens）；已知时按比例推导预算，未知沿用默认配置 */
  modelContextWindowTokens?: number | null;
  /** 可注入的摘要实现（测试用） */
  summarizeFn?: SummarizeFn;
  signal?: AbortSignal;
}

/** 从模型窗口推导会话预算：取窗口 10%，钳制在 [8K, 48K] */
export function deriveMaxContextTokens(
  modelContextWindowTokens: number | null | undefined,
): number | null {
  if (
    typeof modelContextWindowTokens !== 'number' ||
    !Number.isFinite(modelContextWindowTokens) ||
    modelContextWindowTokens <= 0
  ) {
    return null;
  }
  const MIN_BUDGET_TOKENS = 8_000;
  const MAX_BUDGET_TOKENS = 48_000;
  const derived = Math.round(modelContextWindowTokens * 0.1);
  return Math.min(MAX_BUDGET_TOKENS, Math.max(MIN_BUDGET_TOKENS, derived));
}

/** 摘要覆盖点之后的消息 id 列表 */
function eligibleIdsAfterSummary(
  messageIds: string[],
  summaryUpToMessageId: string | undefined,
): string[] {
  if (!summaryUpToMessageId) return messageIds;
  const cutoff = messageIds.indexOf(summaryUpToMessageId);
  if (cutoff < 0) return messageIds;
  return messageIds.slice(cutoff + 1);
}

export async function prepareChatContext(
  options: PrepareChatContextOptions,
): Promise<PreparedChatContext> {
  const config = options.config ?? DEFAULT_CHAT_CONTEXT_CONFIG;
  const summarizeFn = options.summarizeFn ?? summarizeConversation;
  const derivedBudget = deriveMaxContextTokens(
    options.modelContextWindowTokens,
  );
  const effectiveConfig: ChatContextConfig = derivedBudget
    ? { ...config, maxContextTokens: derivedBudget }
    : config;

  const eligibleIds = eligibleIdsAfterSummary(
    options.messageIds,
    options.session.summaryUpToMessageId,
  );

  const messagesBySession = {
    [options.session.id]: Object.values(options.sessionMessages),
  };
  const turnCtx = buildTurnContextFromState(
    options.session,
    eligibleIds,
    messagesBySession,
    {
      currentUserContent: options.currentUserContent,
      excludeMessageIds: options.excludeMessageIds,
      maxTurnsInWindow: config.maxTurnsInWindow,
    },
  );

  const summaryChars = options.session.contextSummary?.length ?? 0;
  const windowedChars = turnCtx.windowedLines.reduce(
    (total, line) => total + line.content.length,
    0,
  );
  const tokenEstimate = estimateTokensFromChars(windowedChars + summaryChars);

  // 硬窗口裁剪：从窗口内第一条内容消息开始截取（保留其后的非内容消息）
  const windowStartId = turnCtx.windowedLines[0]?.messageId;
  const hardWindowedIds = windowStartId
    ? eligibleIds.slice(eligibleIds.indexOf(windowStartId))
    : eligibleIds;

  const fallback: PreparedChatContext = {
    windowedMessageIds: hardWindowedIds,
    tokenEstimate,
    summarized: false,
  };

  const shouldSummarize =
    tokenEstimate >
      effectiveConfig.maxContextTokens * config.summarizeTriggerRatio &&
    turnCtx.lines.length >= config.minTurnsBeforeSummarize * 2;
  if (!shouldSummarize) return fallback;

  // 触发摘要：仅保留最近一半窗口的轮次，其余压入摘要
  const keepTurns = Math.max(2, Math.ceil(config.maxTurnsInWindow / 2));
  const keepCount = keepTurns * 2;
  const evictedLines = turnCtx.lines.slice(
    0,
    Math.max(0, turnCtx.lines.length - keepCount),
  );
  if (evictedLines.length === 0) return fallback;

  const evictedTranscript = evictedLines
    .map((line) => formatTurnLine(line.role, line.content))
    .join('\n');

  let newSummary: string;
  try {
    newSummary = await summarizeFn({
      baseUrl: options.provider.baseUrl,
      apiKey: options.provider.apiKey,
      model: options.provider.model,
      existingSummary: options.session.contextSummary ?? null,
      evictedTranscript,
      signal: options.signal,
    });
  } catch (err) {
    console.warn('[contextPreparer] 摘要生成失败，降级为纯窗口裁剪:', err);
    return fallback;
  }

  const summaryUpToMessageId = evictedLines[evictedLines.length - 1]!.messageId;
  const summaryCutoff = eligibleIds.indexOf(summaryUpToMessageId);
  const windowedMessageIds =
    summaryCutoff >= 0 ? eligibleIds.slice(summaryCutoff + 1) : eligibleIds;

  const keptChars = turnCtx.lines
    .slice(-keepCount)
    .reduce((total, line) => total + line.content.length, 0);
  const newTokenEstimate = estimateTokensFromChars(
    keptChars + newSummary.length,
  );

  return {
    windowedMessageIds,
    contextSummary: newSummary,
    summaryUpToMessageId,
    tokenEstimate: newTokenEstimate,
    summarized: true,
  };
}
