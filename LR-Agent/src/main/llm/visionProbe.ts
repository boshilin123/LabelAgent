import { deflateSync } from 'node:zlib';

export const VISION_PROBE_TIMEOUT_MS = 90_000;
export const VISION_PROBE_MAX_TOKENS = 64;
export const VISION_PROBE_PROMPT =
  '这是一张纯色测试图。请只回复一个大写字母 OK，不要其它内容。';

export interface VisionProbeResult {
  supportsVision: boolean;
  detail: string;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 32×32 暗红 PNG data URL，满足常见 VL 最小边长，且不依赖 canvas。 */
export function solidColorPngDataUrl(width = 32, height = 32): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3;
      raw[i] = 180;
      raw[i + 1] = 60;
      raw[i + 2] = 60;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

export function clipProbeText(text: string, max = 160): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/chat/completions`.replace(/([^:])\/\//g, '$1/');
}

export function buildVisionProbeBody(
  model: string,
  imageDataUrl: string,
  options?: { enableThinkingFalse?: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROBE_PROMPT },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    max_tokens: VISION_PROBE_MAX_TOKENS,
    stream: false,
  };
  if (options?.enableThinkingFalse) {
    body.enable_thinking = false;
  }
  return body;
}

export const MAX_PROBE_BODY_BYTES = 64 * 1024;

export function shouldRetryWithoutThinking(
  status: number,
  bodyText: string,
): boolean {
  if (status !== 400 || !/enable_thinking/i.test(bodyText)) {
    return false;
  }
  if (/must be set to false|must be false/i.test(bodyText)) {
    return false;
  }
  return /not supported|unknown|unrecognized|unexpected|extra inputs/i.test(
    bodyText,
  );
}

function safeJsonSnippet(value: unknown): string {
  try {
    return clipProbeText(JSON.stringify(value ?? null) ?? 'null');
  } catch {
    return 'unserializable';
  }
}

/** HTTP 2xx 且为 chat completion JSON 才视为有视觉；不要求回复包含 OK。 */
export function interpretVisionProbeHttp(
  status: number,
  bodyText: string,
): VisionProbeResult {
  if (bodyText === 'body_too_large') {
    return { supportsVision: false, detail: 'probe_error:body_too_large' };
  }
  if (status < 200 || status >= 300) {
    return {
      supportsVision: false,
      detail: `probe_error:http_${status}:${clipProbeText(bodyText) || 'empty_body'}`,
    };
  }
  try {
    const data = JSON.parse(bodyText) as {
      error?: unknown;
      choices?: unknown;
    };
    if (data?.error != null) {
      return {
        supportsVision: false,
        detail: `probe_error:http_${status}:${clipProbeText(bodyText)}`,
      };
    }
    if (!Array.isArray(data?.choices)) {
      return {
        supportsVision: false,
        detail: `probe_error:http_${status}:not_chat_completion`,
      };
    }
    return { supportsVision: true, detail: 'probe_ok' };
  } catch {
    return {
      supportsVision: false,
      detail: `probe_error:http_${status}:invalid_json`,
    };
  }
}

export function interpretVisionProbeException(err: unknown): VisionProbeResult {
  if (err instanceof Error) {
    const name =
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? err.name
        : err.name || 'Error';
    return {
      supportsVision: false,
      detail: `probe_error:${name}:${clipProbeText(err.message, 200)}`,
    };
  }
  return {
    supportsVision: false,
    detail: `probe_error:unknown:${safeJsonSnippet(err)}`,
  };
}

export interface VisionProbeRequestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  imageDataUrl?: string;
}

export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid_probe_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('invalid_probe_url');
  }
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const length = Number(response.headers?.get?.('content-length') ?? '0');
  if (Number.isFinite(length) && length > maxBytes) {
    return 'body_too_large';
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? 'body_too_large' : text;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return 'body_too_large';
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function postVisionProbe(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; bodyText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const bodyText = await readBodyCapped(response, MAX_PROBE_BODY_BYTES);
    return { status: response.status, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

export async function runVisionProbeRequest(
  input: VisionProbeRequestInput,
): Promise<VisionProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? VISION_PROBE_TIMEOUT_MS;
  const imageDataUrl = input.imageDataUrl ?? solidColorPngDataUrl();
  const url = chatCompletionsUrl(input.baseUrl);
  const withThinkingOff = buildVisionProbeBody(input.model, imageDataUrl, {
    enableThinkingFalse: true,
  });

  try {
    assertHttpUrl(url);
    let result = await postVisionProbe(
      fetchImpl,
      url,
      input.apiKey,
      withThinkingOff,
      timeoutMs,
    );
    if (shouldRetryWithoutThinking(result.status, result.bodyText)) {
      result = await postVisionProbe(
        fetchImpl,
        url,
        input.apiKey,
        buildVisionProbeBody(input.model, imageDataUrl),
        timeoutMs,
      );
    }
    return interpretVisionProbeHttp(result.status, result.bodyText);
  } catch (err: unknown) {
    return interpretVisionProbeException(err);
  }
}
