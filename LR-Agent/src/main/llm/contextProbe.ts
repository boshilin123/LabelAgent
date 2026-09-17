export const CONTEXT_PROBE_TIMEOUT_MS = 30_000;
export const MAX_MODELS_BODY_BYTES = 2 * 1024 * 1024;
const MIN_VALID_WINDOW_TOKENS = 1024;
const MAX_VALID_WINDOW_TOKENS = 10_000_000;

export type ContextWindowSource = '' | 'manual' | 'probe' | 'heuristic';

export interface ContextProbeResult {
  contextWindowTokens: number | null;
  source: ContextWindowSource;
  detail: string;
}

/**
 * 模型名前缀 → 上下文窗口的保守对照表（探测不到字段时的兜底）。
 * 宁小勿大：预算按窗口比例推导，估小只是保守，估大可能冲破模型限制。
 * 更具体的前缀放前面命中更长前缀（heuristicContextWindow 按最长前缀取值），
 * 新一代模型窗口普遍比老代大，代际前缀要单列，不要只靠家族名。
 * 口径基准：2026-09 的公开文档；新模型请优先探测或手填，表只是兜底。
 */
export const MODEL_CONTEXT_WINDOW_TABLE: ReadonlyArray<
  readonly [prefix: string, tokens: number]
> = [
  // DeepSeek：V4 系列原生 1M；V3.x 为 128K
  ['deepseek-v4', 1_000_000],
  ['deepseek', 128_000],
  // Qwen：3.5/3.8 代百炼 API 为 1M（开源版 262K，YaRN 可扩 1M）；3.x 及更早 128K
  ['qwen3.8', 1_000_000],
  ['qwen3.5', 1_000_000],
  ['qwen3', 131_072],
  ['qwen', 131_072],
  ['qwen-long', 10_000_000],
  // GLM：5.x 为 1M 无损上下文；4.x 为 128K
  ['glm-5', 1_000_000],
  ['glm', 128_000],
  // Kimi：K2.5 起为 256K（262,144）
  ['kimi-k2.5', 262_144],
  ['kimi-k2.6', 262_144],
  ['kimi-k2.7', 262_144],
  ['kimi', 131_072],
  ['moonshot', 131_072],
  // OpenAI
  ['gpt-5', 400_000],
  ['o3', 200_000],
  ['o1', 200_000],
  ['gpt-4.1', 1_047_576],
  ['gpt-4o', 128_000],
  // Anthropic / Google
  ['claude', 200_000],
  ['gemini-3', 1_000_000],
  ['gemini', 1_000_000],
  // 开源系常见底座
  ['llama', 128_000],
  ['mistral', 128_000],
];

export function modelsListUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/models`.replace(/([^:])\/\//g, '$1/');
}

export function isValidContextWindowTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_VALID_WINDOW_TOKENS &&
    value <= MAX_VALID_WINDOW_TOKENS
  );
}

/** /models 条目里可能携带窗口的字段（OpenRouter: context_length，vLLM: max_model_len 等） */
function windowFromModelEntry(entry: unknown): number | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const candidates = [
    record.context_length,
    record.max_model_len,
    record.context_window,
  ];
  for (const candidate of candidates) {
    if (isValidContextWindowTokens(candidate)) return candidate;
  }
  return null;
}

function normalizeModelId(id: string): string {
  return id.trim().toLowerCase();
}

/** 精确匹配或段边界后缀匹配（'openai/gpt-4o' ↔ 'gpt-4o'） */
export function matchModelsEntry(
  entries: unknown,
  model: string,
): unknown | null {
  if (!Array.isArray(entries)) return null;
  const target = normalizeModelId(model);
  if (!target) return null;
  let suffixMatch: unknown = null;
  for (const entry of entries) {
    const id =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>).id
        : null;
    if (typeof id !== 'string') continue;
    const candidate = normalizeModelId(id);
    if (candidate === target) return entry;
    if (
      suffixMatch === null &&
      (candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`))
    ) {
      suffixMatch = entry;
    }
  }
  return suffixMatch;
}

/** 按模型名前缀查保守对照表；前缀取最长匹配 */
export function heuristicContextWindow(model: string): number | null {
  const target = normalizeModelId(model);
  if (!target) return null;
  let best: { prefix: string; tokens: number } | null = null;
  for (const [prefix, tokens] of MODEL_CONTEXT_WINDOW_TABLE) {
    if (
      target.startsWith(prefix) &&
      (!best || prefix.length > best.prefix.length)
    ) {
      best = { prefix, tokens };
    }
  }
  return best ? best.tokens : null;
}

export function interpretModelsResponse(
  status: number,
  bodyText: string,
  model: string,
): ContextProbeResult {
  if (status < 200 || status >= 300) {
    return {
      contextWindowTokens: null,
      source: '',
      detail: `probe_error:http_${status}`,
    };
  }
  try {
    const data = JSON.parse(bodyText) as { data?: unknown };
    const entries = Array.isArray(data?.data) ? data.data : null;
    const entry = entries ? matchModelsEntry(entries, model) : null;
    const fromEntry = entry !== null ? windowFromModelEntry(entry) : null;
    if (fromEntry !== null) {
      return {
        contextWindowTokens: fromEntry,
        source: 'probe',
        detail: 'probe_ok',
      };
    }
  } catch {
    return {
      contextWindowTokens: null,
      source: '',
      detail: 'probe_error:invalid_json',
    };
  }
  const heuristic = heuristicContextWindow(model);
  if (heuristic !== null) {
    return {
      contextWindowTokens: heuristic,
      source: 'heuristic',
      detail: 'heuristic_name_match',
    };
  }
  return { contextWindowTokens: null, source: '', detail: 'window_unknown' };
}

async function fetchModelsList(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<{ status: number; bodyText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const text = await response.text();
    const bodyText =
      Buffer.byteLength(text, 'utf8') > MAX_MODELS_BODY_BYTES
        ? 'body_too_large'
        : text;
    return { status: response.status, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

export interface ContextProbeRequestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function runContextProbeRequest(
  input: ContextProbeRequestInput,
): Promise<ContextProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? CONTEXT_PROBE_TIMEOUT_MS;
  const url = modelsListUrl(input.baseUrl);
  try {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        contextWindowTokens: null,
        source: '',
        detail: 'probe_error:invalid_url',
      };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        contextWindowTokens: null,
        source: '',
        detail: 'probe_error:invalid_url',
      };
    }
    const { status, bodyText } = await fetchModelsList(
      fetchImpl,
      url,
      input.apiKey,
      timeoutMs,
    );
    return interpretModelsResponse(status, bodyText, input.model);
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : 'unknown';
    return {
      contextWindowTokens: null,
      source: '',
      detail: `probe_error:${name}`,
    };
  }
}
