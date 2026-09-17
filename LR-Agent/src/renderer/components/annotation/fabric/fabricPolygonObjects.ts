import {
  Circle,
  FabricText,
  Polygon,
  Point,
  util,
  type Canvas,
  type FabricObject,
} from 'fabric';
import type { PolygonAnnotation } from '../../../types/annotationDocument';
import { BBOX_THEME } from '../annotationBboxTheme';
import { hexToRgba } from '../../../utils/labelColor';
import {
  MIN_POLYGON_VERTICES,
  pointBounds,
  toFabricPolygonGeometry,
  type ScenePoint,
} from './fabricPolygonCoords';
import {
  boxLabelFabricTextProps,
  type AnnotatedLabelText,
} from './fabricBoxObjects';

export const POLYGON_VERTEX_HIT_RADIUS = 12;
export const POLYGON_VERTEX_HANDLE_RADIUS = 6;
export const POLYGON_VERTEX_ACTIVE_HANDLE_RADIUS = 8;
export const POLYGON_GHOST_EDGE_THRESHOLD = 8;
export const POLYGON_SELECTION_BORDER_DASH = [6, 4] as const;

export type AnnotatedPolygon = Polygon & {
  lrAnnotationPolygon?: boolean;
  _polygonId?: string;
  _labelObj?: FabricText;
  data?: { polygonId: string; labelId: string | null };
};

export type PolygonVertexHandle = Circle & {
  _polygonVertexHandle?: {
    polygonId: string;
    vertexIndex: number;
  };
};

function displayLabelName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : BBOX_THEME.labelEmptyText;
}

export function isAnnotationPolygon(
  obj: FabricObject | undefined | null,
): obj is AnnotatedPolygon {
  return Boolean(obj && (obj as AnnotatedPolygon).lrAnnotationPolygon);
}

export function getPolygonScenePoints(obj: AnnotatedPolygon): ScenePoint[] {
  const matrix = obj.calcTransformMatrix();
  return (obj.points ?? []).map((pt) => {
    const transformed = util.transformPoint(
      new Point(pt.x - obj.pathOffset.x, pt.y - obj.pathOffset.y),
      matrix,
    );
    return { x: transformed.x, y: transformed.y };
  });
}

/** Inverse of getPolygonScenePoints — keeps pathOffset/left/top stable during vertex drag. */
export function scenePointToFabricPoint(
  obj: AnnotatedPolygon,
  scene: ScenePoint,
): Point {
  const matrix = obj.calcTransformMatrix();
  const inv = util.invertTransform(matrix);
  const inObject = util.transformPoint(new Point(scene.x, scene.y), inv);
  return new Point(
    inObject.x + obj.pathOffset.x,
    inObject.y + obj.pathOffset.y,
  );
}

export function syncLabelFromPolygon(poly: AnnotatedPolygon): void {
  const t = poly._labelObj;
  if (!t) return;
  const bbox = pointBounds(getPolygonScenePoints(poly));
  t.set({
    left: bbox.x + BBOX_THEME.labelTextOffsetX,
    top: bbox.y + BBOX_THEME.labelTextOffsetY,
    ...boxLabelFabricTextProps(),
  });
  t.setCoords();
}

/**
 * Move one vertex in Fabric native space without recomputing bbox/pathOffset.
 * Other vertices stay fixed in scene coordinates.
 */
export function updateSinglePolygonVertex(
  poly: AnnotatedPolygon,
  vertexIndex: number,
  scenePt: ScenePoint,
): void {
  const { points } = poly;
  if (!points || vertexIndex < 0 || vertexIndex >= points.length) return;

  const fabricPt = scenePointToFabricPoint(poly, scenePt);
  points[vertexIndex].x = fabricPt.x;
  points[vertexIndex].y = fabricPt.y;
  poly.setCoords();
}

/** Insert one vertex without rebuilding bbox/pathOffset; existing vertices stay in scene space. */
export function insertPolygonVertexAt(
  poly: AnnotatedPolygon,
  insertIndex: number,
  scenePt: ScenePoint,
): void {
  const { points } = poly;
  if (!points || insertIndex < 0 || insertIndex > points.length) return;

  const fabricPt = scenePointToFabricPoint(poly, scenePt);
  points.splice(insertIndex, 0, new Point(fabricPt.x, fabricPt.y));
  poly.setCoords();
  syncLabelFromPolygon(poly);
}

/** Remove one vertex without rebuilding bbox/pathOffset. */
export function removePolygonVertexAt(
  poly: AnnotatedPolygon,
  vertexIndex: number,
): void {
  const { points } = poly;
  if (!points || vertexIndex < 0 || vertexIndex >= points.length) return;
  if (points.length <= MIN_POLYGON_VERTICES) return;

  points.splice(vertexIndex, 1);
  poly.setCoords();
  syncLabelFromPolygon(poly);
}

export function getPolygonStyle(labelColor: string) {
  return {
    originX: 'left' as const,
    originY: 'top' as const,
    fill: hexToRgba(labelColor, BBOX_THEME.fillAlpha),
    stroke: labelColor,
    strokeWidth: BBOX_THEME.strokeWidthPx,
    strokeUniform: true,
    objectCaching: false,
    hasControls: false,
    hasBorders: false,
    lockMovementX: true,
    lockMovementY: true,
  };
}

export function getDraftPolygonStyle(labelColor: string) {
  return {
    originX: 'left' as const,
    originY: 'top' as const,
    fill: hexToRgba(labelColor, 0.08),
    stroke: labelColor,
    strokeWidth: BBOX_THEME.draftStrokeWidthPx,
    strokeUniform: true,
    selectable: false,
    evented: false,
    objectCaching: false,
  };
}

function createLabelForPolygon(
  labelName: string,
  bbox: { x: number; y: number },
): FabricText {
  const t = new FabricText(displayLabelName(labelName), {
    left: bbox.x + BBOX_THEME.labelTextOffsetX,
    top: bbox.y + BBOX_THEME.labelTextOffsetY,
    ...boxLabelFabricTextProps(),
    originX: 'left',
    originY: 'top',
    selectable: false,
    evented: false,
  });
  (t as AnnotatedLabelText).lrAnnotationLabel = true;
  return t;
}

/**
 * Apply scene vertices with Fabric pathOffset round-trip:
 * bootstrap bbox layout, then per-vertex native update so read/write stay consistent.
 */
export function applyScenePointsToPolygon(
  poly: AnnotatedPolygon,
  scenePoints: ScenePoint[],
): void {
  if (scenePoints.length < MIN_POLYGON_VERTICES) return;

  const { bbox, localPoints } = toFabricPolygonGeometry(scenePoints);
  poly.set({
    points: localPoints.map((p) => new Point(p.x, p.y)),
    left: bbox.x,
    top: bbox.y,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  });
  poly.setDimensions();
  poly.setCoords();

  for (let i = 0; i < scenePoints.length; i++) {
    updateSinglePolygonVertex(poly, i, scenePoints[i]);
  }

  poly.setDimensions();
  poly.setCoords();
  syncLabelFromPolygon(poly);
}

export function attachPolygonAndLabel(
  canvas: Canvas,
  options: {
    ann: PolygonAnnotation;
    scenePoints: ScenePoint[];
    labelName: string;
    labelColor: string;
    selectable: boolean;
    fadeIn?: boolean;
  },
): AnnotatedPolygon {
  const { ann, scenePoints, labelName, labelColor, selectable, fadeIn } =
    options;
  const bbox = pointBounds(scenePoints);
  const w = Math.max(bbox.width, 1);
  const h = Math.max(bbox.height, 1);
  const p = new Polygon([new Point(0, 0), new Point(w, 0), new Point(0, h)], {
    left: bbox.x,
    top: bbox.y,
    ...getPolygonStyle(labelColor),
    selectable,
    evented: selectable,
  }) as AnnotatedPolygon;

  p.lrAnnotationPolygon = true;
  p._polygonId = ann.id;
  p.data = { polygonId: ann.id, labelId: ann.labelId };

  if (fadeIn) p.opacity = 0;
  canvas.add(p);
  applyScenePointsToPolygon(p, scenePoints);

  const labelBbox = pointBounds(getPolygonScenePoints(p));
  const label = createLabelForPolygon(labelName, labelBbox);
  (label as AnnotatedLabelText)._labelForBoxId = ann.id;
  p._labelObj = label;
  if (fadeIn) label.opacity = 0;
  canvas.add(label);
  p.setCoords();
  label.setCoords();

  if (fadeIn) {
    const onChange = () => canvas.requestRenderAll();
    const fadeMs = 200;
    p.animate({ opacity: 1 }, { duration: fadeMs, onChange });
    label.animate({ opacity: 1 }, { duration: fadeMs, onChange });
  }

  return p;
}

export function updatePolygonStyle(
  poly: AnnotatedPolygon,
  labelName: string,
  labelColor: string,
): void {
  poly.set(getPolygonStyle(labelColor));
  const t = poly._labelObj;
  if (t) {
    t.set({
      text: displayLabelName(labelName),
      ...boxLabelFabricTextProps(),
    });
    syncLabelFromPolygon(poly);
  }
  poly.setCoords();
}

export function createPolygonVertexHandle(
  obj: AnnotatedPolygon,
  point: ScenePoint,
  vertexIndex: number,
  radius: number,
): PolygonVertexHandle {
  const handle = new Circle({
    left: point.x,
    top: point.y,
    radius,
    originX: 'center',
    originY: 'center',
    fill: '#ffffff',
    stroke: obj.stroke ?? BBOX_THEME.defaultLabelColor,
    strokeWidth: 2,
    strokeUniform: true,
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    objectCaching: false,
  }) as PolygonVertexHandle;
  handle._polygonVertexHandle = {
    polygonId: obj._polygonId ?? '',
    vertexIndex,
  };
  return handle;
}

export function updatePolygonVertexHandleStyle(
  handle: PolygonVertexHandle,
  obj: AnnotatedPolygon,
  point: ScenePoint,
  index: number,
  activeVertexIndex: number | null,
  radius: number,
  activeRadius: number,
): void {
  const isActive = index === activeVertexIndex;
  handle.set({
    left: point.x,
    top: point.y,
    radius: isActive ? activeRadius : radius,
    fill: isActive ? '#22c55e' : '#ffffff',
    stroke: obj.stroke ?? BBOX_THEME.defaultLabelColor,
    strokeWidth: isActive ? 3 : 2,
  });
  if (handle._polygonVertexHandle) {
    handle._polygonVertexHandle.vertexIndex = index;
  }
}

export function removePolygonFromCanvas(canvas: Canvas, polygonId: string) {
  const poly = canvas
    .getObjects()
    .find(
      (o) =>
        isAnnotationPolygon(o) &&
        (o as AnnotatedPolygon)._polygonId === polygonId,
    ) as AnnotatedPolygon | undefined;
  if (poly) {
    if (poly._labelObj) canvas.remove(poly._labelObj);
    canvas.remove(poly);
  }
  const orphanLabel = canvas
    .getObjects()
    .find(
      (o) =>
        (o as AnnotatedLabelText).lrAnnotationLabel &&
        (o as AnnotatedLabelText)._labelForBoxId === polygonId,
    );
  if (orphanLabel) canvas.remove(orphanLabel);
}
