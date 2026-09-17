/** Shared LLM API call utility for annotation generation pipelines. */

import { localAgentFetch, resolveLocalAgentBaseUrl } from '../../../config';

export interface LlmCallOptions {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Optional absolute image path — backend reads disk directly (preferred, avoids base64 transfer) */
  imageAbsolutePath?: string;
  /** Optional base64-encoded image for vision models (fallback when no path) */
  imageBase64?: string;
  imageMimeType?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmCallResult {
  ok: boolean;
  content: string;
  error?: string;
}

/**
 * 通过 LR-Agent-local 代理调用 LLM。
 *
 * 生成类标注（caption/cot/instruction 等）统一走本地 Agent，
 * 避免 renderer 直连 LLM Provider 带来的 CORS / 路径问题。
 */
export async function callLlmApi(
  options: LlmCallOptions,
): Promise<LlmCallResult> {
  try {
    const baseUrl = await resolveLocalAgentBaseUrl();
    const response = await localAgentFetch(
      `${baseUrl}/agent/annotation/llm-generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: options.providerId,
          api_key: options.apiKey,
          base_url: options.baseUrl,
          model: options.model,
          system_prompt: options.systemPrompt,
          user_prompt: options.userPrompt,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 4096,
          image_absolute_path: options.imageAbsolutePath ?? '',
          image_base64: options.imageBase64 ?? '',
          image_mime_type: options.imageMimeType ?? 'image/jpeg',
        }),
        signal: options.signal,
      },
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        ok: false,
        content: '',
        error: `本地 Agent 错误 ${response.status}: ${errText.slice(0, 200)}`,
      };
    }

    const json = (await response.json()) as {
      data?: { ok?: boolean; content?: string; error?: string };
    };
    const data = json.data ?? {};
    if (data.ok === false) {
      return {
        ok: false,
        content: '',
        error: data.error ?? 'LLM 生成失败',
      };
    }
    return { ok: true, content: data.content ?? '' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, content: '', error: '已取消' };
    }
    return {
      ok: false,
      content: '',
      error: err instanceof Error ? err.message : 'LLM 调用失败',
    };
  }
}
