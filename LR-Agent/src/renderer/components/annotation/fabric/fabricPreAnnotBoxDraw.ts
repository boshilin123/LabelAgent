import { Rect, type Canvas } from 'fabric';
import type { ImageCanvasTool } from '../../../context/AnnotationWorkspaceContext';
import { isBoxTooSmall, sceneRectToNorm } from './fabricBboxCoords';

const PREANNOT_BOX_STYLE = {
  fill: 'rgba(0, 127, 212, 0.12)',
  stroke: '#007fd4',
  strokeWidth: 2,
  strokeDashArray: [6, 4] as number[],
  selectable: false,
  evented: false,
};

export interface PreAnnotBoxDrawDeps {
  getTool: () => ImageCanvasTool;
  getNaturalSize: () => { width: number; height: number };
  onComplete: (box: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }) => void | Promise<void>;
  onTooSmall?: () => void;
}

export function bindPreAnnotBoxDraw(
  canvas: Canvas,
  deps: PreAnnotBoxDrawDeps,
): () => void {
  let drawingRect: Rect | null = null;
  let pointerDown = false;
  let origin = { x: 0, y: 0 };
  let windowListeners: (() => void) | null = null;

  const clearWindowListeners = () => {
    if (!windowListeners) return;
    windowListeners();
    windowListeners = null;
  };

  const removeDraft = () => {
    if (drawingRect && canvas.getObjects().includes(drawingRect)) {
      canvas.remove(drawingRect);
      canvas.requestRenderAll();
    }
    drawingRect = null;
  };

  const isBoxTool = (tool: ImageCanvasTool) =>
    tool === 'preannot_sam_box' || tool === 'preannot_roi_box';

  const finishDraw = () => {
    if (!pointerDown || !drawingRect || !isBoxTool(deps.getTool())) {
      pointerDown = false;
      clearWindowListeners();
      removeDraft();
      return;
    }

    pointerDown = false;
    clearWindowListeners();

    const r = drawingRect;
    drawingRect = null;

    const w = (r.width ?? 0) * (r.scaleX ?? 1);
    const h = (r.height ?? 0) * (r.scaleY ?? 1);

    if (isBoxTooSmall(w, h)) {
      canvas.remove(r);
      canvas.requestRenderAll();
      deps.onTooSmall?.();
      return;
    }

    canvas.remove(r);
    canvas.requestRenderAll();

    const { width: nw, height: nh } = deps.getNaturalSize();
    const left = r.left ?? 0;
    const top = r.top ?? 0;
    const norm = sceneRectToNorm({ left, top, width: w, height: h }, nw, nh);
    const x1 = norm.x;
    const y1 = norm.y;
    const x2 = norm.x + norm.width;
    const y2 = norm.y + norm.height;

    void deps.onComplete({
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
    });
  };

  const bindWindowDrawEnd = () => {
    if (windowListeners) return;
    const onUp = () => finishDraw();
    window.addEventListener('mouseup', onUp);
    window.addEventListener('pointerup', onUp);
    windowListeners = () => {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('pointerup', onUp);
    };
  };

  const onMouseDown = (opt: {
    e: Event;
    pointer?: { x: number; y: number };
  }) => {
    const tool = deps.getTool();
    if (!isBoxTool(tool)) return;

    const pointer = canvas.getScenePoint(opt.e as MouseEvent);
    pointerDown = true;
    origin = { x: pointer.x, y: pointer.y };

    drawingRect = new Rect({
      left: origin.x,
      top: origin.y,
      width: 0,
      height: 0,
      ...PREANNOT_BOX_STYLE,
      originX: 'left',
      originY: 'top',
    });
    canvas.add(drawingRect);
    canvas.requestRenderAll();
    bindWindowDrawEnd();
  };

  const onMouseMove = (opt: { e: Event }) => {
    if (!pointerDown || !drawingRect || !isBoxTool(deps.getTool())) return;

    const pointer = canvas.getScenePoint(opt.e as MouseEvent);
    const x = Math.min(origin.x, pointer.x);
    const y = Math.min(origin.y, pointer.y);
    const w = Math.abs(pointer.x - origin.x);
    const h = Math.abs(pointer.y - origin.y);

    drawingRect.set({
      left: x,
      top: y,
      width: w,
      height: h,
      scaleX: 1,
      scaleY: 1,
    });
    canvas.requestRenderAll();
  };

  canvas.on('mouse:down', onMouseDown);
  canvas.on('mouse:move', onMouseMove);

  return () => {
    clearWindowListeners();
    removeDraft();
    pointerDown = false;
    canvas.off('mouse:down', onMouseDown);
    canvas.off('mouse:move', onMouseMove);
  };
}

export function isPreAnnotBoxTool(tool: ImageCanvasTool): boolean {
  return tool === 'preannot_sam_box' || tool === 'preannot_roi_box';
}
