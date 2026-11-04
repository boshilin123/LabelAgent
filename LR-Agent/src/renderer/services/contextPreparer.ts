/**
 * 发送前准备：默认按模型窗口 80% 管理消息；仅在摘要成功后移出历史。
 * 可选 turns 策略兼容轮数窗口，但即将溢出的未摘要内容也必须先摘要。
 */
import {
  DEFAULT_CHAT_CONTEXT_CONFIG,
  type AgentSession,
  type ChatContextConfig,
  type ChatMessage,
} from '../../shared/agentTypes';
import { buildTurnContextFromState, formatTurnLine } from './turnContext';
import { buildBackendMessages } from './backendChatClient';
import { deriveMaxContextTokens, estimateTokens } from './contextBudget';
import {
  summarizeConversation,
  type SummarizeConversationOptions,
} from './contextSummarizer';

export { deriveMaxContextTokens, estimateTokens } from './contextBudget';

export interface PreparedChatContext {
  /** 实际发送的消息，不修改数据库或原始消息数组。 */
  windowedMessageIds: string[];
  contextSummary?: string;
  summaryUpToMessageId?: string;
  tokenEstimate: number;
  summarized: boolean;
}

export type SummarizeFn = (
  options: SummarizeConversationOptions,
) => Promise<string>;

export interface PrepareChatContextOptions {
  session: AgentSession;
  messageIds: string[];
  sessionMessages: Record<string, ChatMessage>;
  currentUserContent: string;
  provider: { baseUrl: string; apiKey: string; model: string };
  excludeMessageIds?: Set<string>;
  config?: ChatContextConfig;
  modelContextWindowTokens?: number | null;
  summarizeFn?: SummarizeFn;
  signal?: AbortSignal;
}

function eligibleIdsAfterSummary(
  messageIds: string[],
  summaryUpToMessageId: string | undefined,
): string[] {
  if (!summaryUpToMessageId) return messageIds;
  const cutoff = messageIds.indexOf(summaryUpToMessageId);
  return cutoff < 0 ? messageIds : messageIds.slice(cutoff + 1);
}

export async function prepareChatContext(
  options: PrepareChatContextOptions,
): Promise<PreparedChatContext> {
  const config = options.config ?? DEFAULT_CHAT_CONTEXT_CONFIG;
  const budget =
    deriveMaxContextTokens(options.modelContextWindowTokens) ??
    config.maxContextTokens;
  const summarizeFn = options.summarizeFn ?? summarizeConversation;
  const eligibleIds = eligibleIdsAfterSummary(
    options.messageIds,
    options.session.summaryUpToMessageId,
  );
  if (
    eligibleIds.some(
      (id) =>
        !options.sessionMessages[id] && !options.excludeMessageIds?.has(id),
    )
  ) {
    throw new Error('部分历史消息尚未加载，请重新打开会话后重试。');
  }
  const buildMessages = (ids: string[]) =>
    buildBackendMessages(ids, options.sessionMessages, {
      excludeMessageIds: options.excludeMessageIds,
    });
  // 计入实际序列化的消息、工具调用与结果，避免只数界面上的回答文字。
  const estimate = (ids: string[], summary: string) =>
    estimateTokens(JSON.stringify(buildMessages(ids))) +
    estimateTokens(summary);
  const existingSummary = options.session.contextSummary ?? '';
  const tokenEstimate = estimate(eligibleIds, existingSummary);
  const unchanged: PreparedChatContext = {
    windowedMessageIds: eligibleIds,
    tokenEstimate,
    summarized: false,
  };
  const turnCtx = buildTurnContextFromState(
    options.session,
    eligibleIds,
    { [options.session.id]: Object.values(options.sessionMessages) },
    {
      currentUserContent: options.currentUserContent,
      excludeMessageIds: options.excludeMessageIds,
      maxTurnsInWindow: 0,
    },
  );
  const windowOverflow =
    config.windowStrategy === 'turns' &&
    config.maxTurnsInWindow > 0 &&
    turnCtx.lines.length > config.maxTurnsInWindow * 2;
  const thresholdReached =
    tokenEstimate > budget * config.summarizeTriggerRatio &&
    turnCtx.lines.length >= config.minTurnsBeforeSummarize * 2;
  if (!windowOverflow && !thresholdReached && tokenEstimate <= budget) {
    return unchanged;
  }

  // 以用户消息为边界，整组保留助手消息及其工具记录，不从一问一答中间切开。
  const userPositions = eligibleIds
    .map((id, index) =>
      options.sessionMessages[id]?.role === 'user' &&
      !options.excludeMessageIds?.has(id)
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  if (userPositions.length < 2) {
    if (tokenEstimate <= budget) return unchanged;
    throw new Error(
      '当前一轮内容超过模型的会话预算，请缩短输入或更换更大窗口的模型。',
    );
  }
  const keepTurns = Math.max(
    1,
    Math.ceil((config.maxTurnsInWindow > 0 ? config.maxTurnsInWindow : 20) / 2),
  );
  let start = Math.max(1, userPositions.length - keepTurns);
  const summaryReserve = Math.min(
    2_048,
    Math.max(32, Math.floor(budget * 0.1)),
  );
  while (
    start < userPositions.length - 1 &&
    estimate(eligibleIds.slice(userPositions[start]), '') >
      budget - summaryReserve
  ) {
    start += 1;
  }
  const split = userPositions[start];
  const evictedIds = eligibleIds.slice(0, split);
  const keptIds = eligibleIds.slice(split);
  if (estimate(keptIds, '') > budget) {
    throw new Error(
      '最近一轮内容超过模型的会话预算，无法通过压缩更早历史解决，请缩短输入。',
    );
  }
  // 摘要读取完整原记录，不套用正常请求“仅回放最近 6 条助手工具历史”的规则。
  const linesById = new Map(
    turnCtx.lines.map((line) => [line.messageId, line]),
  );
  const evictedTranscript = evictedIds
    .filter((id) => !options.excludeMessageIds?.has(id))
    .map((id) => {
      const message = options.sessionMessages[id];
      const line = linesById.get(id);
      const parts = line ? [formatTurnLine(line.role, line.content)] : [];
      for (const block of message.blocks) {
        if (block.type === 'tool_call') {
          parts.push(
            '历史工具记录: ' +
              JSON.stringify({
                id: block.id,
                name: block.name,
                arguments: block.arguments,
                result: block.result,
              }),
          );
        }
      }
      return parts.join('\n');
    })
    .filter(Boolean)
    .join('\n');

  let newSummary: string;
  try {
    newSummary = (
      await summarizeFn({
        baseUrl: options.provider.baseUrl,
        apiKey: options.provider.apiKey,
        model: options.provider.model,
        existingSummary: existingSummary || null,
        evictedTranscript,
        contextWindowTokens: options.modelContextWindowTokens,
        signal: options.signal,
      })
    ).trim();
    if (!newSummary) throw new Error('empty_summary');
  } catch {
    // 摘要失败不推进覆盖点、不丢消息；仍在预算内时可以原文继续。
    if (tokenEstimate <= budget && !options.signal?.aborted) return unchanged;
    throw new Error(
      '对话摘要失败，历史消息已保留。请重试或检查摘要模型配置，未继续发送超预算请求。',
    );
  }
  const newTokenEstimate = estimate(keptIds, newSummary);
  if (newTokenEstimate > budget) {
    throw new Error(
      '摘要后内容仍超过模型会话预算，历史消息已保留，请缩短最近输入后重试。',
    );
  }
  return {
    windowedMessageIds: keptIds,
    contextSummary: newSummary,
    summaryUpToMessageId: evictedIds[evictedIds.length - 1],
    tokenEstimate: newTokenEstimate,
    summarized: true,
  };
}
