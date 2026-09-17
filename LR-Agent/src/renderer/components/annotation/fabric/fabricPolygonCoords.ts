import type { PolygonAnnotation } from '../../../types/annotationDocument';

export const MIN_POLYGON_VERTICES = 3;

export interface ScenePoint {
  x: number;
  y: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function normToScenePoints(
  ann: Pick<PolygonAnnotation, 'points'>,
  naturalWidth: number,
  naturalHeight: number,
): ScenePoint[] {
  const nw = naturalWidth > 0 ? naturalWidth : 1;
  const nh = naturalHeight > 0 ? naturalHeight : 1;
  return ann.points.map((pt) => ({
    x: pt.x * nw,
    y: pt.y * nh,
  }));
}

export function roundScenePoint(pt: ScenePoint): ScenePoint {
  return {
    x: Math.round(pt.x * 100) / 100,
    y: Math.round(pt.y * 100) / 100,
  };
}

export function roundScenePoints(points: ScenePoint[]): ScenePoint[] {
  return points.map(roundScenePoint);
}

/** Scene-space tolerance when comparing canvas geometry to annotation state */
export const SCENE_GEOMETRY_MATCH_EPS = 0.5;

export function scenePointsEqual(
  a: ScenePoint[],
  b: ScenePoint[],
  eps = SCENE_GEOMETRY_MATCH_EPS,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y) > eps) return false;
  }
  return true;
}

export function scenePointsToNorm(
  points: ScenePoint[],
  naturalWidth: number,
  naturalHeight: number,
): { x: number; y: number }[] {
  const nw = naturalWidth > 0 ? naturalWidth : 1;
  const nh = naturalHeight > 0 ? naturalHeight : 1;
  return roundScenePoints(points).map((pt) => ({
    x: clamp01(pt.x / nw),
    y: clamp01(pt.y / nh),
  }));
}

export function scenePointToNorm(
  pt: ScenePoint,
  naturalWidth: number,
  naturalHeight: number,
): { x: number; y: number } {
  return scenePointsToNorm([pt], naturalWidth, naturalHeight)[0]!;
}

export function pointBounds(points: ScenePoint[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x1 = Math.min(...xs);
  const y1 = Math.min(...ys);
  const x2 = Math.max(...xs);
  const y2 = Math.max(...ys);
  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  };
}

export function toFabricPolygonGeometry(points: ScenePoint[]) {
  const bbox = pointBounds(points);
  return {
    bbox,
    localPoints: points.map((pt) => ({
      x: pt.x - bbox.x,
      y: pt.y - bbox.y,
    })),
  };
}

export function clampScenePoint(
  pt: ScenePoint,
  naturalWidth: number,
  naturalHeight: number,
): ScenePoint {
  const maxX = naturalWidth > 0 ? naturalWidth : pt.x;
  const maxY = naturalHeight > 0 ? naturalHeight : pt.y;
  return {
    x: Math.min(Math.max(0, pt.x), maxX),
    y: Math.min(Math.max(0, pt.y), maxY),
  };
}

export function projectPointToSegment(
  p: ScenePoint,
  a: ScenePoint,
  b: ScenePoint,
): { distance: number; point: ScenePoint } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const distance = Math.hypot(p.x - a.x, p.y - a.y);
    return { distance, point: { x: a.x, y: a.y } };
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.min(1, Math.max(0, t));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  const distance = Math.hypot(p.x - point.x, p.y - point.y);
  return { distance, point };
}
