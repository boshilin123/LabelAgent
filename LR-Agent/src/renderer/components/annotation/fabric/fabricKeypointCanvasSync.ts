import { Canvas, type FabricObject } from 'fabric';
import type {
  ImagePointAnnotation,
  PoseAnnotation,
} from '../../../types/annotationDocument';
import { getKeypointTemplate } from '../../../types/keypointTemplate';
import type { ImageCanvasTool } from '../../../context/AnnotationWorkspaceContext';
import { BBOX_THEME } from '../annotationBboxTheme';
import { BG_IMAGE_NAME } from './fabricBoxObjects';
import {
  poseAnnToSceneGeometry,
  poseGeometryRoughlyEqual,
  pointAnnToScene,
  sceneGeometryToPoseAnn,
} from './fabricKeypointCoords';
import {
  applySceneGeometryToPoseGroup,
  attachPointAndLabel,
  attachPoseGroupAndLabel,
  findPointCircleById,
  findPoseGroupById,
  getPoseSceneGeometryFromGroup,
  isAnnotationPointCircle,
  isAnnotationPoseGroup,
  removePointFromCanvas,
  removePoseFromCanvas,
  setPoseGroupSelectedStyle,
  syncLabelFromPoseGroup,
  type AnnotatedPointCircle,
  type AnnotatedPoseGroup,
} from './fabricKeypointObjects';

export function getAnnotationPoseGroups(canvas: Canvas): AnnotatedPoseGroup[] {
  return canvas.getObjects().filter(isAnnotationPoseGroup);
}

export function getAnnotationPointCircles(
  canvas: Canvas,
): AnnotatedPointCircle[] {
  return canvas.getObjects().filter(isAnnotationPointCircle);
}

export function syncKeypointInteraction(
  canvas: Canvas,
  tool: ImageCanvasTool,
  selectedId: string | null,
): void {
  const isSelect = tool === 'select';
  canvas.selection = false;
  const drawCursor = 'crosshair';
  const selectCursor = 'default';
  const cursor =
    tool === 'place_pose' || tool === 'place_point' ? drawCursor : selectCursor;
  canvas.defaultCursor = cursor;
  canvas.hoverCursor = tool === 'select' ? 'move' : cursor;
  canvas.moveCursor = 'move';

  getAnnotationPoseGroups(canvas).forEach((g) => {
    const selected = g._poseId === selectedId;
    setPoseGroupSelectedStyle(g, selected && isSelect, false);
    g.set({
      selectable: isSelect,
      evented: true,
      lockMovementX: !isSelect || !selected,
      lockMovementY: !isSelect || !selected,
    });
  });

  getAnnotationPointCircles(canvas).forEach((p) => {
    p.set({ selectable: isSelect, evented: isSelect });
  });

  if (isSelect && selectedId) {
    const pose = findPoseGroupById(canvas, selectedId);
    if (pose) {
      canvas.setActiveObject(pose);
    } else {
      const pt = findPointCircleById(canvas, selectedId);
      if (pt) canvas.setActiveObject(pt);
      else canvas.discardActiveObject();
    }
  } else if (!isSelect) {
    canvas.discardActiveObject();
  } else {
    canvas.discardActiveObject();
  }

  canvas.requestRenderAll();
}

export function syncPosesFromAnnotations(
  canvas: Canvas,
  annotations: PoseAnnotation[],
  labelResolver: (
    labelId: string | null,
  ) => { name: string; color: string } | null,
  naturalWidth: number,
  naturalHeight: number,
  tool: ImageCanvasTool,
  selectedId: string | null,
): void {
  const selectable = tool === 'select';
  const annIds = new Set(annotations.map((a) => a.id));

  getAnnotationPoseGroups(canvas).forEach((g) => {
    const id = g._poseId;
    if (id && id !== '__preview__' && !annIds.has(id)) {
      removePoseFromCanvas(canvas, id);
    }
  });

  annotations.forEach((ann) => {
    const template = getKeypointTemplate(ann.templateId);
    if (!template) return;

    const label = labelResolver(ann.labelId);
    const scene = poseAnnToSceneGeometry(ann, naturalWidth, naturalHeight);
    const labelName = label?.name ?? BBOX_THEME.labelEmptyText;

    const existing = findPoseGroupById(canvas, ann.id);
    if (existing) {
      const expectedScene = poseAnnToSceneGeometry(
        ann,
        naturalWidth,
        naturalHeight,
      );
      const fromGroup = extractPoseFromGroup(
        existing,
        ann,
        naturalWidth,
        naturalHeight,
      );
      const groupScene = poseAnnToSceneGeometry(
        fromGroup,
        naturalWidth,
        naturalHeight,
      );
      if (!poseGeometryRoughlyEqual(expectedScene, groupScene)) {
        applySceneGeometryToPoseGroup(existing, scene, template);
      }
      if (existing._labelObj) {
        existing._labelObj.set({ text: labelName });
      }
      syncLabelFromPoseGroup(existing);
      const selected = ann.id === selectedId;
      setPoseGroupSelectedStyle(existing, selected && selectable, false);
      existing.set({ selectable, evented: true });
      existing.data = {
        poseId: ann.id,
        labelId: ann.labelId,
        templateId: ann.templateId,
      };
      return;
    }

    attachPoseGroupAndLabel(canvas, {
      ann,
      template,
      scene,
      labelName,
      selectable,
    });
  });

  const bg = canvas
    .getObjects()
    .find(
      (o) => (o as FabricObject & { name?: string }).name === BG_IMAGE_NAME,
    );
  if (bg) canvas.sendObjectToBack(bg);
  syncKeypointInteraction(canvas, tool, selectedId);
}

export function syncPointsFromAnnotations(
  canvas: Canvas,
  annotations: ImagePointAnnotation[],
  labelResolver: (
    labelId: string | null,
  ) => { name: string; color: string } | null,
  naturalWidth: number,
  naturalHeight: number,
  tool: ImageCanvasTool,
): void {
  const selectable = tool === 'select';
  const annIds = new Set(annotations.map((a) => a.id));

  getAnnotationPointCircles(canvas).forEach((p) => {
    const id = p._pointId;
    if (id && !annIds.has(id)) removePointFromCanvas(canvas, id);
  });

  annotations.forEach((ann) => {
    const label = labelResolver(ann.labelId);
    const scene = pointAnnToScene(ann, naturalWidth, naturalHeight);
    const existing = findPointCircleById(canvas, ann.id);
    if (existing) {
      existing.set({
        left: scene.x,
        top: scene.y,
        selectable,
        evented: selectable,
      });
      if (existing._labelObj) {
        existing._labelObj.set({
          left: scene.x + BBOX_THEME.labelTextOffsetX,
          top: scene.y + BBOX_THEME.labelTextOffsetY,
          text: label?.name ?? BBOX_THEME.labelEmptyText,
        });
      }
      return;
    }
    attachPointAndLabel(canvas, {
      ann,
      scene,
      labelName: label?.name ?? BBOX_THEME.labelEmptyText,
      labelColor: label?.color ?? BBOX_THEME.defaultLabelColor,
      selectable,
    });
  });
}

export function extractPoseFromGroup(
  group: AnnotatedPoseGroup,
  base: PoseAnnotation,
  naturalWidth: number,
  naturalHeight: number,
): PoseAnnotation {
  const scene = getPoseSceneGeometryFromGroup(group);
  return sceneGeometryToPoseAnn(scene, naturalWidth, naturalHeight, {
    id: base.id,
    labelId: base.labelId,
    templateId: base.templateId,
    createdAt: base.createdAt,
    note: base.note,
  });
}

export function patchPoseHoverStyles(
  canvas: Canvas,
  hoveredId: string | null,
  selectedId: string | null,
  tool: ImageCanvasTool,
): void {
  getAnnotationPoseGroups(canvas).forEach((g) => {
    if (g._poseId === '__preview__') return;
    const selected = g._poseId === selectedId;
    const hovered = g._poseId === hoveredId;
    setPoseGroupSelectedStyle(
      g,
      selected && tool === 'select',
      hovered && !selected,
    );
  });
  canvas.requestRenderAll();
}
