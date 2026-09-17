import type { Rect } from 'fabric';
import type { BboxAnnotation } from '../../../types/annotationDocument';

export const MIN_BOX_PX = 5;
export const VIEWPORT_EDGE_PAD = 8;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export interface FabricRectPixels {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Normalized bbox → scene pixels (natural image coordinate system). */
export function normToSceneRect(
  ann: Pick<BboxAnnotation, 'x' | 'y' | 'width' | 'height'>,
  naturalWidth: number,
  naturalHeight: number,
): FabricRectPixels {
  return {
    left: ann.x * naturalWidth,
    top: ann.y * naturalHeight,
    width: ann.width * naturalWidth,
    height: ann.height * naturalHeight,
  };
}

/** Scene pixels → normalized bbox (0–1 vs natural image size). */
export function sceneRectToNorm(
  rect: FabricRectPixels,
  naturalWidth: number,
  naturalHeight: number,
): Pick<BboxAnnotation, 'x' | 'y' | 'width' | 'height'> {
  const nw = naturalWidth > 0 ? naturalWidth : 1;
  const nh = naturalHeight > 0 ? naturalHeight : 1;
  return {
    x: clamp01(rect.left / nw),
    y: clamp01(rect.top / nh),
    width: clamp01(rect.width / nw),
    height: clamp01(rect.height / nh),
  };
}

export function fabricRectToScenePixels(rect: Rect): FabricRectPixels {
  return {
    left: rect.left ?? 0,
    top: rect.top ?? 0,
    width: (rect.width ?? 0) * (rect.scaleX ?? 1),
    height: (rect.height ?? 0) * (rect.scaleY ?? 1),
  };
}

export function bakeFabricRectScale(rect: Rect): void {
  const width = (rect.width ?? 0) * (rect.scaleX ?? 1);
  const height = (rect.height ?? 0) * (rect.scaleY ?? 1);
  rect.set({ width, height, scaleX: 1, scaleY: 1 });
  rect.setCoords();
}

export function isBoxTooSmall(widthPx: number, heightPx: number): boolean {
  return widthPx < MIN_BOX_PX || heightPx < MIN_BOX_PX;
}
