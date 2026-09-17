import { FabricText, Rect, type Canvas, type FabricObject } from 'fabric';
import type { BboxAnnotation } from '../../../types/annotationDocument';
import { BBOX_THEME } from '../annotationBboxTheme';
import { hexToRgba } from '../../../utils/labelColor';
import type { FabricRectPixels } from './fabricBboxCoords';

export const ANNOTATION_BOX_KEY = 'lrAnnotationBox';
export const BG_IMAGE_NAME = '__bg_image__';

export interface AnnotationBoxData {
  boxId: string;
  labelId: string | null;
}

export type AnnotatedBoxRect = Rect & {
  lrAnnotationBox?: boolean;
  data?: AnnotationBoxData;
  _boxId?: string;
  _labelObj?: FabricText;
};

export type AnnotatedLabelText = FabricText & {
  lrAnnotationLabel?: boolean;
  _labelForBoxId?: string;
};

function displayLabelName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : BBOX_THEME.labelEmptyText;
}

export function boxLabelFabricTextProps() {
  return {
    fontSize: BBOX_THEME.labelFontSizePx,
    fontWeight: BBOX_THEME.labelFontWeight,
    fill: BBOX_THEME.labelTextFill,
    stroke: BBOX_THEME.labelTextStroke,
    strokeWidth: BBOX_THEME.labelTextStrokeWidth,
    paintFirst: 'stroke' as const,
    fontFamily: BBOX_THEME.labelFontFamily,
  };
}

export function isAnnotationBoxRect(
  obj: FabricObject | undefined | null,
): obj is AnnotatedBoxRect {
  return Boolean(obj && (obj as AnnotatedBoxRect).lrAnnotationBox);
}

export function getBoxRectStyle(labelColor: string) {
  return {
    originX: 'left' as const,
    originY: 'top' as const,
    fill: hexToRgba(labelColor, BBOX_THEME.fillAlpha),
    stroke: labelColor,
    strokeWidth: BBOX_THEME.strokeWidthPx,
    strokeUniform: true,
    strokeLineJoin: 'round' as const,
  };
}

export function getDraftRectStyle(labelColor: string): Partial<Rect> {
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

export function createLabelForBox(
  labelName: string,
  rectLike: FabricRectPixels,
): FabricText {
  const t = new FabricText(displayLabelName(labelName), {
    left: rectLike.left + BBOX_THEME.labelTextOffsetX,
    top: rectLike.top + BBOX_THEME.labelTextOffsetY,
    ...boxLabelFabricTextProps(),
    originX: 'left',
    originY: 'top',
    selectable: false,
    evented: false,
  });
  (t as AnnotatedLabelText).lrAnnotationLabel = true;
  return t;
}

export function syncLabelFromBoxRect(rect: AnnotatedBoxRect): void {
  const t = rect._labelObj;
  if (!t || !rect._boxId) return;
  t.set({
    left: (rect.left ?? 0) + BBOX_THEME.labelTextOffsetX,
    top: (rect.top ?? 0) + BBOX_THEME.labelTextOffsetY,
    ...boxLabelFabricTextProps(),
  });
  t.setCoords();
}

const BOX_FADE_IN_MS = 200;

export function attachBoxAndLabel(
  canvas: Canvas,
  options: {
    ann: BboxAnnotation;
    rect: FabricRectPixels;
    labelName: string;
    labelColor: string;
    selectable: boolean;
    fadeIn?: boolean;
  },
): AnnotatedBoxRect {
  const { ann, rect, labelName, labelColor, selectable, fadeIn } = options;
  const r = new Rect({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    ...getBoxRectStyle(labelColor),
    selectable,
    evented: selectable,
  }) as AnnotatedBoxRect;

  r.lrAnnotationBox = true;
  r._boxId = ann.id;
  r.data = { boxId: ann.id, labelId: ann.labelId };

  if (fadeIn) {
    r.opacity = 0;
  }
  canvas.add(r);
  const label = createLabelForBox(labelName, rect);
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

export function updateBoxRectStyle(
  rect: AnnotatedBoxRect,
  labelName: string,
  labelColor: string,
): void {
  rect.set(getBoxRectStyle(labelColor));
  const t = rect._labelObj;
  if (t) {
    t.set({
      text: displayLabelName(labelName),
      ...boxLabelFabricTextProps(),
    });
    syncLabelFromBoxRect(rect);
  }
  rect.setCoords();
}
