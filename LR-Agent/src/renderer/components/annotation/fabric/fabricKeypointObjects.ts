import {
  Circle,
  FabricText,
  Group,
  Line,
  Rect,
  type Canvas,
  type FabricObject,
} from 'fabric';
import type { PoseAnnotation } from '../../../types/annotationDocument';
import type { KeypointTemplate } from '../../../types/keypointTemplate';
import { BBOX_THEME } from '../annotationBboxTheme';
import { hexToRgba } from '../../../utils/labelColor';
import {
  boxLabelFabricTextProps,
  type AnnotatedLabelText,
} from './fabricBoxObjects';
import {
  sceneKeypointsToLocal,
  type PoseSceneGeometry,
  type ScenePoint,
} from './fabricKeypointCoords';

export const KEYPOINT_HIT_RADIUS = 10;
export const KEYPOINT_HANDLE_RADIUS = 5;
export const KEYPOINT_ACTIVE_RADIUS = 7;
export const SKELETON_HIT_WIDTH = 10;
export const POSE_BBOX_DASH_ARRAY = [6, 4] as const;

export type AnnotatedKeypointCircle = Circle & {
  lrKeypointHandle?: boolean;
  _poseId?: string;
  _keypointIndex?: number;
  _visibility?: 0 | 1 | 2;
};

export type AnnotatedPoseGroup = Group & {
  lrAnnotationPose?: boolean;
  _poseId?: string;
  _templateId?: string;
  _keypointCircles?: AnnotatedKeypointCircle[];
  _skeletonLines?: Line[];
  _bboxOutline?: Rect;
  _labelObj?: FabricText;
  data?: { poseId: string; labelId: string | null; templateId: string };
};

export type AnnotatedPointCircle = Circle & {
  lrAnnotationPoint?: boolean;
  _pointId?: string;
  _labelObj?: FabricText;
  data?: { pointId: string; labelId: string | null };
};

function displayLabelName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : BBOX_THEME.labelEmptyText;
}

export function isAnnotationPoseGroup(
  obj: FabricObject | undefined | null,
): obj is AnnotatedPoseGroup {
  return Boolean(obj && (obj as AnnotatedPoseGroup).lrAnnotationPose);
}

export function isAnnotationPointCircle(
  obj: FabricObject | undefined | null,
): obj is AnnotatedPointCircle {
  return Boolean(obj && (obj as AnnotatedPointCircle).lrAnnotationPoint);
}

export function isKeypointHandle(
  obj: FabricObject | undefined | null,
): obj is AnnotatedKeypointCircle {
  return Boolean(obj && (obj as AnnotatedKeypointCircle).lrKeypointHandle);
}

function visibilityStyle(
  visibility: 0 | 1 | 2,
  color: string,
): { fill: string; opacity: number; stroke: string } {
  if (visibility === 2) {
    return { fill: color, opacity: 1, stroke: '#ffffff' };
  }
  if (visibility === 1) {
    return { fill: '#969696', opacity: 0.85, stroke: '#ffffff' };
  }
  return { fill: 'transparent', opacity: 0.35, stroke: color };
}

function createKeypointCircle(
  index: number,
  localX: number,
  localY: number,
  color: string,
  visibility: 0 | 1 | 2,
  poseId: string,
): AnnotatedKeypointCircle {
  const vis = visibilityStyle(visibility, color);
  const c = new Circle({
    left: localX,
    top: localY,
    originX: 'center',
    originY: 'center',
    radius: KEYPOINT_HANDLE_RADIUS,
    fill: vis.fill,
    stroke: vis.stroke,
    strokeWidth: 1.5,
    opacity: vis.opacity,
    hasControls: false,
    hasBorders: false,
    lockMovementX: true,
    lockMovementY: true,
  }) as AnnotatedKeypointCircle;
  c.lrKeypointHandle = true;
  c._poseId = poseId;
  c._keypointIndex = index;
  c._visibility = visibility;
  return c;
}

function createSkeletonLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
): Line {
  return new Line([x1, y1, x2, y2], {
    stroke: color,
    strokeWidth: 2,
    selectable: false,
    evented: false,
  });
}

export function updateKeypointCircleVisibility(
  circle: AnnotatedKeypointCircle,
  visibility: 0 | 1 | 2,
  color: string,
): void {
  circle._visibility = visibility;
  const vis = visibilityStyle(visibility, color);
  circle.set({
    fill: vis.fill,
    stroke: vis.stroke,
    opacity: vis.opacity,
  });
}

export function updateSkeletonLines(
  group: AnnotatedPoseGroup,
  template: KeypointTemplate,
): void {
  const circles = group._keypointCircles ?? [];
  const lines = group._skeletonLines ?? [];
  template.connections.forEach(([p1, p2], idx) => {
    const line = lines[idx];
    const c1 = circles[p1];
    const c2 = circles[p2];
    if (!line || !c1 || !c2) return;
    const v1 = c1._visibility ?? 2;
    const v2 = c2._visibility ?? 2;
    const show = v1 > 0 && v2 > 0;
    line.set({
      x1: c1.left ?? 0,
      y1: c1.top ?? 0,
      x2: c2.left ?? 0,
      y2: c2.top ?? 0,
      stroke: (c1.fill as string) ?? '#00ff00',
      opacity: v1 === 1 || v2 === 1 ? 0.5 : 1,
      visible: show,
    });
  });
}

export function getPoseSceneGeometryFromGroup(
  group: AnnotatedPoseGroup,
): PoseSceneGeometry {
  const circles = group._keypointCircles ?? [];
  const rad = ((group.angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const gx = group.left ?? 0;
  const gy = group.top ?? 0;
  const scaleX = group.scaleX ?? 1;
  const scaleY = group.scaleY ?? 1;

  const keypoints = circles.map((c) => {
    const lx = (c.left ?? 0) * scaleX;
    const ly = (c.top ?? 0) * scaleY;
    return {
      x: gx + lx * cos - ly * sin,
      y: gy + lx * sin + ly * cos,
      visibility: (c._visibility ?? 2) as 0 | 1 | 2,
    };
  });

  return {
    cx: gx,
    cy: gy,
    width: (group.width ?? 0) * scaleX,
    height: (group.height ?? 0) * scaleY,
    angle: group.angle ?? 0,
    keypoints,
  };
}

export function applySceneGeometryToPoseGroup(
  group: AnnotatedPoseGroup,
  scene: PoseSceneGeometry,
  template: KeypointTemplate,
): void {
  const localKps = sceneKeypointsToLocal(scene);
  const circles = group._keypointCircles ?? [];

  group.set({
    left: scene.cx,
    top: scene.cy,
    angle: scene.angle,
    scaleX: 1,
    scaleY: 1,
    width: scene.width,
    height: scene.height,
  });

  template.keypoints.forEach((kpDef, i) => {
    const circle = circles[i];
    const local = localKps[i];
    if (!circle || !local) return;
    updateKeypointCircleVisibility(circle, local.visibility, kpDef.color);
    circle.set({ left: local.x, top: local.y });
  });

  if (group._bboxOutline) {
    group._bboxOutline.set({
      width: scene.width,
      height: scene.height,
    });
  }

  updateSkeletonLines(group, template);
  group.setCoords();
}

export function buildPoseGroup(
  ann: PoseAnnotation,
  template: KeypointTemplate,
  scene: PoseSceneGeometry,
  poseId: string,
): AnnotatedPoseGroup {
  const localKps = sceneKeypointsToLocal(scene);
  const circles: AnnotatedKeypointCircle[] = template.keypoints.map(
    (kpDef, i) => {
      const local = localKps[i];
      return createKeypointCircle(
        i,
        local?.x ?? 0,
        local?.y ?? 0,
        kpDef.color,
        local?.visibility ?? 2,
        poseId,
      );
    },
  );

  const lines: Line[] = template.connections.map(([p1, p2]) => {
    const c1 = circles[p1];
    const c2 = circles[p2];
    return createSkeletonLine(
      c1?.left ?? 0,
      c1?.top ?? 0,
      c2?.left ?? 0,
      c2?.top ?? 0,
      template.keypoints[p1]?.color ?? '#00ff00',
    );
  });

  const bboxOutline = new Rect({
    width: scene.width,
    height: scene.height,
    originX: 'center',
    originY: 'center',
    left: 0,
    top: 0,
    fill: 'transparent',
    stroke: '#32ff32',
    strokeWidth: 2,
    strokeDashArray: [...POSE_BBOX_DASH_ARRAY],
    selectable: false,
    evented: false,
    visible: false,
  });

  const group = new Group([...lines, ...circles, bboxOutline], {
    left: scene.cx,
    top: scene.cy,
    originX: 'center',
    originY: 'center',
    width: scene.width,
    height: scene.height,
    angle: scene.angle,
    subTargetCheck: true,
    hasControls: true,
    hasBorders: false,
    lockScalingFlip: true,
    borderColor: BBOX_THEME.focusStroke,
    cornerColor: '#ffffff',
    cornerStrokeColor: BBOX_THEME.defaultLabelColor,
    transparentCorners: false,
  }) as AnnotatedPoseGroup;

  group.lrAnnotationPose = true;
  group._poseId = poseId;
  group._templateId = template.id;
  group._keypointCircles = circles;
  group._skeletonLines = lines;
  group._bboxOutline = bboxOutline;
  group.data = {
    poseId,
    labelId: ann.labelId,
    templateId: ann.templateId,
  };

  updateSkeletonLines(group, template);
  group.setCoords();
  return group;
}

export function createLabelForPose(
  labelName: string,
  scene: Pick<PoseSceneGeometry, 'cx' | 'cy' | 'width' | 'height'>,
): FabricText {
  const topY = scene.cy - scene.height / 2;
  const t = new FabricText(displayLabelName(labelName), {
    left: scene.cx - scene.width / 2 + BBOX_THEME.labelTextOffsetX,
    top: topY + BBOX_THEME.labelTextOffsetY,
    ...boxLabelFabricTextProps(),
    originX: 'left',
    originY: 'top',
    selectable: false,
    evented: false,
  });
  (t as AnnotatedLabelText).lrAnnotationLabel = true;
  return t;
}

export function syncLabelFromPoseGroup(group: AnnotatedPoseGroup): void {
  const labelObj = group._labelObj;
  if (!labelObj) return;
  const scene = getPoseSceneGeometryFromGroup(group);
  const topY = scene.cy - scene.height / 2;
  labelObj.set({
    left: scene.cx - scene.width / 2 + BBOX_THEME.labelTextOffsetX,
    top: topY + BBOX_THEME.labelTextOffsetY,
    ...boxLabelFabricTextProps(),
  });
  labelObj.setCoords();
}

export function setPoseGroupSelectedStyle(
  group: AnnotatedPoseGroup,
  selected: boolean,
  hovered: boolean,
): void {
  const outline = group._bboxOutline;
  if (outline) {
    outline.set({
      visible: selected || hovered,
      stroke: selected ? '#32ff32' : 'rgba(50,255,50,0.6)',
      strokeDashArray: [...POSE_BBOX_DASH_ARRAY],
    });
  }
  const circles = group._keypointCircles ?? [];
  circles.forEach((c) => {
    c.set({
      radius: selected ? KEYPOINT_ACTIVE_RADIUS : KEYPOINT_HANDLE_RADIUS,
      lockMovementX: true,
      lockMovementY: true,
      evented: false,
    });
  });
  group.set({
    hasControls: selected,
    hasBorders: false,
    hoverCursor: 'move',
    moveCursor: 'move',
  });
  if (selected) {
    const mtr = group.controls?.mtr;
    if (mtr) mtr.cursorStyle = 'grab';
  }
}

export function attachPoseGroupAndLabel(
  canvas: Canvas,
  options: {
    ann: PoseAnnotation;
    template: KeypointTemplate;
    scene: PoseSceneGeometry;
    labelName: string;
    selectable: boolean;
  },
): AnnotatedPoseGroup {
  const group = buildPoseGroup(
    options.ann,
    options.template,
    options.scene,
    options.ann.id,
  );
  const label = createLabelForPose(options.labelName, options.scene);
  group._labelObj = label;

  setPoseGroupSelectedStyle(group, false, false);
  group.set({
    selectable: options.selectable,
    evented: true,
  });

  canvas.add(group);
  canvas.add(label);
  return group;
}

export function removePoseFromCanvas(canvas: Canvas, poseId: string): void {
  const group = findPoseGroupById(canvas, poseId);
  if (group) {
    if (group._labelObj) canvas.remove(group._labelObj);
    canvas.remove(group);
  }
}

export function findPoseGroupById(
  canvas: Canvas,
  poseId: string,
): AnnotatedPoseGroup | undefined {
  return canvas
    .getObjects()
    .find((o) => isAnnotationPoseGroup(o) && o._poseId === poseId) as
    AnnotatedPoseGroup | undefined;
}

export function createPointCircle(
  ann: { id: string; labelId: string | null },
  scene: ScenePoint,
  labelColor: string,
): AnnotatedPointCircle {
  const c = new Circle({
    left: scene.x,
    top: scene.y,
    originX: 'center',
    originY: 'center',
    radius: KEYPOINT_HANDLE_RADIUS,
    fill: hexToRgba(labelColor, 0.85),
    stroke: labelColor,
    strokeWidth: 2,
    hasControls: false,
    hasBorders: false,
  }) as AnnotatedPointCircle;
  c.lrAnnotationPoint = true;
  c._pointId = ann.id;
  c.data = { pointId: ann.id, labelId: ann.labelId };
  return c;
}

export function attachPointAndLabel(
  canvas: Canvas,
  options: {
    ann: { id: string; labelId: string | null };
    scene: ScenePoint;
    labelName: string;
    labelColor: string;
    selectable: boolean;
  },
): AnnotatedPointCircle {
  const circle = createPointCircle(
    options.ann,
    options.scene,
    options.labelColor,
  );
  const label = new FabricText(displayLabelName(options.labelName), {
    left: options.scene.x + BBOX_THEME.labelTextOffsetX,
    top: options.scene.y + BBOX_THEME.labelTextOffsetY,
    ...boxLabelFabricTextProps(),
    selectable: false,
    evented: false,
  });
  (label as AnnotatedLabelText).lrAnnotationLabel = true;
  circle._labelObj = label;
  circle.set({ selectable: options.selectable, evented: options.selectable });
  canvas.add(circle);
  canvas.add(label);
  return circle;
}

export function findPointCircleById(
  canvas: Canvas,
  pointId: string,
): AnnotatedPointCircle | undefined {
  return canvas
    .getObjects()
    .find((o) => isAnnotationPointCircle(o) && o._pointId === pointId) as
    AnnotatedPointCircle | undefined;
}

export function removePointFromCanvas(canvas: Canvas, pointId: string): void {
  const pt = findPointCircleById(canvas, pointId);
  if (pt) {
    if (pt._labelObj) canvas.remove(pt._labelObj);
    canvas.remove(pt);
  }
}

function pointToSegmentDist(
  p: ScenePoint,
  a: ScenePoint,
  b: ScenePoint,
): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq === 0) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * abx;
  const py = a.y + t * aby;
  const dx = p.x - px;
  const dy = p.y - py;
  return Math.sqrt(dx * dx + dy * dy);
}

export function hitKeypointHandleAtScenePoint(
  canvas: Canvas,
  scenePoint: ScenePoint,
  threshold = KEYPOINT_HIT_RADIUS,
): { group: AnnotatedPoseGroup; keypointIndex: number } | null {
  const groups = canvas
    .getObjects()
    .filter(isAnnotationPoseGroup) as AnnotatedPoseGroup[];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group._poseId === '__preview__') continue;
    group.setCoords();
    const circles = group._keypointCircles ?? [];
    const rad = ((group.angle ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const gx = group.left ?? 0;
    const gy = group.top ?? 0;
    const sx = group.scaleX ?? 1;
    const sy = group.scaleY ?? 1;

    for (let j = 0; j < circles.length; j++) {
      const c = circles[j];
      if ((c._visibility ?? 2) === 0) continue;
      const lx = (c.left ?? 0) * sx;
      const ly = (c.top ?? 0) * sy;
      const wx = gx + lx * cos - ly * sin;
      const wy = gy + lx * sin + ly * cos;
      const dx = scenePoint.x - wx;
      const dy = scenePoint.y - wy;
      if (dx * dx + dy * dy <= threshold * threshold) {
        return { group, keypointIndex: j };
      }
    }
  }
  return null;
}

export function hitPoseGroupAtScenePoint(
  canvas: Canvas,
  scenePoint: ScenePoint,
  threshold = KEYPOINT_HIT_RADIUS,
): AnnotatedPoseGroup | undefined {
  const groups = canvas
    .getObjects()
    .filter(isAnnotationPoseGroup) as AnnotatedPoseGroup[];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group._poseId === '__preview__') continue;
    group.setCoords();
    const circles = group._keypointCircles ?? [];
    const rad = ((group.angle ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const gx = group.left ?? 0;
    const gy = group.top ?? 0;
    const sx = group.scaleX ?? 1;
    const sy = group.scaleY ?? 1;

    for (const c of circles) {
      if ((c._visibility ?? 2) === 0) continue;
      const lx = (c.left ?? 0) * sx;
      const ly = (c.top ?? 0) * sy;
      const wx = gx + lx * cos - ly * sin;
      const wy = gy + lx * sin + ly * cos;
      const dx = scenePoint.x - wx;
      const dy = scenePoint.y - wy;
      if (dx * dx + dy * dy <= threshold * threshold) return group;
    }

    const lines = group._skeletonLines ?? [];
    for (const line of lines) {
      if (!line.visible) continue;
      const x1 = line.x1 ?? 0;
      const y1 = line.y1 ?? 0;
      const x2 = line.x2 ?? 0;
      const y2 = line.y2 ?? 0;
      if (
        pointToSegmentDist(scenePoint, { x: x1, y: y1 }, { x: x2, y: y2 }) <=
        SKELETON_HIT_WIDTH
      ) {
        return group;
      }
    }
  }
  return undefined;
}

export function buildPreviewPoseGroup(
  template: KeypointTemplate,
  scene: PoseSceneGeometry,
): AnnotatedPoseGroup {
  const fakeAnn: PoseAnnotation = {
    id: '__preview__',
    kind: 'pose',
    labelId: '',
    templateId: template.id,
    createdAt: '',
    updatedAt: '',
    cx: 0,
    cy: 0,
    width: 0,
    height: 0,
    angle: 0,
    keypoints: [],
  };
  const group = buildPoseGroup(fakeAnn, template, scene, '__preview__');
  group.set({
    opacity: 0.55,
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
  });
  group._keypointCircles?.forEach((c) => {
    c.set({ evented: false, selectable: false });
  });
  return group;
}
