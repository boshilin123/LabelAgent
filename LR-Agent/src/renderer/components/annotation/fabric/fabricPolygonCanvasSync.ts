import { Canvas, Point, type FabricObject } from 'fabric';
import type { PolygonAnnotation } from '../../../types/annotationDocument';
import type { ImageCanvasTool } from '../../../context/AnnotationWorkspaceContext';
import { BBOX_THEME } from '../annotationBboxTheme';
import {
  normToScenePoints,
  scenePointsEqual,
  scenePointsToNorm,
  roundScenePoints,
} from './fabricPolygonCoords';
import {
  applyScenePointsToPolygon,
  attachPolygonAndLabel,
  getPolygonScenePoints,
  isAnnotationPolygon,
  removePolygonFromCanvas,
  updatePolygonStyle,
  type AnnotatedPolygon,
} from './fabricPolygonObjects';

import { BG_IMAGE_NAME } from './fabricBoxObjects';

export function getAnnotationPolygons(canvas: Canvas): AnnotatedPolygon[] {
  return canvas.getObjects().filter((o) => isAnnotationPolygon(o));
}

export function findAnnotationPolygonById(
  canvas: Canvas,
  polygonId: string,
): AnnotatedPolygon | undefined {
  return getAnnotationPolygons(canvas).find((o) => o._polygonId === polygonId);
}

export function syncPolygonInteraction(
  canvas: Canvas,
  tool: ImageCanvasTool,
): void {
  const enable = tool === 'select';
  const drawCursor = tool === 'polygon' ? 'crosshair' : 'default';
  canvas.selection = false;
  canvas.defaultCursor = tool === 'polygon' ? drawCursor : 'default';
  canvas.hoverCursor = tool === 'polygon' ? drawCursor : 'default';
  canvas.moveCursor = 'default';
  getAnnotationPolygons(canvas).forEach((o) => {
    o.set({ selectable: enable, evented: enable });
  });
  if (!enable) canvas.discardActiveObject();
  canvas.setCursor(tool === 'polygon' ? drawCursor : canvas.defaultCursor);
  canvas.requestRenderAll();
}

export function hitTopAnnotationPolygonAtScenePoint(
  canvas: Canvas,
  scenePoint: Point | { x: number; y: number },
): AnnotatedPolygon | undefined {
  const pt =
    scenePoint instanceof Point
      ? scenePoint
      : new Point(scenePoint.x, scenePoint.y);
  const objs = canvas.getObjects();
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (!isAnnotationPolygon(o)) continue;
    o.setCoords();
    if (o.containsPoint(pt)) return o;
  }
  return undefined;
}

/** True when Fabric object already matches stored normalized vertices (scene space). */
export function polygonCanvasMatchesAnnotation(
  poly: AnnotatedPolygon,
  ann: PolygonAnnotation,
  naturalWidth: number,
  naturalHeight: number,
): boolean {
  const fromCanvas = getPolygonScenePoints(poly);
  const fromAnn = normToScenePoints(ann, naturalWidth, naturalHeight);
  return scenePointsEqual(fromCanvas, fromAnn);
}

export function syncPolygonsFromAnnotations(
  canvas: Canvas,
  annotations: PolygonAnnotation[],
  labelResolver: (
    labelId: string | null,
  ) => { name: string; color: string } | null,
  naturalWidth: number,
  naturalHeight: number,
  tool: ImageCanvasTool,
  fadeInIds?: ReadonlySet<string>,
): void {
  const selectable = tool === 'select';
  const annIds = new Set(annotations.map((a) => a.id));

  getAnnotationPolygons(canvas).forEach((poly) => {
    const id = poly._polygonId;
    if (id && !annIds.has(id)) removePolygonFromCanvas(canvas, id);
  });

  annotations.forEach((ann) => {
    const label = labelResolver(ann.labelId);
    const scenePoints = normToScenePoints(ann, naturalWidth, naturalHeight);
    const labelName = label?.name ?? BBOX_THEME.labelEmptyText;
    const labelColor = label?.color ?? BBOX_THEME.defaultLabelColor;

    const existing = findAnnotationPolygonById(canvas, ann.id);
    if (existing) {
      if (
        !polygonCanvasMatchesAnnotation(
          existing,
          ann,
          naturalWidth,
          naturalHeight,
        )
      ) {
        applyScenePointsToPolygon(existing, scenePoints);
      }
      updatePolygonStyle(existing, labelName, labelColor);
      existing.set({ selectable, evented: selectable });
      existing.data = { polygonId: ann.id, labelId: ann.labelId };
      return;
    }

    attachPolygonAndLabel(canvas, {
      ann,
      scenePoints,
      labelName,
      labelColor,
      selectable,
      fadeIn: fadeInIds?.has(ann.id),
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

export function extractNormFromPolygon(
  poly: AnnotatedPolygon,
  naturalWidth: number,
  naturalHeight: number,
) {
  return scenePointsToNorm(
    roundScenePoints(getPolygonScenePoints(poly)),
    naturalWidth,
    naturalHeight,
  );
}

export function patchAnnotationPolygonStyles(
  canvas: Canvas,
  annotations: PolygonAnnotation[],
  labelResolver: (
    labelId: string | null,
  ) => { name: string; color: string } | null,
): void {
  annotations.forEach((ann) => {
    const poly = findAnnotationPolygonById(canvas, ann.id);
    if (!poly) return;
    const label = labelResolver(ann.labelId);
    updatePolygonStyle(
      poly,
      label?.name ?? BBOX_THEME.labelEmptyText,
      label?.color ?? BBOX_THEME.defaultLabelColor,
    );
    poly.data = { polygonId: ann.id, labelId: ann.labelId };
  });
  canvas.requestRenderAll();
}
