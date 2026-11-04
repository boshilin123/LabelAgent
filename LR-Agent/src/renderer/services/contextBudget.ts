/**
 * 应用会话预算。已知窗口取 80%，未知时保留明确兜底。
 * token 估算用于发送前控制，不代替不同提供商的实际 usage。
 */
export const MODEL_CONTEXT_USAGE_RATIO = 0.8;
export const UNKNOWN_MODEL_CONTEXT_BUDGET = 12_000;

export function deriveMaxContextTokens(
  modelContextWindowTokens: number | null | undefined,
): number | null {
  if (
    typeof modelContextWindowTokens !== 'number' ||
    !Number.isSafeInteger(modelContextWindowTokens) ||
    modelContextWindowTokens <= 1
  ) {
    return null;
  }
  return Math.floor(modelContextWindowTokens * MODEL_CONTEXT_USAGE_RATIO);
}

/** 英文按约 chars/3、中文等非 ASCII 字符保守按 1 token，补充字符按 2。 */
export function estimateTokens(text: string): number {
  let asciiChars = 0;
  let otherTokens = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) asciiChars += 1;
    else otherTokens += codePoint > 0xffff ? 2 : 1;
  }
  return Math.ceil(asciiChars / 3) + otherTokens;
}
