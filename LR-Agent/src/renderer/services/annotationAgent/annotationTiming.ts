/** 批量标注各阶段耗时（UI detail + DevTools console） */

export function formatDurationMs(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

export interface SubImageTimingBreakdown {
  total_ms: number;
  read_image_ms?: number;
  stream_ms?: number;
  detect_ms?: number;
  map_ms?: number;
  judge_ms?: number;
  finalize_ms?: number;
  round_count?: number;
}

export function formatSubImageTiming(t: SubImageTimingBreakdown): string {
  const parts: string[] = [`总 ${formatDurationMs(t.total_ms)}`];
  if (t.read_image_ms != null && t.read_image_ms > 0) {
    parts.push(`读图 ${formatDurationMs(t.read_image_ms)}`);
  }
  if (t.stream_ms != null && t.stream_ms > 0) {
    parts.push(`子Agent流 ${formatDurationMs(t.stream_ms)}`);
  }
  if (t.detect_ms != null && t.detect_ms > 0) {
    parts.push(`检测 ${formatDurationMs(t.detect_ms)}`);
  }
  if (t.map_ms != null && t.map_ms > 0) {
    parts.push(`映射 ${formatDurationMs(t.map_ms)}`);
  }
  if (t.judge_ms != null && t.judge_ms > 0) {
    parts.push(`评分 ${formatDurationMs(t.judge_ms)}`);
  }
  if (t.finalize_ms != null && t.finalize_ms > 0) {
    parts.push(`finalize ${formatDurationMs(t.finalize_ms)}`);
  }
  if (t.round_count != null) {
    parts.push(`${t.round_count} 轮`);
  }
  return parts.join(' · ');
}
