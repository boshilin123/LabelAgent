import { diffLines } from 'diff';

export type DiffLineKind = 'unchanged' | 'added' | 'removed';

export interface DiffDisplayLine {
  kind: DiffLineKind;
  text: string;
}

export interface LineDiffResult {
  additions: number;
  deletions: number;
  lines: DiffDisplayLine[];
}

/**
 * 行级 diff，主要用于 +/- 统计与占位判断；
 * diff 的可视化渲染统一交给 MonacoDiffView（Monaco DiffEditor）。
 */
export function computeLineDiff(
  oldText: string,
  newText: string,
): LineDiffResult {
  const parts = diffLines(oldText, newText);
  const lines: DiffDisplayLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (const part of parts) {
    const partLines = part.value.replace(/\n$/, '').split('\n');
    if (
      part.value.endsWith('\n') &&
      partLines.length === 1 &&
      partLines[0] === ''
    ) {
      partLines.pop();
    }
    for (const line of partLines) {
      if (part.added) {
        additions += 1;
        lines.push({ kind: 'added', text: line });
      } else if (part.removed) {
        deletions += 1;
        lines.push({ kind: 'removed', text: line });
      } else {
        lines.push({ kind: 'unchanged', text: line });
      }
    }
  }

  return { additions, deletions, lines };
}

export function proposalAnchorId(
  messageId: string,
  blockIndex: number,
): string {
  return `proposal-${messageId}-${blockIndex}`;
}

export function scrollToProposalAnchor(
  messageId: string,
  blockIndex: number,
): void {
  const id = proposalAnchorId(messageId, blockIndex);
  document
    .querySelector(`[data-proposal-id="${id}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
