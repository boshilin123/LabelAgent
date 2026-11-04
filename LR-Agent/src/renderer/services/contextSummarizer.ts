/**
 * 对话上下文摘要器：前端直连 LLM（OpenAI 兼容 /chat/completions，非流式）。
 *
 * 用于把被上下文窗口挤出的旧对话压缩为增量摘要，保持后端无状态。
 * 大段历史按摘要模型自身的预算分批合并；失败时不推进摘要覆盖点。
 */

import {
  deriveMaxContextTokens,
  estimateTokens,
  UNKNOWN_MODEL_CONTEXT_BUDGET,
} from './contextBudget';

const SUMMARY_SYSTEM_PROMPT = `你是对话摘要助手。请把提供的对话内容压缩为一段简洁的中文摘要，用于后续对话的上下文提示。
要求：
- 保留用户的任务目标、关键决定、明确的偏好与约束
- 保留标注项目相关的信息（项目名、标签、标注类型、涉及的文件/目录）
- 保留已完成操作的结论（如已标注哪些文件、分析结果要点）
- 省略寒暄、重复内容与中间过程细节
- 直接输出摘要正文，不要任何前缀或解释，长度控制在 500 字以内`;

export interface SummarizeConversationOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 已有摘要（增量合并的基础），无则为 null */
  existingSummary: string | null;
  /** 本次被窗口挤出的对话 transcript */
  evictedTranscript: string;
  /** 摘要模型自身的窗口，可小于会话主模型。 */
  contextWindowTokens?: number | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_SUMMARIZE_TIMEOUT_MS = 30_000;

function buildUserPrompt(options: SummarizeConversationOptions): string {
  const parts: string[] = [];
  if (options.existingSummary?.trim()) {
    parts.push(`【已有摘要】\n${options.existingSummary.trim()}`);
  }
  parts.push(`【新增对话内容】\n${options.evictedTranscript.trim()}`);
  parts.push(
    options.existingSummary?.trim()
      ? '请把已有摘要与新增对话内容合并为一段更新后的摘要。'
      : '请对以上对话内容生成摘要。',
  );
  return parts.join('\n\n');
}

/**
 * 生成（或增量更新）对话摘要。失败时抛出异常，由调用方降级处理。
 */
async function summarizeChunk(
  options: SummarizeConversationOptions,
): Promise<string> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`.replace(
    /([^:])\/\//g,
    '$1/',
  );

  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(),
    options.timeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS,
  );
  const abortListener = () => timeoutController.abort();
  options.signal?.addEventListener('abort', abortListener);
  if (options.signal?.aborted) timeoutController.abort();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(options) },
        ],
        stream: false,
        temperature: 0.2,
        max_tokens: Math.min(
          1024,
          options.contextWindowTokens &&
            deriveMaxContextTokens(options.contextWindowTokens)
            ? options.contextWindowTokens -
                deriveMaxContextTokens(options.contextWindowTokens)!
            : 1024,
        ),
      }),
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      throw new Error(`摘要请求失败: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('摘要请求返回空内容');
    }
    return content;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortListener);
  }
}

/** 按摘要模型的可用窗口分批处理，所有批次成功后才向调用方返回最终摘要。 */
export async function summarizeConversation(
  options: SummarizeConversationOptions,
): Promise<string> {
  const budget =
    deriveMaxContextTokens(options.contextWindowTokens) ??
    UNKNOWN_MODEL_CONTEXT_BUDGET;
  let remaining = options.evictedTranscript.trim();
  let summary = options.existingSummary?.trim() || null;
  if (!remaining) throw new Error('没有可供摘要的历史内容');

  while (remaining) {
    const overhead =
      estimateTokens(SUMMARY_SYSTEM_PROMPT) +
      estimateTokens(summary ?? '') +
      128;
    const available = budget - overhead;
    if (available <= 0) throw new Error('已有摘要超过摘要模型的输入预算');
    let end = remaining.length;
    if (estimateTokens(remaining) > available) {
      let low = 0;
      let high = remaining.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (estimateTokens(remaining.slice(0, middle)) <= available)
          low = middle;
        else high = middle - 1;
      }
      end = low;
      // 优先在完整行处分批；过长的单行仍可按预算拆分。
      const newline = remaining.lastIndexOf('\n', end - 1);
      if (newline >= end / 2) end = newline + 1;
      const lastCode = remaining.charCodeAt(end - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
    }
    if (end <= 0) throw new Error('摘要模型窗口不足以处理历史内容');
    summary = await summarizeChunk({
      ...options,
      existingSummary: summary,
      evictedTranscript: remaining.slice(0, end),
    });
    remaining = remaining.slice(end).trimStart();
  }
  return summary ?? '';
}
