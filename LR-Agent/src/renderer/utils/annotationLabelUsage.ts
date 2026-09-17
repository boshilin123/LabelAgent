import type { LabelDefinition } from '../types/annotation';

export type LabelUsageMap = Record<string, number>;

const STORAGE_PREFIX = 'lr-agent:annotationLabelUsage:';
const RECENT_LABEL_LIMIT = 3;

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function loadLabelUsage(projectId: string): LabelUsageMap {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: LabelUsageMap = {};
    for (const [id, count] of Object.entries(parsed)) {
      if (typeof count === 'number' && count > 0) out[id] = count;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLabelUsage(projectId: string, usage: LabelUsageMap): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(usage));
  } catch {
    /* ignore quota / private mode */
  }
}

export function pruneLabelUsage(
  usage: LabelUsageMap,
  validLabelIds: Set<string>,
): LabelUsageMap {
  const out: LabelUsageMap = {};
  for (const [id, count] of Object.entries(usage)) {
    if (validLabelIds.has(id) && count > 0) out[id] = count;
  }
  return out;
}

export function getTopLabelIds(
  labels: LabelDefinition[],
  usage: LabelUsageMap,
  limit = RECENT_LABEL_LIMIT,
): string[] {
  const sorted = [...labels].sort((a, b) => {
    const diff = (usage[b.id] ?? 0) - (usage[a.id] ?? 0);
    if (diff !== 0) return diff;
    return labels.indexOf(a) - labels.indexOf(b);
  });
  return sorted.slice(0, limit).map((l) => l.id);
}

export function orderLabelsForToolbar(
  labels: LabelDefinition[],
  usage: LabelUsageMap,
  activeLabelId: string | null,
): LabelDefinition[] {
  if (labels.length === 0) return [];

  const sorted = [...labels].sort((a, b) => {
    const diff = (usage[b.id] ?? 0) - (usage[a.id] ?? 0);
    if (diff !== 0) return diff;
    return labels.indexOf(a) - labels.indexOf(b);
  });

  if (!activeLabelId) return sorted;

  const activeIndex = sorted.findIndex((label) => label.id === activeLabelId);
  if (activeIndex <= 0) return sorted;

  const next = [...sorted];
  const [active] = next.splice(activeIndex, 1);
  next.unshift(active);
  return next;
}

export function computeVisibleLabelCount(
  orderedLabels: LabelDefinition[],
  chipWidths: Map<string, number>,
  availableWidth: number,
  moreButtonWidth: number,
  chipGap = 6,
): number {
  if (orderedLabels.length === 0 || availableWidth <= 0) return 0;

  let used = 0;
  let count = 0;

  for (let i = 0; i < orderedLabels.length; i++) {
    const chipWidth = chipWidths.get(orderedLabels[i].id) ?? 0;
    const gapBefore = count > 0 ? chipGap : 0;
    const remaining = orderedLabels.length - (i + 1);
    const moreReserve = remaining > 0 ? chipGap + moreButtonWidth : 0;

    if (used + gapBefore + chipWidth + moreReserve <= availableWidth) {
      used += gapBefore + chipWidth;
      count += 1;
    } else {
      break;
    }
  }

  return count;
}

export function splitLabelsForToolbar(
  labels: LabelDefinition[],
  usage: LabelUsageMap,
  activeLabelId: string | null,
  limit = RECENT_LABEL_LIMIT,
): { pinned: LabelDefinition[]; overflow: LabelDefinition[] } {
  if (labels.length <= limit) {
    return { pinned: labels, overflow: [] };
  }

  let pinnedIds = getTopLabelIds(labels, usage, limit);
  const labelById = new Map(labels.map((l) => [l.id, l]));

  if (
    activeLabelId &&
    labelById.has(activeLabelId) &&
    !pinnedIds.includes(activeLabelId)
  ) {
    pinnedIds = [...pinnedIds.slice(0, -1), activeLabelId];
  }

  const pinnedSet = new Set(pinnedIds);
  const pinned = pinnedIds
    .map((id) => labelById.get(id))
    .filter((l): l is LabelDefinition => l != null);
  const overflow = labels.filter((l) => !pinnedSet.has(l.id));

  return { pinned, overflow };
}

export function bumpLabelUsage(
  usage: LabelUsageMap,
  labelId: string,
): LabelUsageMap {
  return { ...usage, [labelId]: (usage[labelId] ?? 0) + 1 };
}
