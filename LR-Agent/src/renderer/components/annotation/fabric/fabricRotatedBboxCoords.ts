import type { Rect } from 'fabric';
import type { RotatedBboxAnnotation } from '../../../types/annotationDocument';
import type { FabricRectPixels } from './fabricBboxCoords';

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export interface FabricRotatedRectPixels {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

/** Normalized rotated bbox → scene pixels (natural image coordinate system). */
export function normToSceneRotatedRect(
  ann: Pick<RotatedBboxAnnotation, 'cx' | 'cy' | 'width' | 'height' | 'angle'>,
  naturalWidth: number,
  naturalHeight: number,
): FabricRotatedRectPixels {
  return {
    cx: ann.cx * naturalWidth,
    cy: ann.cy * naturalHeight,
    width: ann.width * naturalWidth,
    height: ann.height * naturalHeight,
    angle: ann.angle,
  };
}

/** Scene pixels → normalized rotated bbox (0–1 vs natural image size). */
export function sceneRotatedRectToNorm(
  rect: FabricRotatedRectPixels,
  naturalWidth: number,
  naturalHeight: number,
): Pick<RotatedBboxAnnotation, 'cx' | 'cy' | 'width' | 'height' | 'angle'> {
  const nw = naturalWidth > 0 ? naturalWidth : 1;
  const nh = naturalHeight > 0 ? naturalHeight : 1;
  return {
    cx: clamp01(rect.cx / nw),
    cy: clamp01(rect.cy / nh),
    width: clamp01(rect.width / nw),
    height: clamp01(rect.height / nh),
    angle: rect.angle,
  };
}

/** Axis-aligned top-left rect from drag → center-based rotated bbox (angle 0). */
export function sceneRectToRotatedNorm(
  rect: FabricRectPixels,
  naturalWidth: number,
  naturalHeight: number,
): Pick<RotatedBboxAnnotation, 'cx' | 'cy' | 'width' | 'height' | 'angle'> {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return sceneRotatedRectToNorm(
    { cx, cy, width: rect.width, height: rect.height, angle: 0 },
    naturalWidth,
    naturalHeight,
  );
}

export function fabricRectToSceneRotatedPixels(
  rect: Rect,
): FabricRotatedRectPixels {
  const width = (rect.width ?? 0) * (rect.scaleX ?? 1);
  const height = (rect.height ?? 0) * (rect.scaleY ?? 1);
  return {
    cx: rect.left ?? 0,
    cy: rect.top ?? 0,
    width,
    height,
    angle: rect.angle ?? 0,
  };
}

export function bakeFabricRotatedRectScale(rect: Rect): void {
  const width = (rect.width ?? 0) * (rect.scaleX ?? 1);
  const height = (rect.height ?? 0) * (rect.scaleY ?? 1);
  rect.set({ width, height, scaleX: 1, scaleY: 1 });
  rect.setCoords();
}

/** Axis-aligned bounding box of a rotated rectangle in scene pixels. */
export function rotatedRectAabb(
  rect: FabricRotatedRectPixels,
): FabricRectPixels {
  const rad = (rect.angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const aabbW = rect.width * cos + rect.height * sin;
  const aabbH = rect.width * sin + rect.height * cos;
  return {
    left: rect.cx - aabbW / 2,
    top: rect.cy - aabbH / 2,
    width: aabbW,
    height: aabbH,
  };
}
