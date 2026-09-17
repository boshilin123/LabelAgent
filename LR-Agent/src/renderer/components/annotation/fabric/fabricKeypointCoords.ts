import type {
  PoseAnnotation,
  ImagePointAnnotation,
} from '../../../types/annotationDocument';
import type { KeypointTemplate } from '../../../types/keypointTemplate';
import {
  computeTightPosePadding,
  DEFAULT_POSE_HEIGHT_RATIO,
  DEFAULT_POSE_WIDTH_RATIO,
} from '../../../types/keypointTemplate';

export interface ScenePoint {
  x: number;
  y: number;
}

export interface PoseSceneGeometry {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  keypoints: (ScenePoint & { visibility: 0 | 1 | 2 })[];
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function normPointToScene(
  x: number,
  y: number,
  naturalWidth: number,
  naturalHeight: number,
): ScenePoint {
  return {
    x: x * naturalWidth,
    y: y * naturalHeight,
  };
}

export function scenePointToNorm(
  pt: ScenePoint,
  naturalWidth: number,
  naturalHeight: number,
): { x: number; y: number } {
  const nw = naturalWidth > 0 ? naturalWidth : 1;
  const nh = naturalHeight > 0 ? naturalHeight : 1;
  return {
    x: clamp01(pt.x / nw),
    y: clamp01(pt.y / nh),
  };
}

export function poseAnnToSceneGeometry(
  ann: PoseAnnotation,
  naturalWidth: number,
  naturalHeight: number,
): PoseSceneGeometry {
  const cx = ann.cx * naturalWidth;
  const cy = ann.cy * naturalHeight;
  const width = ann.width * naturalWidth;
  const height = ann.height * naturalHeight;
  return {
    cx,
    cy,
    width,
    height,
    angle: ann.angle,
    keypoints: ann.keypoints.map((kp) => ({
      x: kp.x * naturalWidth,
      y: kp.y * naturalHeight,
      visibility: kp.visibility,
    })),
  };
}

export function sceneGeometryToPoseAnn(
  scene: PoseSceneGeometry,
  naturalWidth: number,
  naturalHeight: number,
  base: Pick<
    PoseAnnotation,
    'id' | 'labelId' | 'templateId' | 'createdAt' | 'note'
  >,
): PoseAnnotation {
  const nw = naturalWidth > 0 ? naturalWidth : 1;
  const nh = naturalHeight > 0 ? naturalHeight : 1;
  return {
    ...base,
    kind: 'pose',
    updatedAt: new Date().toISOString(),
    cx: clamp01(scene.cx / nw),
    cy: clamp01(scene.cy / nh),
    width: clamp01(scene.width / nw),
    height: clamp01(scene.height / nh),
    angle: scene.angle,
    keypoints: scene.keypoints.map((kp) => ({
      x: clamp01(kp.x / nw),
      y: clamp01(kp.y / nh),
      visibility: kp.visibility,
    })),
  };
}

/** Build initial keypoints from template defaults inside a bbox at scene center */
export function buildInitialPoseSceneGeometry(
  template: KeypointTemplate,
  centerScene: ScenePoint,
  naturalWidth: number,
  naturalHeight: number,
): PoseSceneGeometry {
  const width = Math.max(naturalWidth * DEFAULT_POSE_WIDTH_RATIO, 30);
  const height = Math.max(naturalHeight * DEFAULT_POSE_HEIGHT_RATIO, 45);
  const keypoints = template.keypoints.map((kp) => {
    const lx = (kp.defaultPos[0] - 0.5) * width;
    const ly = (kp.defaultPos[1] - 0.5) * height;
    return {
      x: centerScene.x + lx,
      y: centerScene.y + ly,
      visibility: 2 as const,
    };
  });
  return recomputeTightPoseBounds(
    {
      cx: centerScene.x,
      cy: centerScene.y,
      width,
      height,
      angle: 0,
      keypoints,
    },
    naturalHeight,
  );
}

export function recomputeTightPoseBounds(
  scene: PoseSceneGeometry,
  imageHeight: number,
): PoseSceneGeometry {
  if (scene.keypoints.length === 0) return scene;

  const xs = scene.keypoints.map((k) => k.x);
  const ys = scene.keypoints.map((k) => k.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padding = computeTightPosePadding(imageHeight);

  const newW = Math.max(maxX - minX + padding * 2, 15);
  const newH = Math.max(maxY - minY + padding * 2, 15);
  const newCx = minX - padding + newW / 2;
  const newCy = minY - padding + newH / 2;

  return {
    cx: newCx,
    cy: newCy,
    width: newW,
    height: newH,
    angle: scene.angle,
    keypoints: scene.keypoints.map((kp) => ({ ...kp })),
  };
}

/** Convert absolute scene keypoints to local offsets from bbox center (pre-rotation) */
export function sceneKeypointsToLocal(
  scene: PoseSceneGeometry,
): { x: number; y: number; visibility: 0 | 1 | 2 }[] {
  const rad = (scene.angle * Math.PI) / 180;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  return scene.keypoints.map((kp) => {
    const dx = kp.x - scene.cx;
    const dy = kp.y - scene.cy;
    return {
      x: dx * cos - dy * sin,
      y: dx * sin + dy * cos,
      visibility: kp.visibility,
    };
  });
}

export function pointAnnToScene(
  ann: ImagePointAnnotation,
  naturalWidth: number,
  naturalHeight: number,
): ScenePoint {
  return normPointToScene(ann.x, ann.y, naturalWidth, naturalHeight);
}

export function poseGeometryRoughlyEqual(
  a: PoseSceneGeometry,
  b: PoseSceneGeometry,
): boolean {
  const eps = 0.5;
  return (
    Math.abs(a.cx - b.cx) < eps &&
    Math.abs(a.cy - b.cy) < eps &&
    Math.abs(a.width - b.width) < eps &&
    Math.abs(a.height - b.height) < eps &&
    Math.abs(a.angle - b.angle) < 0.01 &&
    a.keypoints.length === b.keypoints.length &&
    a.keypoints.every(
      (kp, i) =>
        Math.abs(kp.x - b.keypoints[i].x) < eps &&
        Math.abs(kp.y - b.keypoints[i].y) < eps &&
        kp.visibility === b.keypoints[i].visibility,
    )
  );
}
