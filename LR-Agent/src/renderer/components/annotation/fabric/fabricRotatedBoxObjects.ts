import { FabricText, Rect, type Canvas, type FabricObject } from 'fabric';
import type { RotatedBboxAnnotation } from '../../../types/annotationDocument';
import { BBOX_THEME } from '../annotationBboxTheme';
import { hexToRgba } from '../../../utils/labelColor';
import {
  rotatedRectAabb,
  type FabricRotatedRectPixels,
} from './fabricRotatedBboxCoords';
import {
  boxLabelFabricTextProps,
  type AnnotatedLabelText,
} from './fabricBoxObjects';

export const ROTATED_BOX_ROTATE_CURSOR = 'grab';

export type AnnotatedRotatedBoxRect = Rect & {
  lrRotatedAnnotationBox?: boolean;
  data?: { boxId: string; labelId: string | null };
  _boxId?: string;
  _labelObj?: FabricText;
};

export function applyRotatedBoxRotateHandleCursor(
  rect: AnnotatedRotatedBoxRect,
): void {
  const mtr = rect.controls?.mtr;
  if (mtr) {
    mtr.cursorStyle = ROTATED_BOX_ROTATE_CURSOR;
  }
}

function displayLabelName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : BBOX_THEME.labelEmptyText;
}

export function isAnnotationRotatedBoxRect(
  obj: FabricObject | undefined | null,
): obj is AnnotatedRotatedBoxRect {
  return Boolean(
    obj && (obj as AnnotatedRotatedBoxRect).lrRotatedAnnotationBox,
  );
}

export function getRotatedBoxRectStyle(labelColor: string) {
  return {
    originX: 'center' as const,
    originY: 'center' as const,
    fill: hexToRgba(labelColor, BBOX_THEME.fillAlpha),
    stroke: labelColor,
    strokeWidth: BBOX_THEME.strokeWidthPx,
    strokeUniform: true,
    strokeLineJoin: 'round' as const,
    hasRotatingPoint: true,
    lockScalingFlip: true,
  };
}

export function getRotatedDraftRectStyle(labelColor: string): Partial<Rect> {
  return {
    originX: 'left',
    originY: 'top',
    fill: 'transparent',
    stroke: labelColor,
    strokeWidth: BBOX_THEME.draftStrokeWidthPx,
    strokeUniform: true,
    selectable: false,
    evented: false,
  };
}

export function createLabelForRotatedBox(
  labelName: string,
  scene: FabricRotatedRectPixels,
): FabricText {
  const aabb = rotatedRectAabb(scene);
  const t = new FabricText(displayLabelName(labelName), {
    left: aabb.left + BBOX_THEME.labelTextOffsetX,
    top: aabb.top + BBOX_THEME.labelTextOffsetY,
    ...boxLabelFabricTextProps(),
    originX: 'left',
    originY: 'top',
    selectable: false,
    evented: false,
  });
  (t as AnnotatedLabelText).lrAnnotationLabel = true;
  return t;
}

export function syncLabelFromRotatedBoxRect(
  rect: AnnotatedRotatedBoxRect,
): void {
  const t = rect._labelObj;
  if (!t || !rect._boxId) return;
  const scene = {
    cx: rect.left ?? 0,
    cy: rect.top ?? 0,
    width: (rect.width ?? 0) * (rect.scaleX ?? 1),
    height: (rect.height ?? 0) * (rect.scaleY ?? 1),
    angle: rect.angle ?? 0,
  };
  const aabb = rotatedRectAabb(scene);
  t.set({
    left: aabb.left + BBOX_THEME.labelTextOffsetX,
    top: aabb.top + BBOX_THEME.labelTextOffsetY,
    ...boxLabelFabricTextProps(),
  });
  t.setCoords();
}

const BOX_FADE_IN_MS = 200;

export function attachRotatedBoxAndLabel(
  canvas: Canvas,
  options: {
    ann: RotatedBboxAnnotation;
    scene: FabricRotatedRectPixels;
    labelName: string;
    labelColor: string;
    selectable: boolean;
    fadeIn?: boolean;
  },
): AnnotatedRotatedBoxRect {
  const { ann, scene, labelName, labelColor, selectable, fadeIn } = options;
  const r = new Rect({
    left: scene.cx,
    top: scene.cy,
    width: scene.width,
    height: scene.height,
    angle: scene.angle,
    ...getRotatedBoxRectStyle(labelColor),
    selectable,
    evented: selectable,
  }) as AnnotatedRotatedBoxRect;

  r.lrRotatedAnnotationBox = true;
  r._boxId = ann.id;
  r.data = { boxId: ann.id, labelId: ann.labelId };
  applyRotatedBoxRotateHandleCursor(r);

  if (fadeIn) {
    r.opacity = 0;
  }
  canvas.add(r);
  const label = createLabelForRotatedBox(labelName, scene);
  (label as AnnotatedLabelText)._labelForBoxId = ann.id;
  r._labelObj = label;
  if (fadeIn) {
    label.opacity = 0;
  }
  canvas.add(label);
  r.setCoords();
  label.setCoords();

  if (fadeIn) {
    const onChange = () => canvas.requestRenderAll();
    r.animate({ opacity: 1 }, { duration: BOX_FADE_IN_MS, onChange });
    label.animate({ opacity: 1 }, { duration: BOX_FADE_IN_MS, onChange });
  }

  return r;
}

export function updateRotatedBoxRectStyle(
  rect: AnnotatedRotatedBoxRect,
  labelName: string,
  labelColor: string,
): void {
  rect.set(getRotatedBoxRectStyle(labelColor));
  const t = rect._labelObj;
  if (t) {
    t.set({
      text: displayLabelName(labelName),
      ...boxLabelFabricTextProps(),
    });
    syncLabelFromRotatedBoxRect(rect);
  }
  rect.setCoords();
}
