import { Canvas, Point, type FabricObject } from 'fabric';
import type { RotatedBboxAnnotation } from '../../../types/annotationDocument';
import type { ImageCanvasTool } from '../../../context/AnnotationWorkspaceContext';
import { BBOX_THEME } from '../annotationBboxTheme';
import {
  bakeFabricRotatedRectScale,
  fabricRectToSceneRotatedPixels,
  normToSceneRotatedRect,
  sceneRotatedRectToNorm,
} from './fabricRotatedBboxCoords';
import { BG_IMAGE_NAME } from './fabricBoxObjects';
import {
  attachRotatedBoxAndLabel,
  isAnnotationRotatedBoxRect,
  updateRotatedBoxRectStyle,
  type AnnotatedRotatedBoxRect,
} from './fabricRotatedBoxObjects';

export function getAnnotationRotatedBoxRects(
  canvas: Canvas,
): AnnotatedRotatedBoxRect[] {
  return canvas.getObjects().filter((o) => isAnnotationRotatedBoxRect(o));
}

export function findAnnotationRotatedBoxById(
  canvas: Canvas,
  boxId: string,
): AnnotatedRotatedBoxRect | undefined {
  return getAnnotationRotatedBoxRects(canvas).find((o) => o._boxId === boxId);
}

export function removeAllAnnotationRotatedBoxes(canvas: Canvas): void {
  const toRemove = canvas
    .getObjects()
    .filter(
      (o) =>
        isAnnotationRotatedBoxRect(o) ||
        (o as FabricObject & { lrAnnotationLabel?: boolean }).lrAnnotationLabel,
    );
  toRemove.forEach((o) => canvas.remove(o));
}

export function syncRotatedBoxInteraction(
  canvas: Canvas,
  tool: ImageCanvasTool,
): void {
  const enable = tool === 'select';
  const drawCursor = 'crosshair';
  canvas.selection = enable;
  canvas.defaultCursor = tool === 'draw' ? drawCursor : 'default';
  canvas.hoverCursor = tool === 'draw' ? drawCursor : 'move';
  canvas.moveCursor = 'move';
  getAnnotationRotatedBoxRects(canvas).forEach((o) => {
    o.set({ selectable: enable, evented: enable, hasRotatingPoint: enable });
  });
  if (!enable) canvas.discardActiveObject();
  canvas.setCursor(tool === 'draw' ? drawCursor : canvas.defaultCursor);
  canvas.requestRenderAll();
}

export function hitTopAnnotationRotatedBoxAtScenePoint(
  canvas: Canvas,
  scenePoint: Point | { x: number; y: number },
): AnnotatedRotatedBoxRect | undefined {
  const pt =
    scenePoint instanceof Point
      ? scenePoint
      : new Point(scenePoint.x, scenePoint.y);
  const objs = canvas.getObjects();
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (!isAnnotationRotatedBoxRect(o)) continue;
    o.setCoords();
    if (o.containsPoint(pt)) return o;
  }
  return undefined;
}

export function syncRotatedBoxesFromAnnotations(
  canvas: Canvas,
  annotations: RotatedBboxAnnotation[],
  labelResolver: (
    labelId: string | null,
  ) => { name: string; color: string } | null,
  naturalWidth: number,
  naturalHeight: number,
  tool: ImageCanvasTool,
  fadeInBoxIds?: ReadonlySet<string>,
): void {
  removeAllAnnotationRotatedBoxes(canvas);

  const selectable = tool === 'select';
  annotations.forEach((ann) => {
    const label = labelResolver(ann.labelId);
    const scene = normToSceneRotatedRect(ann, naturalWidth, naturalHeight);
    attachRotatedBoxAndLabel(canvas, {
      ann,
      scene,
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

export function extractNormFromRotatedBoxRect(
  rect: AnnotatedRotatedBoxRect,
  naturalWidth: number,
  naturalHeight: number,
) {
  bakeFabricRotatedRectScale(rect);
  return sceneRotatedRectToNorm(
    fabricRectToSceneRotatedPixels(rect),
    naturalWidth,
    naturalHeight,
  );
}

export function patchAnnotationRotatedBoxStyles(
  canvas: Canvas,
  annotations: RotatedBboxAnnotation[],
  labelResolver: (
    labelId: string | null,
  ) => { name: string; color: string } | null,
): void {
  annotations.forEach((ann) => {
    const rect = findAnnotationRotatedBoxById(canvas, ann.id);
    if (!rect) return;
    const label = labelResolver(ann.labelId);
    updateRotatedBoxRectStyle(
      rect,
      label?.name ?? BBOX_THEME.labelEmptyText,
      label?.color ?? BBOX_THEME.defaultLabelColor,
    );
    rect.data = { boxId: ann.id, labelId: ann.labelId };
  });
  canvas.requestRenderAll();
}

export { isAnnotationRotatedBoxRect as isAnnotationRotatedBoxObject };
