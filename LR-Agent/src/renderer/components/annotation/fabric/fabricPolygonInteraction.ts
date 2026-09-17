import {
  Circle,
  Polygon,
  Point,
  type Canvas,
  type FabricObject,
  type TPointerEventInfo,
} from 'fabric';
import type { PolygonAnnotation } from '../../../types/annotationDocument';
import type { ImageCanvasTool } from '../../../context/AnnotationWorkspaceContext';
import { BBOX_THEME } from '../annotationBboxTheme';
import { getScenePointFromEvent } from './fabricScenePoint';
import {
  clampScenePoint,
  MIN_POLYGON_VERTICES,
  projectPointToSegment,
  roundScenePoint,
  scenePointToNorm,
  scenePointsToNorm,
  type ScenePoint,
} from './fabricPolygonCoords';
import {
  createPolygonVertexHandle,
  getDraftPolygonStyle,
  getPolygonScenePoints,
  insertPolygonVertexAt,
  isAnnotationPolygon,
  removePolygonVertexAt,
  updateSinglePolygonVertex,
  POLYGON_GHOST_EDGE_THRESHOLD,
  POLYGON_SELECTION_BORDER_DASH,
  POLYGON_VERTEX_ACTIVE_HANDLE_RADIUS,
  POLYGON_VERTEX_HANDLE_RADIUS,
  POLYGON_VERTEX_HIT_RADIUS,
  updatePolygonVertexHandleStyle,
  type AnnotatedPolygon,
  type PolygonVertexHandle,
} from './fabricPolygonObjects';
import {
  extractNormFromPolygon,
  findAnnotationPolygonById,
  hitTopAnnotationPolygonAtScenePoint,
} from './fabricPolygonCanvasSync';

export interface PolygonInteractionDeps {
  getCanvas: () => Canvas | null;
  getNaturalSize: () => { width: number; height: number };
  getViewZoom: () => number;
  getTool: () => ImageCanvasTool;
  getActiveLabelColor: () => string;
  getActiveLabelId: () => string | null;
  getPolygonAnnotations: () => PolygonAnnotation[];
  addPolygonAnnotation: (points: { x: number; y: number }[]) => boolean;
  updatePolygonGeometry: (
    id: string,
    points: { x: number; y: number }[],
  ) => void;
  /** Called before canvas-driven geometry commit so React sync skips destroy/recreate */
  onBeforeCanvasGeometryCommit?: () => void;
  deleteAnnotation: (id: string) => void;
  selectAnnotation: (id: string | null) => void;
  getSelectedId: () => string | null;
  onLayoutChange: () => void;
  showToast: (msg: string, opts?: { type?: 'info' | 'error' }) => void;
}

const POLYGON_VERTEX_HOVER_CURSOR = 'grab';
const POLYGON_VERTEX_DRAG_CURSOR = 'grabbing';
const POLYGON_BODY_CURSOR = 'default';
const POLYGON_DEFAULT_CURSOR = 'default';
/** Min scene-pixel movement to treat as a drag (not a click) */
const VERTEX_DRAG_MOVE_THRESHOLD = 0.5;

export class PolygonCanvasInteraction {
  private draft: ScenePoint[] = [];

  private draftLine: Polygon | null = null;

  private draftCloseMarker: Circle | null = null;

  private vertexHandles: PolygonVertexHandle[] = [];

  private ghostVertex: Circle | null = null;

  private ghostState: {
    polygonId: string;
    insertIndex: number;
    point: ScenePoint;
  } | null = null;

  private draggingVertex: {
    obj: AnnotatedPolygon;
    polygonId: string;
    vertexIndex: number;
    scenePoints: ScenePoint[];
    dragStartScenePoints: ScenePoint[];
  } | null = null;

  private deps: PolygonInteractionDeps;

  constructor(deps: PolygonInteractionDeps) {
    this.deps = deps;
  }

  private setCanvasCursor(cursor: string): void {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    canvas.setCursor(cursor);
    const upper = canvas.upperCanvasEl;
    if (upper) upper.style.cursor = cursor;
  }

  private setPolygonObjectCursor(obj: AnnotatedPolygon, cursor: string): void {
    obj.set({ hoverCursor: cursor, moveCursor: cursor });
    this.setCanvasCursor(cursor);
  }

  private resetPolygonCursors(): void {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    canvas.getObjects().forEach((o) => {
      if (isAnnotationPolygon(o)) {
        (o as AnnotatedPolygon).set({
          hoverCursor: POLYGON_BODY_CURSOR,
          moveCursor: POLYGON_BODY_CURSOR,
        });
      }
    });
    this.setCanvasCursor(POLYGON_DEFAULT_CURSOR);
  }

  private screenStableSize(screenPx: number): number {
    return screenPx / Math.max(this.deps.getViewZoom() || 1, 0.01);
  }

  private commitGeometryFromCanvas(
    poly: AnnotatedPolygon,
    polygonId: string,
    opts?: {
      draggedVertexIndex?: number;
      insertedAtIndex?: number;
      insertedScene?: ScenePoint;
      removedAtIndex?: number;
    },
  ): void {
    const { width: nw, height: nh } = this.deps.getNaturalSize();
    if (!poly._polygonId || nw <= 0 || nh <= 0) return;

    const ann = this.deps
      .getPolygonAnnotations()
      .find((a) => a.id === polygonId);
    const vertexCount = poly.points?.length ?? 0;
    const dragIdx = opts?.draggedVertexIndex;
    const removedIdx = opts?.removedAtIndex;
    const insertIdx = opts?.insertedAtIndex;
    const insertedScene = opts?.insertedScene;
    let norm: { x: number; y: number }[];

    if (
      removedIdx != null &&
      ann &&
      removedIdx >= 0 &&
      removedIdx < ann.points.length &&
      ann.points.length > MIN_POLYGON_VERTICES
    ) {
      norm = ann.points.filter((_, i) => i !== removedIdx);
    } else if (
      insertIdx != null &&
      insertedScene &&
      ann &&
      insertIdx >= 0 &&
      insertIdx <= ann.points.length
    ) {
      const newNorm = scenePointToNorm(roundScenePoint(insertedScene), nw, nh);
      norm = [
        ...ann.points.slice(0, insertIdx),
        newNorm,
        ...ann.points.slice(insertIdx),
      ];
    } else if (
      dragIdx != null &&
      ann &&
      ann.points.length === vertexCount &&
      vertexCount > 0
    ) {
      const draggedScene = getPolygonScenePoints(poly)[dragIdx];
      if (!draggedScene) return;
      const draggedNorm = scenePointToNorm(
        roundScenePoint(draggedScene),
        nw,
        nh,
      );
      norm = ann.points.map((pt, i) => (i === dragIdx ? draggedNorm : pt));
    } else {
      norm = extractNormFromPolygon(poly, nw, nh);
    }

    this.deps.onBeforeCanvasGeometryCommit?.();
    this.deps.updatePolygonGeometry(polygonId, norm);
    this.deps.onLayoutChange();
  }

  private static scenePointsMoved(
    a: ScenePoint[],
    b: ScenePoint[],
    threshold = VERTEX_DRAG_MOVE_THRESHOLD,
  ): boolean {
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      if (Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y) > threshold) {
        return true;
      }
    }
    return false;
  }

  cancelDraft(): void {
    const canvas = this.deps.getCanvas();
    if (canvas && this.draftLine) {
      canvas.remove(this.draftLine);
      this.draftLine = null;
    }
    this.hideDraftCloseMarker(false);
    this.stopVertexDrag(false, false);
    this.hideVertexHandles(false);
    this.draft = [];
    if (canvas) canvas.requestRenderAll();
  }

  hideVertexHandles(render = true): void {
    const canvas = this.deps.getCanvas();
    if (!canvas || !this.vertexHandles.length) return;
    const polygonId = this.vertexHandles[0]?._polygonVertexHandle?.polygonId;
    this.vertexHandles.forEach((h) => canvas.remove(h));
    this.vertexHandles = [];
    if (polygonId) {
      const obj = findAnnotationPolygonById(canvas, polygonId);
      obj?.set({ hasBorders: false, borderDashArray: undefined });
    }
    if (render) canvas.requestRenderAll();
  }

  showVertexHandles(
    obj: AnnotatedPolygon,
    activeVertexIndex?: number | null,
    scenePoints?: ScenePoint[],
  ): void {
    const resolvedActive = activeVertexIndex ?? null;
    const canvas = this.deps.getCanvas();
    if (!canvas || !obj._polygonId || this.deps.getTool() !== 'select') return;

    obj.set({
      hasBorders: true,
      borderColor: (obj.stroke as string) || BBOX_THEME.defaultLabelColor,
      borderDashArray: [...POLYGON_SELECTION_BORDER_DASH],
    });

    const points = scenePoints ?? getPolygonScenePoints(obj);
    const currentId = this.vertexHandles[0]?._polygonVertexHandle?.polygonId;
    const radius = this.screenStableSize(POLYGON_VERTEX_HANDLE_RADIUS);

    if (
      currentId !== obj._polygonId ||
      this.vertexHandles.length !== points.length
    ) {
      this.hideVertexHandles(false);
      this.vertexHandles = points.map((point, index) => {
        const handle = createPolygonVertexHandle(obj, point, index, radius);
        canvas.add(handle);
        return handle;
      });
    }

    this.syncVertexHandlePositions(obj, points, resolvedActive);
    canvas.requestRenderAll();
  }

  private syncVertexHandlePositions(
    obj: AnnotatedPolygon,
    points: ScenePoint[],
    activeVertexIndex: number | null,
  ): void {
    const canvas = this.deps.getCanvas();
    if (!canvas || !this.vertexHandles.length) return;

    const radius = this.screenStableSize(POLYGON_VERTEX_HANDLE_RADIUS);
    const activeRadius = this.screenStableSize(
      POLYGON_VERTEX_ACTIVE_HANDLE_RADIUS,
    );

    this.vertexHandles.forEach((handle, index) => {
      const point = points[index];
      if (!point) return;
      updatePolygonVertexHandleStyle(
        handle,
        obj,
        point,
        index,
        activeVertexIndex,
        radius,
        activeRadius,
      );
      canvas.bringObjectToFront(handle);
    });
  }

  private hideGhostVertex(render = true): void {
    const canvas = this.deps.getCanvas();
    this.ghostState = null;
    if (canvas && this.ghostVertex) {
      canvas.remove(this.ghostVertex);
      this.ghostVertex = null;
      if (render) canvas.requestRenderAll();
    }
  }

  private hideDraftCloseMarker(render = true): void {
    const canvas = this.deps.getCanvas();
    if (canvas && this.draftCloseMarker) {
      canvas.remove(this.draftCloseMarker);
      this.draftCloseMarker = null;
      if (render) canvas.requestRenderAll();
    }
  }

  private findNearestVertex(
    obj: AnnotatedPolygon,
    scenePt: Point,
    threshold = this.screenStableSize(POLYGON_VERTEX_HIT_RADIUS),
  ): number {
    let best = -1;
    let bestDist = Infinity;
    getPolygonScenePoints(obj).forEach((world, index) => {
      const dist = Math.hypot(world.x - scenePt.x, world.y - scenePt.y);
      if (dist < bestDist && dist <= threshold) {
        best = index;
        bestDist = dist;
      }
    });
    return best;
  }

  private getVertexHit(scenePt: Point): {
    obj: AnnotatedPolygon;
    vertexIndex: number;
  } | null {
    const canvas = this.deps.getCanvas();
    if (!canvas) return null;
    const threshold = this.screenStableSize(POLYGON_VERTEX_HIT_RADIUS);
    const candidates = canvas
      .getObjects()
      .filter((o) => isAnnotationPolygon(o))
      .reverse();
    for (const obj of candidates) {
      const poly = obj as AnnotatedPolygon;
      const vertexIndex = this.findNearestVertex(poly, scenePt, threshold);
      if (vertexIndex >= 0) return { obj: poly, vertexIndex };
    }
    return null;
  }

  private findClosestEdge(obj: AnnotatedPolygon, scenePt: Point) {
    const points = getPolygonScenePoints(obj);
    if (points.length < 2) return null;
    let best: {
      distance: number;
      insertIndex: number;
      point: ScenePoint;
    } | null = null;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const { distance, point } = projectPointToSegment(scenePt, a, b);
      if (!best || distance < best.distance) {
        best = { distance, insertIndex: i + 1, point };
      }
    }
    const threshold = this.screenStableSize(POLYGON_GHOST_EDGE_THRESHOLD);
    return best && best.distance <= threshold ? best : null;
  }

  private updateGhostVertex(scenePt: Point, target: FabricObject | undefined) {
    const canvas = this.deps.getCanvas();
    if (!canvas || this.deps.getTool() !== 'select') return;

    const selectedId = this.deps.getSelectedId();
    const obj =
      target && isAnnotationPolygon(target) && target._polygonId === selectedId
        ? (target as AnnotatedPolygon)
        : selectedId
          ? findAnnotationPolygonById(canvas, selectedId)
          : null;

    if (!obj?._polygonId) {
      this.hideGhostVertex();
      return;
    }

    const closest = this.findClosestEdge(obj, scenePt);
    if (!closest) {
      this.hideGhostVertex();
      return;
    }

    this.ghostState = {
      polygonId: obj._polygonId,
      insertIndex: closest.insertIndex,
      point: closest.point,
    };

    const radius = this.screenStableSize(5);
    if (!this.ghostVertex) {
      this.ghostVertex = new Circle({
        left: closest.point.x,
        top: closest.point.y,
        radius,
        originX: 'center',
        originY: 'center',
        fill: 'rgba(255,255,255,0.9)',
        stroke: (obj.stroke as string) || BBOX_THEME.defaultLabelColor,
        strokeWidth: 2,
        strokeUniform: true,
        selectable: false,
        evented: false,
      });
      canvas.add(this.ghostVertex);
    } else {
      this.ghostVertex.set({
        left: closest.point.x,
        top: closest.point.y,
        stroke: obj.stroke,
      });
    }
    canvas.bringObjectToFront(this.ghostVertex);
    canvas.requestRenderAll();
  }

  private isNearDraftFirst(scenePt: Point, threshold = 10): boolean {
    if (this.draft.length < MIN_POLYGON_VERTICES) return false;
    const first = this.draft[0];
    const t = this.screenStableSize(threshold);
    return Math.hypot(scenePt.x - first.x, scenePt.y - first.y) <= t;
  }

  private redrawDraft(mousePt: Point | null = null): void {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;

    if (this.draftLine) {
      canvas.remove(this.draftLine);
      this.draftLine = null;
    }

    const displayPoints = mousePt
      ? [...this.draft, { x: mousePt.x, y: mousePt.y }]
      : this.draft;

    if (displayPoints.length >= 2) {
      const color = this.deps.getActiveLabelColor();
      this.draftLine = new Polygon(displayPoints, {
        ...getDraftPolygonStyle(color),
        fill:
          this.draft.length >= MIN_POLYGON_VERTICES
            ? getDraftPolygonStyle(color).fill
            : 'transparent',
      });
      canvas.add(this.draftLine);
      canvas.bringObjectToFront(this.draftLine);
    }

    if (mousePt && this.isNearDraftFirst(mousePt)) {
      const first = this.draft[0];
      if (!this.draftCloseMarker) {
        this.draftCloseMarker = new Circle({
          left: first.x,
          top: first.y,
          radius: this.screenStableSize(6),
          originX: 'center',
          originY: 'center',
          fill: '#22c55e',
          stroke: '#ffffff',
          strokeWidth: 2,
          strokeUniform: true,
          selectable: false,
          evented: false,
        });
        canvas.add(this.draftCloseMarker);
      } else {
        this.draftCloseMarker.set({ left: first.x, top: first.y });
      }
      canvas.bringObjectToFront(this.draftCloseMarker);
    } else {
      this.hideDraftCloseMarker(false);
    }

    canvas.requestRenderAll();
  }

  private finalizeDraft(): void {
    if (this.draft.length < MIN_POLYGON_VERTICES) return;
    const canvas = this.deps.getCanvas();
    const { width: nw, height: nh } = this.deps.getNaturalSize();
    if (!canvas || nw <= 0 || nh <= 0) return;

    if (!this.deps.getActiveLabelId()) {
      this.deps.showToast('请先在工具栏选择绘制用标签', { type: 'info' });
      this.cancelDraft();
      return;
    }

    const norm = scenePointsToNorm(this.draft, nw, nh);
    const added = this.deps.addPolygonAnnotation(norm);
    if (!added) {
      this.deps.showToast('标注数据尚未加载完成，请稍后再试', {
        type: 'error',
      });
      return;
    }

    this.cancelDraft();
    this.deps.selectAnnotation(null);
    this.deps.onLayoutChange();
  }

  undoDraftPoint(): boolean {
    if (this.deps.getTool() !== 'polygon' || !this.draft.length) return false;
    this.draft.pop();
    this.redrawDraft();
    return true;
  }

  /** Used by workspace Ctrl+Z before annotation history undo. */
  tryUndoDraftPoint(): boolean {
    return this.undoDraftPoint();
  }

  private addVertex(
    obj: AnnotatedPolygon,
    scenePt: Point,
    insertIndex: number | null = null,
  ): void {
    const { width: nw, height: nh } = this.deps.getNaturalSize();
    const vertexCount = obj.points?.length ?? 0;

    let idx = insertIndex;
    if (idx == null) {
      const closest = this.findClosestEdge(obj, scenePt);
      idx = closest?.insertIndex ?? vertexCount;
    }
    idx = Math.max(0, Math.min(idx, vertexCount));

    const clamped = clampScenePoint({ x: scenePt.x, y: scenePt.y }, nw, nh);
    this.hideGhostVertex(false);
    insertPolygonVertexAt(obj, idx, clamped);

    if (obj._polygonId) {
      this.commitGeometryFromCanvas(obj, obj._polygonId, {
        insertedAtIndex: idx,
        insertedScene: clamped,
      });
    }

    this.showVertexHandles(obj, idx);
    this.deps.getCanvas()?.requestRenderAll();
  }

  private removeVertexByIndex(polygonId: string, index: number): void {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    const obj = findAnnotationPolygonById(canvas, polygonId);
    if (!obj) return;

    const vertexCount = obj.points?.length ?? 0;
    if (vertexCount <= MIN_POLYGON_VERTICES) return;
    if (index < 0 || index >= vertexCount) return;

    removePolygonVertexAt(obj, index);

    if (obj._polygonId) {
      this.commitGeometryFromCanvas(obj, obj._polygonId, {
        removedAtIndex: index,
      });
    }

    const nextActive = Math.min(
      index,
      Math.max(0, (obj.points?.length ?? 1) - 1),
    );
    this.showVertexHandles(obj, nextActive);
    canvas?.requestRenderAll();
  }

  private stopVertexDrag(render = true, keepHandles = true): void {
    const drag = this.draggingVertex;
    this.draggingVertex = null;
    this.resetPolygonCursors();
    if (drag && keepHandles) {
      this.showVertexHandles(
        drag.obj,
        drag.vertexIndex,
        getPolygonScenePoints(drag.obj),
      );
    }
    if (render) this.deps.getCanvas()?.requestRenderAll();
  }

  private startVertexDrag(obj: AnnotatedPolygon, vertexIndex: number): void {
    const canvas = this.deps.getCanvas();
    if (!canvas || !obj._polygonId) return;

    const scenePoints = getPolygonScenePoints(obj).map((pt) => ({ ...pt }));
    this.draggingVertex = {
      obj,
      polygonId: obj._polygonId,
      vertexIndex,
      scenePoints,
      dragStartScenePoints: scenePoints.map((pt) => ({ ...pt })),
    };

    canvas.discardActiveObject();
    this.setPolygonObjectCursor(obj, POLYGON_VERTEX_DRAG_CURSOR);
    this.showVertexHandles(obj, vertexIndex, scenePoints);
    this.hideGhostVertex(false);
  }

  private updateDraggingVertex(scenePt: Point): void {
    if (!this.draggingVertex) return;
    const canvas = this.deps.getCanvas();
    const { width: nw, height: nh } = this.deps.getNaturalSize();
    const { obj } = this.draggingVertex;
    const { vertexIndex, scenePoints } = this.draggingVertex;

    const clamped = clampScenePoint({ x: scenePt.x, y: scenePt.y }, nw, nh);
    scenePoints[vertexIndex] = clamped;

    updateSinglePolygonVertex(obj, vertexIndex, clamped);
    this.syncVertexHandlePositions(obj, scenePoints, vertexIndex);
    this.setPolygonObjectCursor(obj, POLYGON_VERTEX_DRAG_CURSOR);
    canvas?.requestRenderAll();
  }

  private selectPolygon(
    poly: AnnotatedPolygon,
    vertexIndex: number | null = null,
  ): void {
    const canvas = this.deps.getCanvas();
    if (!poly._polygonId) return;
    this.deps.selectAnnotation(poly._polygonId);
    canvas?.discardActiveObject();
    this.showVertexHandles(poly, vertexIndex);
  }

  onMouseDown = (opt: TPointerEventInfo): void => {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    const scenePt = getScenePointFromEvent(canvas, opt);
    const { target } = opt;
    const tool = this.deps.getTool();

    if (tool === 'select') {
      const hit = this.getVertexHit(scenePt);
      if (hit) {
        if (opt.e && 'button' in opt.e && opt.e.button === 2) {
          this.removeVertexByIndex(hit.obj._polygonId!, hit.vertexIndex);
        } else {
          this.selectPolygon(hit.obj, hit.vertexIndex);
          this.startVertexDrag(hit.obj, hit.vertexIndex);
        }
        opt.e?.preventDefault?.();
        opt.e?.stopPropagation?.();
        return;
      }

      const selectedId = this.deps.getSelectedId();
      const selectedPoly = selectedId
        ? findAnnotationPolygonById(canvas, selectedId)
        : null;

      if (
        this.ghostState &&
        selectedPoly?._polygonId === this.ghostState.polygonId
      ) {
        const near = this.findNearestVertex(selectedPoly, scenePt);
        if (near < 0) {
          this.addVertex(
            selectedPoly,
            new Point(this.ghostState.point.x, this.ghostState.point.y),
            this.ghostState.insertIndex,
          );
        }
        return;
      }

      if (target && isAnnotationPolygon(target)) {
        const poly = target as AnnotatedPolygon;
        if (opt.e && 'button' in opt.e && opt.e.button === 2) {
          const idx = this.findNearestVertex(poly, scenePt);
          if (idx >= 0) this.removeVertexByIndex(poly._polygonId!, idx);
          return;
        }
        this.selectPolygon(poly);
        return;
      }

      const hitPoly = hitTopAnnotationPolygonAtScenePoint(canvas, scenePt);
      if (hitPoly?._polygonId) {
        this.selectPolygon(hitPoly);
        return;
      }

      this.deps.selectAnnotation(null);
      this.hideVertexHandles();
      return;
    }

    if (tool === 'polygon') {
      if (!this.deps.getActiveLabelId()) {
        this.deps.showToast('请先在工具栏选择绘制用标签', { type: 'info' });
        return;
      }

      const hitPoly = hitTopAnnotationPolygonAtScenePoint(canvas, scenePt);
      if (hitPoly) {
        this.deps.showToast('此处已有标注，请点空白区域绘制', { type: 'info' });
        return;
      }

      if (
        this.draft.length >= MIN_POLYGON_VERTICES &&
        ((opt.e && 'detail' in opt.e && opt.e.detail >= 2) ||
          this.isNearDraftFirst(scenePt))
      ) {
        this.finalizeDraft();
        return;
      }

      const { width: nw, height: nh } = this.deps.getNaturalSize();
      const clamped = clampScenePoint(scenePt, nw, nh);
      this.draft.push(clamped);
      this.redrawDraft();
    }
  };

  onMouseMove = (opt: TPointerEventInfo): void => {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;
    const scenePt = getScenePointFromEvent(canvas, opt);

    if (this.draggingVertex) {
      this.updateDraggingVertex(scenePt);
      this.setPolygonObjectCursor(
        this.draggingVertex.obj,
        POLYGON_VERTEX_DRAG_CURSOR,
      );
      return;
    }

    if (this.deps.getTool() === 'polygon') {
      this.redrawDraft(scenePt);
      return;
    }

    if (this.deps.getTool() === 'select') {
      const hit = this.getVertexHit(scenePt);
      if (hit) {
        if (this.deps.getSelectedId() !== hit.obj._polygonId) {
          this.deps.selectAnnotation(hit.obj._polygonId ?? null);
        }
        this.showVertexHandles(hit.obj, hit.vertexIndex);
        this.hideGhostVertex(false);
        this.setPolygonObjectCursor(hit.obj, POLYGON_VERTEX_HOVER_CURSOR);
        return;
      }

      const selectedId = this.deps.getSelectedId();
      const selectedPoly = selectedId
        ? findAnnotationPolygonById(canvas, selectedId)
        : null;

      if (selectedPoly) {
        this.showVertexHandles(selectedPoly);
        this.updateGhostVertex(scenePt, selectedPoly);
        this.setPolygonObjectCursor(selectedPoly, POLYGON_BODY_CURSOR);
      } else {
        this.hideGhostVertex();
        this.resetPolygonCursors();
      }
    }
  };

  onMouseUp = (): void => {
    if (!this.draggingVertex) return;
    const { obj, polygonId, vertexIndex, scenePoints, dragStartScenePoints } =
      this.draggingVertex;
    this.draggingVertex = null;
    this.resetPolygonCursors();

    const moved = PolygonCanvasInteraction.scenePointsMoved(
      scenePoints,
      dragStartScenePoints,
    );

    if (moved) {
      this.commitGeometryFromCanvas(obj, polygonId, {
        draggedVertexIndex: vertexIndex,
      });
    }

    const displayPoints = getPolygonScenePoints(obj);
    this.showVertexHandles(obj, vertexIndex, displayPoints);
    this.deps.getCanvas()?.requestRenderAll();
  };

  bind(canvas: Canvas): () => void {
    canvas.on('mouse:down', this.onMouseDown);
    canvas.on('mouse:move', this.onMouseMove);
    canvas.on('mouse:up', this.onMouseUp);
    return () => {
      canvas.off('mouse:down', this.onMouseDown);
      canvas.off('mouse:move', this.onMouseMove);
      canvas.off('mouse:up', this.onMouseUp);
      this.cancelDraft();
    };
  }

  handleKeyDown(ev: KeyboardEvent): boolean {
    if (ev.key === 'Enter' && this.deps.getTool() === 'polygon') {
      this.finalizeDraft();
      return true;
    }
    if (ev.key === 'Escape') {
      this.cancelDraft();
      return true;
    }
    if (
      (ev.key === 'Delete' || ev.key === 'Backspace') &&
      this.deps.getSelectedId()
    ) {
      this.deps.deleteAnnotation(this.deps.getSelectedId()!);
      this.hideVertexHandles();
      return true;
    }
    return false;
  }

  syncSelection(selectedId: string | null): void {
    const canvas = this.deps.getCanvas();
    if (!canvas) return;

    if (!selectedId) {
      canvas.discardActiveObject();
      this.hideVertexHandles();
      return;
    }

    const obj = findAnnotationPolygonById(canvas, selectedId);
    if (obj) {
      canvas.discardActiveObject();
      if (this.deps.getTool() === 'select') {
        this.showVertexHandles(obj);
      }
      canvas.requestRenderAll();
    }
  }

  onToolChange(tool: ImageCanvasTool): void {
    this.cancelDraft();
    if (tool !== 'select') this.hideVertexHandles();
  }
}
