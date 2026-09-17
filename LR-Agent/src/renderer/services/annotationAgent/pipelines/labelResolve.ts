import type { LabelDefinition } from '../../../types/annotation';

export function resolveLabelId(
  labelId: unknown,
  labelName: unknown,
  labels: LabelDefinition[],
): string | null {
  if (typeof labelId === 'string' && labelId.trim()) {
    const found = labels.find((l) => l.id === labelId.trim());
    if (found) return found.id;
  }

  if (typeof labelName === 'string' && labelName.trim()) {
    const needle = labelName.trim().toLowerCase();
    const exact = labels.find((l) => l.name.trim().toLowerCase() === needle);
    if (exact) return exact.id;

    const fuzzy = labels.find(
      (l) =>
        l.name.toLowerCase().includes(needle) ||
        needle.includes(l.name.toLowerCase()),
    );
    if (fuzzy) return fuzzy.id;
  }

  return null;
}

export function resolveUniqueLabelIds(
  rows: Array<{ labelId?: unknown; labelName?: unknown }>,
  labels: LabelDefinition[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const id = resolveLabelId(row.labelId, row.labelName, labels);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
