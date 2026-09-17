import type { BboxQualityBox } from './types';

export interface NormalizedBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeIoU(a: NormalizedBbox, b: NormalizedBbox): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - inter;
  if (union <= 0) return 0;
  return inter / union;
}

export function findDuplicatePairs(
  boxes: BboxQualityBox[],
  threshold = 0.9,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const iou = computeIoU(boxes[i], boxes[j]);
      if (iou >= threshold) {
        pairs.push([boxes[i].id, boxes[j].id]);
      }
    }
  }
  return pairs;
}

export function computeLabelEntropy(counts: Record<string, number>): number {
  const values = Object.values(counts).filter((n) => n > 0);
  const total = values.reduce((sum, n) => sum + n, 0);
  if (total <= 0 || values.length <= 1) return 0;

  let entropy = 0;
  for (const count of values) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(values.length);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}
