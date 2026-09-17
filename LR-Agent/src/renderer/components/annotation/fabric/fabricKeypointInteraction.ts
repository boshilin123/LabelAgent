import {
  type Canvas,
  type FabricObject,
  type ModifiedEvent,
  type TPointerEvent,
  type TPointerEventInfo,
} from 'fabric';
import type {
  ImagePointAnnotation,
  PoseAnnotation,
} from '../../../types/annotationDocument';
import {
  getKeypointTemplate,
  resolveLabelIdForTemplate,
  type KeypointTemplate,
} from '../../../types/keypointTemplate';
import type { ImageCanvasTool } from '../../../context/AnnotationWorkspaceContext';
import { clampScenePoint } from './fabricPolygonCoords';
import { getScenePointFromEvent } from './fabricScenePoint';
import {
  buildInitialPoseSceneGeometry,
  recomputeTightPoseBounds,
  sceneGeometryToPoseAnn,
  scenePointToNorm,
  type PoseSceneGeometry,
  type ScenePoint,
} from './fabricKeypointCoords';
import { patchPoseHoverStyles } from './fabricKeypointCanvasSync';
import {
  applySceneGeometryToPoseGroup,
  buildPreviewPoseGroup,
  findPoseGroupById,
  getPoseSceneGeometryFromGroup,
  hitKeypointHandleAtScenePoint,
  hitPoseGroupAtScenePoint,
  isAnnotationPointCircle,
  isAnnotationPoseGroup,
  isKeypointHandle,
  KEYPOINT_HIT_RADIUS,
  syncLabelFromPoseGroup,
  updateKeypointCircleVisibility,
  updateSkeletonLines,
  type AnnotatedKeypointCircle,
  type AnnotatedPoseGroup,
} from './fabricKeypointObjects';

const KEYPOINT_HOVER_CURSOR = 'grab';
const KEYPOINT_DRAG_CURSOR = 'grabbing';
const POSE_BODY_CURSOR = 'move';
const KEYPOINT_DEFAULT_CURSOR = 'default';

export interface KeypointInteractionDeps {
  getCanvas: () => Canvas | null;
  getNaturalSize: () => { width: number; height: number };
  getViewZoom: () => number;
  getTool: () => ImageCanvasTool;
  getActiveTemplate: () => KeypointTemplate;
  getProjectLabels: () => { id: string; name: string; color: string }[];
  getPoseAnnotations: () => PoseAnnotation[];
  getPointAnnotations: () => ImagePointAnnotation[];
  addPoseAnnotation: (
    templateId: string,
    centerScene: ScenePoint,
  ) => string | null;
  addPointAnnotation: (scene: ScenePoint, labelId: string) => string | null;
  updatePoseGeometry: (id: string, ann: PoseAnnotation) => void;
  updatePointGeometry: (id: string, x: number, y: number) => void;
  updateKeypointVisibility: (
    poseId: string,
    index: number,
    visibility: 0 | 1 | 2,
  ) => void;
  onBeforeCanvasGeometryCommit?: () => void;
  deleteAnnotation: (id: string) => void;
  selectAnnotation: (id: string | null) => void;
  getSelectedId: () => string | null;
  onLayoutChange: () => void;
  showToast: (msg: string, opts?: { type?: 'info' | 'error' }) => void;
}

function clonePoseSceneGeometry(scene: PoseSceneGeometry): PoseSceneGeometry {
  return {
    ...scene,
    keypoints: scene.keypoints.map((kp) => ({ ...kp })),
  };
}

function keypointMoved(
  start: PoseSceneGeometry,
  current: PoseSceneGeometry,
  index: number,
): boolean {
  const a = start.keypoints[index];
  const b = current.keypoints[index];
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5;
}

export class KeypointCanvasInteraction {
  private previewGroup: AnnotatedPoseGroup | null = null;

  private hoveredPoseId: string | null = null;

  private draggingKeypoint: {
    group: AnnotatedPoseGroup;
    poseId: string;
    keypointIndex: number;
    dragStartScene: PoseSceneGeometry;
    sceneGeometry: PoseSceneGeometry;
  } | null = null;

  private deps: KeypointInteractionDeps;

  private boundHandlers: {
    mouseDown: (e: TPointerEventInfo) => void;
    mouseMove: (e: TPointerEventInfo) => void;
    mouseUp: () => void;
    objectModified: (e: ModifiedEvent) => void;
    objectMoving: (opt: { target?: FabricObject }) => void;
    objectScaling: (opt: { target?: FabricObject; e?: TPointerEvent }) => void;
    objectRotating: (opt: { target?: FabricObject }) => void;
    contextMenu: (e: TPointerEventInfo) => void;
    keyDown: (e: KeyboardEvent) => void;
  };

  constructor(deps: KeypointInteractionDeps) {
    this.deps = deps;
    this.boundHandlers = {
      mouseDown: (e) => this.onMouseDown(e),
      mouseMove: (e) => this.onMouseMove(e),
      mouseUp: () => this.onMouseUp(),
      objectModified: (e) => this.onObjectModified(e),
      objectMoving: (opt) => this.onObjectMoving(opt),
      objectScaling: (opt) => this.onObjectScaling(opt),
      objectRotating: (opt) => this.onObjectRotating(opt),
      contextMenu: (e) => this.onContextMenu(e),
      keyDown: (e) => this.onKeyDown(e),
    };
  }

  bind(canvas: Canvas): () => void {
    canvas.on('mouse:down', this.boundHandlers.mouseDown);
    canvas.on('mouse:move', this.boundHandlers.mouseMove);
    canvas.on('mouse:up', this.boundHandlers.mouseUp);
    canvas.on('object:modified', this.boundHandlers.objectModified);
    canvas.on('object:moving', this.boundHandlers.objectMoving);
    canvas.on('object:scaling', this.boundHandlers.objectScaling);
    canvas.on('object:rotating', this.boundHandlers.objectRotating);
    canvas.on('mouse:down', this.boundHandlers.contextMenu);
    window.addEventListener('keydown', this.boundHandlers.keyDown);
    return () => this.unbind(canvas);
  }

  unbind(canvas: Canvas): void {
    canvas.off('mouse:down', this.boundHandlers.mouseDown);
    canvas.off('mouse:move', this.boundHandlers.mouseMove);
    canvas.off('mouse:up', this.boundHandlers.mouseUp);
    canvas.off('object:modified', this.boundHandlers.objectModified);
    canvas.off('object:moving', this.boundHandlers.objectMoving);
    canvas.off('object:scaling', this.boundHandlers.objectScaling);
    canvas.off('object:rotating', this.boundHandlers.objectRotating);
    canvas.off('mouse:down', this.boundHandlers.contextMenu);
    window.removeEventListener('keydown', this.boundHandlers.keyDown);
    this.draggingKeypoint = null;
    this.clearPreview(canvas);
  }

  private screenStableSize(screenPx: number): number {
    return screenPx / Math.max(this.deps.getViewZoom() || 1, 0.01);
  }

  private getHitThreshold(): number {
    return this.screenStableSize(KEYPOINT_HIT_RADIUS);
  }

  private setCanvasCursor(cursor: string): void {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    canvas.setCursor(cursor);
    const upper = canvas.upperCanvasEl;
    if (upper) upper.style.cursor = cursor;
  }

  private setPoseGroupCursor(group: AnnotatedPoseGroup, cursor: string): void {
    this.setCanvasCursor(cursor);
  }

  private resolvePoseControlCursor(
    group: AnnotatedPoseGroup,
    pointerEvent: TPointerEvent,
  ): string | null {
    const canvas = this.deps.getCanvas();
    if (!canvas) return null;
    const pointer = canvas.getViewportPoint(pointerEvent);
    const hit = group.findControl(pointer);
    if (!hit?.control) return null;
    if (hit.key === 'mtr') {
      return KEYPOINT_HOVER_CURSOR;
    }
    const { control, coord } = hit;
    if (control.cursorStyleHandler) {
      return control.cursorStyleHandler(pointerEvent, control, group, coord);
    }
    return control.cursorStyle ?? null;
  }

  private resolveTransformCursor(
    group: AnnotatedPoseGroup,
    pointerEvent: TPointerEvent,
  ): string | null {
    const canvas = this.deps.getCanvas();
    const transform = canvas?._currentTransform;
    if (!transform || transform.target !== group) return null;

    if (
      transform.action === 'drag' ||
      transform.action === 'rotate' ||
      transform.action === 'rotating' ||
      transform.corner === 'mtr'
    ) {
      return KEYPOINT_DRAG_CURSOR;
    }

    const control = group.controls[transform.corner];
    const coord = group.oCoords[transform.corner];
    if (control && coord) {
      if (control.cursorStyleHandler) {
        return control.cursorStyleHandler(pointerEvent, control, group, coord);
      }
      return control.cursorStyle ?? null;
    }
    return null;
  }

  private resetCursors(): void {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    canvas.getObjects().forEach((o) => {
      if (isAnnotationPoseGroup(o)) {
        (o as AnnotatedPoseGroup).set({
          hoverCursor: POSE_BODY_CURSOR,
          moveCursor: POSE_BODY_CURSOR,
        });
      }
    });
    this.setCanvasCursor(KEYPOINT_DEFAULT_CURSOR);
  }

  private clearPreview(canvas: Canvas): void {
    if (this.previewGroup) {
      canvas.remove(this.previewGroup);
      this.previewGroup = null;
    }
  }

  private getClampedScene(canvas: Canvas, e: TPointerEventInfo): ScenePoint {
    const pt = getScenePointFromEvent(canvas, e);
    const { width, height } = this.deps.getNaturalSize();
    return clampScenePoint({ x: pt.x, y: pt.y }, width, height);
  }

  private getKeypointHit(scene: ScenePoint): {
    group: AnnotatedPoseGroup;
    keypointIndex: number;
  } | null {
    const canvas = this.deps.getCanvas();
    if (!canvas) return null;
    return hitKeypointHandleAtScenePoint(canvas, scene, this.getHitThreshold());
  }

  private selectPose(group: AnnotatedPoseGroup): void {
    const canvas = this.deps.getCanvas();
    if (!group._poseId) return;
    this.deps.selectAnnotation(group._poseId);
    canvas?.setActiveObject(group);
  }

  private startKeypointDrag(
    group: AnnotatedPoseGroup,
    keypointIndex: number,
  ): void {
    const canvas = this.deps.getCanvas();
    if (!canvas || !group._poseId) return;

    const sceneGeometry = getPoseSceneGeometryFromGroup(group);
    this.draggingKeypoint = {
      group,
      poseId: group._poseId,
      keypointIndex,
      dragStartScene: clonePoseSceneGeometry(sceneGeometry),
      sceneGeometry: clonePoseSceneGeometry(sceneGeometry),
    };

    canvas.discardActiveObject();
    this.setCanvasCursor(KEYPOINT_DRAG_CURSOR);
  }

  private updateDraggingKeypoint(scenePt: ScenePoint): void {
    if (!this.draggingKeypoint) return;
    const canvas = this.deps.getCanvas();
    const { width, height } = this.deps.getNaturalSize();
    if (!canvas || width <= 0 || height <= 0) return;

    const clamped = clampScenePoint(scenePt, width, height);
    const { group, keypointIndex, sceneGeometry } = this.draggingKeypoint;
    const template = getKeypointTemplate(group._templateId ?? '');
    if (!template) return;

    const kp = sceneGeometry.keypoints[keypointIndex];
    if (!kp) return;

    sceneGeometry.keypoints[keypointIndex] = {
      ...kp,
      x: clamped.x,
      y: clamped.y,
    };

    applySceneGeometryToPoseGroup(group, sceneGeometry, template);
    syncLabelFromPoseGroup(group);
    this.setCanvasCursor(KEYPOINT_DRAG_CURSOR);
    canvas.requestRenderAll();
  }

  private stopKeypointDrag(): void {
    const canvas = this.deps.getCanvas();
    const drag = this.draggingKeypoint;
    this.draggingKeypoint = null;
    this.resetCursors();

    if (!drag || !canvas) return;

    const { group, poseId, keypointIndex, dragStartScene, sceneGeometry } =
      drag;
    const { width, height } = this.deps.getNaturalSize();
    if (width <= 0 || height <= 0) return;

    const moved = keypointMoved(dragStartScene, sceneGeometry, keypointIndex);
    if (!moved) {
      canvas.requestRenderAll();
      return;
    }

    const template = getKeypointTemplate(group._templateId ?? '');
    if (!template) return;

    const scene = recomputeTightPoseBounds(sceneGeometry, height);
    applySceneGeometryToPoseGroup(group, scene, template);
    syncLabelFromPoseGroup(group);

    const base = this.deps.getPoseAnnotations().find((a) => a.id === poseId);
    if (!base) return;

    this.deps.onBeforeCanvasGeometryCommit?.();
    const updated = sceneGeometryToPoseAnn(scene, width, height, {
      id: base.id,
      labelId: base.labelId,
      templateId: base.templateId,
      createdAt: base.createdAt,
      note: base.note,
    });
    this.deps.updatePoseGeometry(poseId, updated);
    this.deps.onLayoutChange();
    canvas.setActiveObject(group);
    canvas.requestRenderAll();
  }

  private updateSelectModeCursor(
    scene: ScenePoint,
    e: TPointerEventInfo,
  ): void {
    const canvas = this.deps.getCanvas();
    if (!canvas || !e.e) return;

    const pointerEvent = e.e;
    const active = canvas.getActiveObject();

    if (canvas._currentTransform && isAnnotationPoseGroup(active)) {
      const cursor = this.resolveTransformCursor(active, pointerEvent);
      if (cursor) {
        this.setCanvasCursor(cursor);
        return;
      }
    }

    if (active && isAnnotationPoseGroup(active)) {
      const controlCursor = this.resolvePoseControlCursor(active, pointerEvent);
      if (controlCursor) {
        this.setCanvasCursor(controlCursor);
        return;
      }
    }

    const keyHit = this.getKeypointHit(scene);
    if (keyHit) {
      if (this.deps.getSelectedId() !== keyHit.group._poseId) {
        this.deps.selectAnnotation(keyHit.group._poseId ?? null);
      }
      this.setPoseGroupCursor(keyHit.group, KEYPOINT_HOVER_CURSOR);
      return;
    }

    const selectedId = this.deps.getSelectedId();
    const selectedPose = selectedId
      ? findPoseGroupById(canvas, selectedId)
      : null;

    if (selectedPose) {
      const hitGroup = hitPoseGroupAtScenePoint(
        canvas,
        scene,
        this.getHitThreshold(),
      );
      if (hitGroup?._poseId === selectedId) {
        this.setPoseGroupCursor(selectedPose, POSE_BODY_CURSOR);
        return;
      }
    }

    this.resetCursors();
  }

  private onObjectMoving(opt: { target?: FabricObject }): void {
    if (this.deps.getTool() !== 'select') return;
    if (isAnnotationPoseGroup(opt.target)) {
      this.setCanvasCursor(KEYPOINT_DRAG_CURSOR);
    }
  }

  private onObjectScaling(opt: {
    target?: FabricObject;
    e?: TPointerEvent;
  }): void {
    if (this.deps.getTool() !== 'select') return;
    if (!isAnnotationPoseGroup(opt.target) || !opt.e) return;
    const cursor = this.resolveTransformCursor(opt.target, opt.e);
    if (cursor) this.setCanvasCursor(cursor);
  }

  private onObjectRotating(opt: { target?: FabricObject }): void {
    if (this.deps.getTool() !== 'select') return;
    if (isAnnotationPoseGroup(opt.target)) {
      this.setCanvasCursor(KEYPOINT_DRAG_CURSOR);
    }
  }

  private onMouseMove(e: TPointerEventInfo): void {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    const tool = this.deps.getTool();
    const scene = this.getClampedScene(canvas, e);
    const { width, height } = this.deps.getNaturalSize();
    if (width <= 0 || height <= 0) return;

    if (this.draggingKeypoint) {
      this.updateDraggingKeypoint(scene);
      return;
    }

    if (tool === 'place_pose' && !this.deps.getSelectedId()) {
      if (hitPoseGroupAtScenePoint(canvas, scene, this.getHitThreshold())) {
        this.clearPreview(canvas);
        canvas.requestRenderAll();
        return;
      }
      const template = this.deps.getActiveTemplate();
      const geom = buildInitialPoseSceneGeometry(
        template,
        scene,
        width,
        height,
      );
      if (!this.previewGroup) {
        this.previewGroup = buildPreviewPoseGroup(template, geom);
        canvas.add(this.previewGroup);
      } else {
        applySceneGeometryToPoseGroup(this.previewGroup, geom, template);
      }
      canvas.requestRenderAll();
      return;
    }

    this.clearPreview(canvas);

    const hovered = hitPoseGroupAtScenePoint(
      canvas,
      scene,
      this.getHitThreshold(),
    );
    const hoveredId = hovered?._poseId ?? null;
    if (hoveredId !== this.hoveredPoseId) {
      this.hoveredPoseId = hoveredId;
      patchPoseHoverStyles(canvas, hoveredId, this.deps.getSelectedId(), tool);
    }

    if (tool === 'select') {
      this.updateSelectModeCursor(scene, e);
    }
  }

  private onMouseDown(e: TPointerEventInfo): void {
    const canvas = this.deps.getCanvas();
    if (!canvas || !e.e) return;
    if ((e.e as MouseEvent).button !== 0) return;

    const tool = this.deps.getTool();
    const scene = this.getClampedScene(canvas, e);
    const target = e.target as FabricObject | undefined;

    if (tool === 'select') {
      const keyHit = this.getKeypointHit(scene);
      if (keyHit) {
        this.selectPose(keyHit.group);
        this.startKeypointDrag(keyHit.group, keyHit.keypointIndex);
        e.e.preventDefault?.();
        e.e.stopPropagation?.();
        return;
      }

      if (isAnnotationPoseGroup(target)) {
        this.deps.selectAnnotation(target._poseId ?? null);
        return;
      }
      if (isAnnotationPointCircle(target)) {
        this.deps.selectAnnotation(target._pointId ?? null);
        return;
      }
      const hit = hitPoseGroupAtScenePoint(
        canvas,
        scene,
        this.getHitThreshold(),
      );
      if (hit) {
        this.deps.selectAnnotation(hit._poseId ?? null);
        return;
      }
      this.deps.selectAnnotation(null);
      return;
    }

    if (tool === 'place_pose') {
      if (hitPoseGroupAtScenePoint(canvas, scene, this.getHitThreshold())) {
        return;
      }
      const template = this.deps.getActiveTemplate();
      const labelId = resolveLabelIdForTemplate(
        template,
        this.deps.getProjectLabels(),
      );
      if (!labelId) {
        this.deps.showToast(
          `请先在项目中添加标签「${template.defaultLabel}」`,
          { type: 'error' },
        );
        return;
      }
      this.clearPreview(canvas);
      const id = this.deps.addPoseAnnotation(template.id, scene);
      if (id) this.deps.selectAnnotation(id);
      return;
    }

    if (tool === 'place_point') {
      const labels = this.deps.getProjectLabels();
      if (labels.length === 0) {
        this.deps.showToast('请先在项目中定义标签', { type: 'error' });
        return;
      }
      const template = this.deps.getActiveTemplate();
      const labelId =
        resolveLabelIdForTemplate(template, labels) ?? labels[0]?.id;
      if (!labelId) return;
      const id = this.deps.addPointAnnotation(scene, labelId);
      if (id) this.deps.selectAnnotation(id);
    }
  }

  private onMouseUp(): void {
    if (!this.draggingKeypoint) return;
    this.stopKeypointDrag();
  }

  private onObjectModified(e: ModifiedEvent): void {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    const { target } = e;
    if (!target) return;

    const { width, height } = this.deps.getNaturalSize();
    if (width <= 0 || height <= 0) return;

    this.deps.onBeforeCanvasGeometryCommit?.();

    if (isKeypointHandle(target)) {
      const poseId = target._poseId;
      const group = poseId ? findPoseGroupById(canvas, poseId) : undefined;
      if (!group || !poseId) return;
      const template = getKeypointTemplate(group._templateId ?? '');
      if (!template) return;

      updateSkeletonLines(group, template);

      let scene = getPoseSceneGeometryFromGroup(group);
      scene = recomputeTightPoseBounds(scene, height);

      const base = this.deps.getPoseAnnotations().find((a) => a.id === poseId);
      if (!base) return;

      applySceneGeometryToPoseGroup(group, scene, template);

      const updated = sceneGeometryToPoseAnn(scene, width, height, {
        id: base.id,
        labelId: base.labelId,
        templateId: base.templateId,
        createdAt: base.createdAt,
        note: base.note,
      });
      this.deps.updatePoseGeometry(poseId, updated);
      this.deps.onLayoutChange();
      return;
    }

    if (isAnnotationPoseGroup(target)) {
      const poseId = target._poseId;
      if (!poseId) return;
      const base = this.deps.getPoseAnnotations().find((a) => a.id === poseId);
      if (!base) return;
      const template = getKeypointTemplate(base.templateId);
      if (!template) return;

      let scene = getPoseSceneGeometryFromGroup(target);
      scene = recomputeTightPoseBounds(scene, height);
      applySceneGeometryToPoseGroup(target, scene, template);
      syncLabelFromPoseGroup(target);

      const updated = sceneGeometryToPoseAnn(scene, width, height, {
        id: base.id,
        labelId: base.labelId,
        templateId: base.templateId,
        createdAt: base.createdAt,
        note: base.note,
      });
      this.deps.updatePoseGeometry(poseId, updated);
      this.deps.onLayoutChange();
      return;
    }

    if (isAnnotationPointCircle(target)) {
      const pointId = target._pointId;
      if (!pointId) return;
      const norm = scenePointToNorm(
        { x: target.left ?? 0, y: target.top ?? 0 },
        width,
        height,
      );
      this.deps.updatePointGeometry(pointId, norm.x, norm.y);
      if (target._labelObj) {
        target._labelObj.set({
          left: (target.left ?? 0) + 4,
          top: (target.top ?? 0) + 2,
        });
      }
      this.deps.onLayoutChange();
    }
  }

  private onContextMenu(e: TPointerEventInfo): void {
    const ev = e.e as MouseEvent | undefined;
    if (!ev || ev.button !== 2) return;
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    if (this.deps.getTool() !== 'select') return;

    const scene = this.getClampedScene(canvas, e);
    const hit = this.getKeypointHit(scene);
    if (!hit) {
      const { target } = e;
      if (!isKeypointHandle(target)) return;
      ev.preventDefault();
      const poseId = target._poseId;
      const index = target._keypointIndex;
      if (poseId === undefined || index === undefined) return;
      this.applyVisibilityCycle(
        canvas,
        target as AnnotatedKeypointCircle,
        poseId,
        index,
      );
      return;
    }

    ev.preventDefault();
    const { group, keypointIndex } = hit;
    const poseId = group._poseId;
    if (!poseId) return;
    const circle = group._keypointCircles?.[keypointIndex];
    if (!circle) return;
    this.applyVisibilityCycle(canvas, circle, poseId, keypointIndex);
  }

  private applyVisibilityCycle(
    canvas: Canvas,
    target: AnnotatedKeypointCircle,
    poseId: string,
    index: number,
  ): void {
    const group = findPoseGroupById(canvas, poseId);
    const template = getKeypointTemplate(group?._templateId ?? '');
    if (!template || !group) return;

    const current = target._visibility ?? 2;
    const next = ((current + 1) % 3) as 0 | 1 | 2;
    updateKeypointCircleVisibility(
      target,
      next,
      template.keypoints[index]?.color ?? '#00ff00',
    );
    this.deps.updateKeypointVisibility(poseId, index, next);
    updateSkeletonLines(group, template);
    canvas.requestRenderAll();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const id = this.deps.getSelectedId();
      if (id) {
        e.preventDefault();
        this.deps.deleteAnnotation(id);
        this.deps.selectAnnotation(null);
      }
    }
    if (e.key === 'Escape') {
      this.deps.selectAnnotation(null);
    }
  }
}
