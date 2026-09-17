import type { LabelDefinition } from '../../../types/annotation';
import type { SpanAnnotation } from '../../../types/annotationDocument';
import { resolveLabelId } from './labelResolve';

export interface RawSpanRow {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  labelId?: unknown;
  labelName?: unknown;
}

export interface ValidatedSpan {
  start: number;
  end: number;
  labelId: string;
  text: string;
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function locateSpanInSource(
  sourceText: string,
  spanText: string,
  hintStart?: number,
): { start: number; end: number } | null {
  const needle = spanText.trim();
  if (!needle) return null;

  if (hintStart != null && Number.isFinite(hintStart)) {
    const start = Math.max(0, Math.floor(hintStart));
    const end = start + needle.length;
    if (end <= sourceText.length && sourceText.slice(start, end) === needle) {
      return { start, end };
    }
  }

  let idx = sourceText.indexOf(needle);
  if (idx >= 0) {
    return { start: idx, end: idx + needle.length };
  }

  const normalizedSource = normalizeForMatch(sourceText);
  const normalizedNeedle = normalizeForMatch(needle);
  if (!normalizedNeedle) return null;
  idx = normalizedSource.indexOf(normalizedNeedle);
  if (idx < 0) return null;

  let rawStart = 0;
  let normPos = 0;
  while (rawStart < sourceText.length && normPos < idx) {
    if (/\s/.test(sourceText[rawStart] ?? '')) {
      while (
        rawStart < sourceText.length &&
        /\s/.test(sourceText[rawStart] ?? '')
      ) {
        rawStart += 1;
      }
      normPos += 1;
      continue;
    }
    rawStart += 1;
    normPos += 1;
  }
  const start = rawStart;
  const end = Math.min(sourceText.length, start + needle.length);
  return { start, end };
}

export function validateSpanRows(
  sourceText: string,
  rows: RawSpanRow[],
  labels: LabelDefinition[],
): { spans: ValidatedSpan[]; skipped: number } {
  const validated: ValidatedSpan[] = [];
  let skipped = 0;

  for (const row of rows) {
    const labelId = resolveLabelId(row.labelId, row.labelName, labels);
    if (!labelId) {
      skipped += 1;
      continue;
    }

    const spanText =
      typeof row.text === 'string'
        ? row.text
        : typeof row.start === 'number' && typeof row.end === 'number'
          ? sourceText.slice(row.start, row.end)
          : '';
    if (!spanText.trim()) {
      skipped += 1;
      continue;
    }

    let start: number;
    let end: number;
    if (
      typeof row.start === 'number' &&
      typeof row.end === 'number' &&
      row.end > row.start &&
      row.end <= sourceText.length
    ) {
      start = row.start;
      end = row.end;
      const slice = sourceText.slice(start, end);
      if (normalizeForMatch(slice) !== normalizeForMatch(spanText)) {
        const located = locateSpanInSource(sourceText, spanText);
        if (!located) {
          skipped += 1;
          continue;
        }
        start = located.start;
        end = located.end;
      }
    } else {
      const located = locateSpanInSource(sourceText, spanText);
      if (!located) {
        skipped += 1;
        continue;
      }
      start = located.start;
      end = located.end;
    }

    if (start < 0 || end > sourceText.length || start >= end) {
      skipped += 1;
      continue;
    }

    validated.push({
      start,
      end,
      labelId,
      text: sourceText.slice(start, end),
    });
  }

  return { spans: resolveOverlaps(validated), skipped };
}

function resolveOverlaps(spans: ValidatedSpan[]): ValidatedSpan[] {
  if (spans.length <= 1) return spans;
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: ValidatedSpan[] = [];

  for (const span of sorted) {
    const last = out[out.length - 1];
    if (!last) {
      out.push(span);
      continue;
    }
    if (span.start >= last.end) {
      out.push(span);
      continue;
    }
    if (span.labelId === last.labelId) {
      last.end = Math.max(last.end, span.end);
      last.text = last.text.length >= span.text.length ? last.text : span.text;
      continue;
    }
    out.push(span);
  }

  return out;
}

export function validatedSpansToAnnotations(
  spans: ValidatedSpan[],
): SpanAnnotation[] {
  const now = new Date().toISOString();
  return spans.map((span) => ({
    id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'span_ner' as const,
    labelId: span.labelId,
    start: span.start,
    end: span.end,
    createdAt: now,
    updatedAt: now,
  }));
}
