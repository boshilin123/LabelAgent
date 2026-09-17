import {
  Point,
  type Canvas,
  type TPointerEvent,
  type TPointerEventInfo,
} from 'fabric';

/**
 * Scene coordinates for pointer events.
 * Prefer Fabric's precomputed scenePoint on event info; otherwise use canvas.getScenePoint
 * (handles offset, retina, cssScale, and viewportTransform).
 */
export function getScenePointFromEvent(
  canvas: Canvas,
  opt: TPointerEventInfo | { e: TPointerEvent; scenePoint?: Point },
): Point {
  if ('scenePoint' in opt && opt.scenePoint) {
    return opt.scenePoint;
  }
  return canvas.getScenePoint(opt.e);
}
