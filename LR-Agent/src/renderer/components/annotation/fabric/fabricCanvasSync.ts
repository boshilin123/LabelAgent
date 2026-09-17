import { Canvas, Point, type FabricObject } from 'fabric';
import type { BboxAnnotation } from '../../../types/annotationDocument';
import type { ImageCanvasTool } from '../../../context/AnnotationWorkspaceContext';
import { BBOX_THEME } from '../annotationBboxTheme';
import {
  bakeFabricRectScale,
  fabricRectToScenePixels,
  normToSceneRect,
  sceneRectToNorm,
} from './fabricBboxCoords';
import { getScenePointFromEvent } from './fabricScenePoint';
import {
  ANNOTATION_BOX_KEY,
  attachBoxAndLabel,
  BG_IMAGE_NAME,
  isAnnotationBoxRect,
  updateBoxRectStyle,
  type AnnotatedBoxRect,
} from './fabricBoxObjects';

export function getAnnotationBoxRects(canvas: Canvas): AnnotatedBoxRect[] {
  return canvas.getObjects().filter((o) => isAnnotationBoxRect(o));
}

export function findAnnotationBoxById(
  canvas: Canvas,
  boxId: string,
): AnnotatedBoxRect | undefined {
  return getAnnotationBoxRects(canvas).find((o) => o._boxId === boxId);
}

export function removeAllAnnotationBoxes(canvas: Canvas): void {
  const toRemove = canvas
    .getObjects()
    .filter(
      (o) =>
        isAnnotationBoxRect(o) ||
        (o as FabricObject & { lrAnnotationLabel?: boolean }).lrAnnotationLabel,
    );
  toRemove.forEach((o) => canvas.remove(o));
}

export function syncBoxInteraction(
  canvas: Canvas,
  tool: ImageCanvasTool,
): void {
  const enable = tool === 'select';
  const drawCursor = 'crosshair';
  canvas.selection = enable;
  canvas.defaultCursor = tool === 'draw' ? drawCursor : 'default';
  canvas.hoverCursor = tool === 'draw' ? drawCursor : 'move';
  canvas.moveCursor = 'move';
  getAnnotationBoxRects(canvas).forEach((o) => {
    o.set({ selectable: enable, evented: enable });
  });
  if (!enable) canvas.discardActiveObject();
  canvas.setCursor(tool === 'draw' ? drawCursor : canvas.defaultCursor);
  canvas.requestRenderAll();
}

export function hitTopAnnotationBoxAtScenePoint(
  canvas: Canvas,
  scenePoint: Point | { x: number; y: number },
): AnnotatedBoxRect | undefined {
  const pt =
    scenePoint instanceof Point
      ? scenePoint
      : new Point(scenePoint.x, scenePoint.y);
  const objs = canvas.getObjects();
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (!isAnnotationBoxRect(o)) continue;
    o.setCoords();
    if (o.containsPoint(pt)) return o;
  }
  return undefined;
}

export function syncBoxesFromAnnotations(
  canvas: Canvas,
  annotations: BboxAnnotation[],
  labelResolver: (
    labelId: string | null,
  ) => { name: string; color: string } | null,
  naturalWidth: number,
  naturalHeight: number,
  tool: ImageCanvasTool,
  fadeInBoxIds?: ReadonlySet<string>,
): void {
  removeAllAnnotationBoxes(canvas);

  const selectable = tool === 'select';
  annotations.forEach((ann) => {
    const label = labelResolver(ann.labelId);
    const rect = normToSceneRect(ann, naturalWidth, naturalHeight);
    attachBoxAndLabel(canvas, {
      ann,
      rect,
      labelName: label?.name ?? BBOX_THEME.labelEmptyText,
      labelColor: label?.color ?? BBOX_THEME.defaultLabelColor,
      selectable,
      fadeIn: fadeInBoxIds?.has(ann.id),
    });
  });

  const bg = canvas
    .getObjects()
    .find(
      (o) => (o as FabricObject & { name?: string }).name === BG_IMAGE_NAME,
    );
  if (bg) canvas.sendObjectToBack(bg);
  canvas.requestRenderAll();
}

export function extractNormFromBoxRect(
  rect: AnnotatedBoxRect,
  naturalWidth: number,
  naturalHeight: number,
) {
  bakeFabricRectScale(rect);
  return sceneRectToNorm(
    fabricRectToScenePixels(rect),
    naturalWidth,
    naturalHeight,
  );
}

export function patchAnnotationBoxStyles(
  canvas: Canvas,
  annotations: BboxAnnotation[],
  labelResolver: (
    labelId: string | null,
  ) => { name: string; color: string } | null,
): void {
  annotations.forEach((ann) => {
    const rect = findAnnotationBoxById(canvas, ann.id);
    if (!rect) return;
    const label = labelResolver(ann.labelId);
    updateBoxRectStyle(
      rect,
      label?.name ?? BBOX_THEME.labelEmptyText,
      label?.color ?? BBOX_THEME.defaultLabelColor,
    );
    rect.data = { boxId: ann.id, labelId: ann.labelId };
  });
  canvas.requestRenderAll();
}

export {
  ANNOTATION_BOX_KEY,
  BG_IMAGE_NAME,
  getScenePointFromEvent,
  isAnnotationBoxRect as isAnnotationBoxObject,
};
