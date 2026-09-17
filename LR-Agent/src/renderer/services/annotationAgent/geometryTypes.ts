import type { ImageAnnotationType } from '../../types/annotation';
import type { PoseKeypoint } from '../../types/annotationDocument';

export type GeometryKind = 'bbox' | 'rotated_bbox' | 'polygon' | 'pose';

export interface NormBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RotatedBboxPayload {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

export interface PolygonPayload {
  points: { x: number; y: number }[];
}

export interface PosePayload {
  templateId: string;
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  keypoints: PoseKeypoint[];
  presetLabelId?: string | null;
}

export type GeometryPayload =
  NormBox | RotatedBboxPayload | PolygonPayload | PosePayload;

export interface GeometryInstance {
  instance_index: number;
  geometry_kind: GeometryKind;
  class_name?: string;
  confidence?: number;
  /** Normalized axis-aligned crop region for map vision APIs */
  crop_box: NormBox;
  payload: GeometryPayload;
}

export type GeometryAnnotationType = Extract<
  ImageAnnotationType,
  'bbox' | 'rotated_bbox' | 'polygon' | 'keypoint'
>;

export const GEOMETRY_ANNOTATION_TYPES: GeometryAnnotationType[] = [
  'bbox',
  'rotated_bbox',
  'polygon',
  'keypoint',
];

export function isGeometryAnnotationType(
  type: string,
): type is GeometryAnnotationType {
  return (GEOMETRY_ANNOTATION_TYPES as string[]).includes(type);
}

export function obbToAabb(
  cx: number,
  cy: number,
  width: number,
  height: number,
  angleDeg: number,
): NormBox {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const aabbW = width * cos + height * sin;
  const aabbH = width * sin + height * cos;
  return {
    x: Math.max(0, cx - aabbW / 2),
    y: Math.max(0, cy - aabbH / 2),
    width: aabbW,
    height: aabbH,
  };
}

export function pointsToAabb(
  points: { x: number; y: number }[],
): NormBox | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return null;
  return { x: minX, y: minY, width, height };
}

export function instancesToMapBoxes(instances: GeometryInstance[]): Array<{
  box_index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  class_name: string;
  confidence?: number;
}> {
  return instances.map((inst) => ({
    box_index: inst.instance_index,
    x: inst.crop_box.x,
    y: inst.crop_box.y,
    width: inst.crop_box.width,
    height: inst.crop_box.height,
    class_name: inst.class_name ?? '',
    confidence: inst.confidence,
  }));
}
