import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Canvas,
  FabricImage,
  Rect,
  type FabricObject,
  type TPointerEvent,
} from 'fabric';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { useToast } from '../../context/ToastContext';
import type { RotatedBboxAnnotation } from '../../types/annotationDocument';
import { BBOX_THEME } from './annotationBboxTheme';
import { VIEWPORT_EDGE_PAD, isBoxTooSmall } from './fabric/fabricBboxCoords';
import { BG_IMAGE_NAME } from './fabric/fabricBoxObjects';
import {
  normToSceneRotatedRect,
  rotatedRectAabb,
  sceneRectToRotatedNorm,
} from './fabric/fabricRotatedBboxCoords';
import {
  getRotatedDraftRectStyle,
  ROTATED_BOX_ROTATE_CURSOR,
  syncLabelFromRotatedBoxRect,
  type AnnotatedRotatedBoxRect,
} from './fabric/fabricRotatedBoxObjects';
import {
  extractNormFromRotatedBoxRect,
  findAnnotationRotatedBoxById,
  hitTopAnnotationRotatedBoxAtScenePoint,
  isAnnotationRotatedBoxObject,
  patchAnnotationRotatedBoxStyles,
  syncRotatedBoxesFromAnnotations,
  syncRotatedBoxInteraction,
} from './fabric/fabricRotatedCanvasSync';
import {
  applyCanvasDimensions,
  applyViewportTransform,
  createViewportZoomAnimator,
  MIN_CANVAS_PX,
  resolveContentCanvasSize,
  type ViewportZoomAnimator,
} from './fabric/fabricViewportZoom';
import { createResizeObserver } from '../../utils/resizeObserver';
import ImageAnnotationToolbar from './ImageAnnotationToolbar';
import './ImageFabricAnnotationEditor.css';

interface ImageFabricRotatedBboxAnnotationEditorProps {
  imageUrl: string;
  imagePath: string;
}

const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;

function getSceneExtents(
  naturalWidth: number,
  naturalHeight: number,
  annotations: RotatedBboxAnnotation[],
) {
  let maxX = naturalWidth || 0;
  let maxY = naturalHeight || 0;
  annotations.forEach((ann) => {
    const scene = normToSceneRotatedRect(ann, naturalWidth, naturalHeight);
    const aabb = rotatedRectAabb(scene);
    maxX = Math.max(maxX, aabb.left + aabb.width);
    maxY = Math.max(maxY, aabb.top + aabb.height);
  });
  return {
    maxX: Math.max(maxX, 1),
    maxY: Math.max(maxY, 1),
  };
}

export default function ImageFabricRotatedBboxAnnotationEditor({
  imageUrl,
  imagePath,
}: ImageFabricRotatedBboxAnnotationEditorProps) {
  const { activeProject } = useAnnotation();
  const { showToast } = useToast();
  const {
    rotatedBboxAnnotations,
    selectedAnnotationId,
    selectAnnotation,
    activeLabelId,
    tool,
    setTool,
    addRotatedBboxAnnotation,
    updateRotatedBboxGeometry,
    reportImageNaturalSize,
    loadError,
  } = useAnnotationWorkspace();

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const naturalSizeRef = useRef({ width: 0, height: 0 });
  const viewZoomRef = useRef(1);
  const zoomAnimatorRef = useRef<ViewportZoomAnimator | null>(null);
  const prevBoxIdsRef = useRef<Set<string>>(new Set());
  const syncingToFabricRef = useRef(false);
  const syncingFromFabricRef = useRef(false);
  const isPointerDownRef = useRef(false);
  const startPtRef = useRef<{ x: number; y: number } | null>(null);
  const drawingRectRef = useRef<Rect | null>(null);
  const toolRef = useRef(tool);
  const activeLabelIdRef = useRef(activeLabelId);
  const rotatedBboxAnnotationsRef = useRef(rotatedBboxAnnotations);
  const loadErrorRef = useRef(loadError);
  const finishDrawRef = useRef<() => void>(() => undefined);
  const windowDrawEndCleanupRef = useRef<(() => void) | null>(null);
  const pointerCaptureIdRef = useRef<number | null>(null);
  const initGenRef = useRef(0);

  toolRef.current = tool;
  activeLabelIdRef.current = activeLabelId;
  rotatedBboxAnnotationsRef.current = rotatedBboxAnnotations;
  loadErrorRef.current = loadError;

  const [canvasReady, setCanvasReady] = useState(false);
  const [imageNatural, setImageNatural] = useState({ w: 0, h: 0 });

  const labelResolver = useCallback(
    (labelId: string | null) => {
      if (!labelId || !activeProject) return null;
      const lab = activeProject.labels.find((l) => l.id === labelId);
      return lab ? { name: lab.name, color: lab.color } : null;
    },
    [activeProject],
  );
  const labelResolverRef = useRef(labelResolver);
  labelResolverRef.current = labelResolver;

  const applyCanvasLayout = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    const nw = naturalSizeRef.current.width;
    const nh = naturalSizeRef.current.height;
    if (nw <= 0 || nh <= 0) return;

    const animator = zoomAnimatorRef.current;
    const zDisplay = animator?.getDisplayZoom() ?? viewZoomRef.current;
    const zLayout = animator?.getTargetZoom() ?? viewZoomRef.current;
    const { maxX, maxY } = getSceneExtents(
      nw,
      nh,
      rotatedBboxAnnotationsRef.current,
    );
    const contentW = VIEWPORT_EDGE_PAD * 2 + maxX * zLayout;
    const contentH = VIEWPORT_EDGE_PAD * 2 + maxY * zLayout;
    const { width: cw, height: ch } = resolveContentCanvasSize(
      contentW,
      contentH,
    );

    const dimsChanged = applyCanvasDimensions(canvas, cw, ch);
    const vptChanged = applyViewportTransform(canvas, zDisplay);
    if (dimsChanged || vptChanged) {
      canvas.requestRenderAll();
    }
  }, []);

  const setViewZoomTarget = useCallback((targetZ: number, animate = true) => {
    viewZoomRef.current = targetZ;
    zoomAnimatorRef.current?.setTargetZoom(targetZ, { animate });
  }, []);

  const fitImageToView = useCallback(
    (animate = true) => {
      const canvas = fabricRef.current;
      const scroll = scrollRef.current;
      if (!canvas || !scroll) return;

      const runPass = (withAnim: boolean) => {
        const nw = naturalSizeRef.current.width;
        const nh = naturalSizeRef.current.height;
        if (nw <= 0 || nh <= 0) return;

        const vw = Math.max(scroll.clientWidth || 0, 1);
        const vh = Math.max(scroll.clientHeight || 0, 1);
        const { maxX, maxY } = getSceneExtents(
          nw,
          nh,
          rotatedBboxAnnotationsRef.current,
        );
        const availW = Math.max(vw - 2 * VIEWPORT_EDGE_PAD - 4, 1);
        const availH = Math.max(vh - 2 * VIEWPORT_EDGE_PAD - 4, 1);
        const fitZ = Math.min(availW / maxX, availH / maxY, 1);
        setViewZoomTarget(Math.max(fitZ, 0.02), withAnim);
      };

      if (!animate) {
        runPass(false);
        requestAnimationFrame(() => runPass(false));
        return;
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => runPass(true));
      });
    },
    [setViewZoomTarget],
  );

  const zoomIn = useCallback(() => {
    if (
      naturalSizeRef.current.width <= 0 ||
      naturalSizeRef.current.height <= 0
    ) {
      return;
    }
    setViewZoomTarget(
      Math.min(viewZoomRef.current * ZOOM_STEP, ZOOM_MAX),
      true,
    );
  }, [setViewZoomTarget]);

  const zoomOut = useCallback(() => {
    if (
      naturalSizeRef.current.width <= 0 ||
      naturalSizeRef.current.height <= 0
    ) {
      return;
    }
    setViewZoomTarget(
      Math.max(viewZoomRef.current / ZOOM_STEP, ZOOM_MIN),
      true,
    );
  }, [setViewZoomTarget]);

  const clearWindowDrawEndListeners = useCallback(() => {
    windowDrawEndCleanupRef.current?.();
    windowDrawEndCleanupRef.current = null;
  }, []);

  const updateDrawDraft = useCallback((sceneX: number, sceneY: number) => {
    const canvas = fabricRef.current;
    if (
      !canvas ||
      !isPointerDownRef.current ||
      toolRef.current !== 'draw' ||
      !drawingRectRef.current ||
      !startPtRef.current
    ) {
      return;
    }

    const x = Math.min(sceneX, startPtRef.current.x);
    const y = Math.min(sceneY, startPtRef.current.y);
    const w = Math.abs(sceneX - startPtRef.current.x);
    const h = Math.abs(sceneY - startPtRef.current.y);
    drawingRectRef.current.set({
      left: x,
      top: y,
      width: w,
      height: h,
      scaleX: 1,
      scaleY: 1,
    });
    drawingRectRef.current.setCoords();
    canvas.requestRenderAll();
  }, []);

  const bindWindowDrawEndListeners = useCallback(() => {
    clearWindowDrawEndListeners();

    const onWindowMove = (e: PointerEvent | MouseEvent) => {
      const canvas = fabricRef.current;
      if (!canvas || !isPointerDownRef.current) return;
      const pt = canvas.getScenePoint(e);
      updateDrawDraft(pt.x, pt.y);
    };

    const onWindowUp = () => {
      const upper = fabricRef.current?.upperCanvasEl;
      const ptrId = pointerCaptureIdRef.current;
      if (upper && ptrId !== null) {
        try {
          if (upper.hasPointerCapture(ptrId))
            upper.releasePointerCapture(ptrId);
        } catch {
          /* ignore */
        }
        pointerCaptureIdRef.current = null;
      }
      finishDrawRef.current();
      clearWindowDrawEndListeners();
    };

    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('mouseup', onWindowUp);
    windowDrawEndCleanupRef.current = () => {
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('mouseup', onWindowUp);
    };
  }, [clearWindowDrawEndListeners, updateDrawDraft]);

  const cancelDrawingPreview = useCallback(() => {
    const canvas = fabricRef.current;
    if (canvas && drawingRectRef.current) {
      canvas.remove(drawingRectRef.current);
      canvas.requestRenderAll();
    }
    drawingRectRef.current = null;
    isPointerDownRef.current = false;
    startPtRef.current = null;
    clearWindowDrawEndListeners();
  }, [clearWindowDrawEndListeners]);

  const disposeCanvas = useCallback(() => {
    zoomAnimatorRef.current?.cancel();
    zoomAnimatorRef.current = null;
    prevBoxIdsRef.current = new Set();
    const canvas = fabricRef.current;
    if (canvas) {
      canvas.dispose();
      fabricRef.current = null;
    }
    setCanvasReady(false);
    cancelDrawingPreview();
  }, [cancelDrawingPreview]);

  const loadBackgroundImage = useCallback(
    async (canvas: Canvas) => {
      if (!imageUrl) return;

      const existing = canvas
        .getObjects()
        .find(
          (o) => (o as FabricObject & { name?: string }).name === BG_IMAGE_NAME,
        );
      if (existing) canvas.remove(existing);

      const img = await FabricImage.fromURL(imageUrl, {
        crossOrigin: 'anonymous',
      });
      img.set({
        left: 0,
        top: 0,
        originX: 'left',
        originY: 'top',
        selectable: false,
        evented: false,
        hasBorders: false,
      });
      (img as FabricImage & { name?: string }).name = BG_IMAGE_NAME;
      canvas.add(img);
      canvas.sendObjectToBack(img);
      img.setCoords();

      const br = img.getBoundingRect();
      naturalSizeRef.current = { width: br.width, height: br.height };
      setImageNatural({ w: br.width, h: br.height });
      reportImageNaturalSize(br.width, br.height);
    },
    [imageUrl, reportImageNaturalSize],
  );

  const initCanvas = useCallback(async () => {
    const gen = ++initGenRef.current;
    const el = canvasElRef.current;
    const scroll = scrollRef.current;
    if (!el || !scroll) {
      showToast('画布容器未就绪，请稍后重试', { type: 'error' });
      return;
    }

    disposeCanvas();
    if (gen !== initGenRef.current) return;

    viewZoomRef.current = 1;
    setImageNatural({ w: 0, h: 0 });

    const canvas = new Canvas(el, {
      width: MIN_CANVAS_PX,
      height: MIN_CANVAS_PX,
      selection: false,
    });
    fabricRef.current = canvas;
    zoomAnimatorRef.current = createViewportZoomAnimator(1, () => {
      applyCanvasLayout();
    });
    prevBoxIdsRef.current = new Set();

    try {
      await loadBackgroundImage(canvas);
      if (gen !== initGenRef.current) return;

      syncingToFabricRef.current = true;
      syncRotatedBoxesFromAnnotations(
        canvas,
        rotatedBboxAnnotationsRef.current,
        labelResolverRef.current,
        naturalSizeRef.current.width,
        naturalSizeRef.current.height,
        toolRef.current,
      );
      syncingToFabricRef.current = false;
      syncRotatedBoxInteraction(canvas, toolRef.current);
      fitImageToView(false);
      if (gen !== initGenRef.current) return;
      setCanvasReady(true);
    } catch {
      if (gen === initGenRef.current) {
        showToast('无法加载图片到标注画布', { type: 'error' });
      }
    }
  }, [
    applyCanvasLayout,
    disposeCanvas,
    fitImageToView,
    loadBackgroundImage,
    showToast,
  ]);

  useEffect(() => {
    if (!imageUrl) return undefined;
    void initCanvas();

    return () => {
      initGenRef.current += 1;
      disposeCanvas();
    };
  }, [imageUrl, initCanvas, disposeCanvas]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !canvasReady) return undefined;

    const ro = createResizeObserver(() => {
      if (!fabricRef.current) return;
      applyCanvasLayout();
    });
    if (ro) ro.observe(scroll);

    return () => ro?.disconnect();
  }, [canvasReady, applyCanvasLayout]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady || syncingToFabricRef.current) return;

    const fadeIds = new Set<string>();
    if (prevBoxIdsRef.current.size > 0) {
      rotatedBboxAnnotations.forEach((ann) => {
        if (!prevBoxIdsRef.current.has(ann.id)) fadeIds.add(ann.id);
      });
    }
    prevBoxIdsRef.current = new Set(
      rotatedBboxAnnotations.map((ann) => ann.id),
    );

    syncingToFabricRef.current = true;
    syncRotatedBoxesFromAnnotations(
      canvas,
      rotatedBboxAnnotations,
      labelResolver,
      naturalSizeRef.current.width,
      naturalSizeRef.current.height,
      tool,
      fadeIds.size > 0 ? fadeIds : undefined,
    );
    syncingToFabricRef.current = false;
    syncRotatedBoxInteraction(canvas, tool);
    applyCanvasLayout();
  }, [
    rotatedBboxAnnotations,
    labelResolver,
    canvasReady,
    tool,
    applyCanvasLayout,
  ]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady) return;
    patchAnnotationRotatedBoxStyles(
      canvas,
      rotatedBboxAnnotations,
      labelResolver,
    );
  }, [
    rotatedBboxAnnotations,
    labelResolver,
    canvasReady,
    activeProject?.labels,
  ]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady) return;
    cancelDrawingPreview();
    syncRotatedBoxInteraction(canvas, tool);
    if (tool === 'draw') {
      canvas.discardActiveObject();
      canvas.requestRenderAll();
    }
  }, [tool, canvasReady, cancelDrawingPreview]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady || syncingFromFabricRef.current) return;
    if (tool !== 'select') return;

    if (!selectedAnnotationId) {
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      return;
    }

    const obj = findAnnotationRotatedBoxById(canvas, selectedAnnotationId);
    if (obj) {
      canvas.setActiveObject(obj);
      canvas.requestRenderAll();
    }
  }, [selectedAnnotationId, tool, canvasReady]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady) return undefined;

    const setCanvasCursor = (cursor: string) => {
      canvas.setCursor(cursor);
      const upper = canvas.upperCanvasEl;
      if (upper) upper.style.cursor = cursor;
    };

    const restoreSelectCursor = () => {
      if (toolRef.current !== 'select') return;
      setCanvasCursor(canvas.defaultCursor || 'default');
    };

    const onModified = (opt: { target?: FabricObject }) => {
      const { target } = opt;
      if (
        !target ||
        syncingToFabricRef.current ||
        !isAnnotationRotatedBoxObject(target)
      ) {
        return;
      }

      syncingFromFabricRef.current = true;
      const boxId = (target as { _boxId?: string })._boxId;
      if (!boxId) {
        syncingFromFabricRef.current = false;
        return;
      }

      syncLabelFromRotatedBoxRect(target as AnnotatedRotatedBoxRect);
      const norm = extractNormFromRotatedBoxRect(
        target as AnnotatedRotatedBoxRect,
        naturalSizeRef.current.width,
        naturalSizeRef.current.height,
      );
      updateRotatedBboxGeometry(boxId, norm);
      syncingFromFabricRef.current = false;
      applyCanvasLayout();
      restoreSelectCursor();
    };

    const syncLabelWhileTransform = (opt: { target?: FabricObject }) => {
      const { target } = opt;
      if (target && isAnnotationRotatedBoxObject(target)) {
        syncLabelFromRotatedBoxRect(target);
      }
    };

    const onRotating = (opt: { target?: FabricObject }) => {
      syncLabelWhileTransform(opt);
      if (opt.target && isAnnotationRotatedBoxObject(opt.target)) {
        setCanvasCursor('grabbing');
      }
    };

    const onMouseMove = (opt: { target?: FabricObject; e: TPointerEvent }) => {
      if (toolRef.current !== 'select') return;
      if (canvas._currentTransform) return;

      const { target, e } = opt;
      if (!target || !isAnnotationRotatedBoxObject(target)) return;

      const corner = target.findControl(canvas.getViewportPoint(e));
      if (corner?.key === 'mtr') {
        setCanvasCursor(ROTATED_BOX_ROTATE_CURSOR);
      }
    };

    const onSelectionChanged = () => {
      if (toolRef.current !== 'select' || syncingToFabricRef.current) return;
      const active = canvas.getActiveObject();
      if (active && isAnnotationRotatedBoxObject(active) && active._boxId) {
        selectAnnotation(active._boxId);
      }
    };

    const onSelectionCleared = () => {
      if (toolRef.current !== 'select' || syncingToFabricRef.current) return;
      selectAnnotation(null);
    };

    canvas.on('object:modified', onModified);
    canvas.on('object:moving', syncLabelWhileTransform);
    canvas.on('object:scaling', syncLabelWhileTransform);
    canvas.on('object:resizing', syncLabelWhileTransform);
    canvas.on('object:rotating', onRotating);
    canvas.on('mouse:move', onMouseMove);
    canvas.on('selection:created', onSelectionChanged);
    canvas.on('selection:updated', onSelectionChanged);
    canvas.on('selection:cleared', onSelectionCleared);

    return () => {
      canvas.off('object:modified', onModified);
      canvas.off('object:moving', syncLabelWhileTransform);
      canvas.off('object:scaling', syncLabelWhileTransform);
      canvas.off('object:resizing', syncLabelWhileTransform);
      canvas.off('object:rotating', onRotating);
      canvas.off('mouse:move', onMouseMove);
      canvas.off('selection:created', onSelectionChanged);
      canvas.off('selection:updated', onSelectionChanged);
      canvas.off('selection:cleared', onSelectionCleared);
    };
  }, [
    canvasReady,
    selectAnnotation,
    updateRotatedBboxGeometry,
    applyCanvasLayout,
  ]);

  const finishDraw = useCallback(() => {
    const canvas = fabricRef.current;
    if (
      !canvas ||
      !isPointerDownRef.current ||
      toolRef.current !== 'draw' ||
      !drawingRectRef.current
    ) {
      return;
    }

    isPointerDownRef.current = false;
    clearWindowDrawEndListeners();

    const r = drawingRectRef.current;
    drawingRectRef.current = null;

    const w = (r.width ?? 0) * (r.scaleX ?? 1);
    const h = (r.height ?? 0) * (r.scaleY ?? 1);

    const removeDraft = () => {
      if (canvas.getObjects().includes(r)) {
        canvas.remove(r);
        canvas.requestRenderAll();
      }
    };

    if (isBoxTooSmall(w, h)) {
      removeDraft();
      showToast('框太小，请拖大一点再松手', { type: 'info' });
      return;
    }

    if (!activeLabelIdRef.current) {
      removeDraft();
      showToast('请先在工具栏选择绘制用标签', { type: 'info' });
      return;
    }

    const nw = naturalSizeRef.current.width;
    const nh = naturalSizeRef.current.height;
    if (nw <= 0 || nh <= 0) {
      removeDraft();
      showToast('图片尺寸尚未就绪，请稍后再试', { type: 'error' });
      return;
    }

    const norm = sceneRectToRotatedNorm(
      {
        left: r.left ?? 0,
        top: r.top ?? 0,
        width: w,
        height: h,
      },
      nw,
      nh,
    );

    syncingToFabricRef.current = true;
    const added = addRotatedBboxAnnotation(norm);
    syncingToFabricRef.current = false;

    if (!added) {
      const err = loadErrorRef.current;
      showToast(
        err ? `无法保存标注：${err}` : '标注数据尚未加载完成，请稍后再试',
        { type: 'error' },
      );
      return;
    }

    removeDraft();
    selectAnnotation(null);
    applyCanvasLayout();
  }, [
    addRotatedBboxAnnotation,
    selectAnnotation,
    showToast,
    applyCanvasLayout,
    clearWindowDrawEndListeners,
  ]);

  finishDrawRef.current = finishDraw;

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (ev.key === 'b' || ev.key === 'B') {
        setTool('draw');
        ev.preventDefault();
      }
      if (ev.key === 'v' || ev.key === 'V') {
        setTool('select');
        ev.preventDefault();
      }
      if (ev.key === '+' || ev.key === '=') {
        zoomIn();
        ev.preventDefault();
      }
      if (ev.key === '-') {
        zoomOut();
        ev.preventDefault();
      }
      if (ev.key === '0') {
        fitImageToView();
        ev.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setTool, zoomIn, zoomOut, fitImageToView]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady) return undefined;

    const upper = canvas.upperCanvasEl;
    if (!upper) return undefined;

    const tryBeginDraw = (e: PointerEvent | MouseEvent) => {
      if (toolRef.current !== 'draw') return;
      if (e.button !== 0) return;

      const scenePt = canvas.getScenePoint(e);
      const hit = hitTopAnnotationRotatedBoxAtScenePoint(canvas, scenePt);
      if (hit) {
        showToast('此处已有标注框，请点空白区域绘制', { type: 'info' });
        return;
      }

      if (!activeLabelIdRef.current) {
        showToast('请先在工具栏选择绘制用标签', { type: 'info' });
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (drawingRectRef.current) {
        canvas.remove(drawingRectRef.current);
        drawingRectRef.current = null;
      }
      clearWindowDrawEndListeners();

      isPointerDownRef.current = true;
      startPtRef.current = { x: scenePt.x, y: scenePt.y };

      const activeLabel = labelResolverRef.current(activeLabelIdRef.current);
      const color = activeLabel?.color ?? BBOX_THEME.defaultLabelColor;

      const draft = new Rect({
        left: scenePt.x,
        top: scenePt.y,
        width: 0,
        height: 0,
        ...getRotatedDraftRectStyle(color),
      });
      drawingRectRef.current = draft;
      canvas.add(draft);
      canvas.bringObjectToFront(draft);
      canvas.requestRenderAll();
      bindWindowDrawEndListeners();

      if ('pointerId' in e && upper.setPointerCapture) {
        try {
          upper.setPointerCapture(e.pointerId);
          pointerCaptureIdRef.current = e.pointerId;
        } catch {
          pointerCaptureIdRef.current = null;
        }
      }
    };

    const onPointerDown = (e: PointerEvent) => tryBeginDraw(e);
    const onMouseDown = (e: MouseEvent) => tryBeginDraw(e);

    upper.addEventListener('pointerdown', onPointerDown, true);
    upper.addEventListener('mousedown', onMouseDown, true);

    return () => {
      upper.removeEventListener('pointerdown', onPointerDown, true);
      upper.removeEventListener('mousedown', onMouseDown, true);
      cancelDrawingPreview();
    };
  }, [
    canvasReady,
    cancelDrawingPreview,
    showToast,
    bindWindowDrawEndListeners,
  ]);

  return (
    <div className="image-fabric-editor">
      <ImageAnnotationToolbar
        mode="rotated_bbox"
        imagePath={imagePath}
        canvasReady={canvasReady}
        imageNatural={imageNatural}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomFit={fitImageToView}
      />
      {loadError ? (
        <div className="image-fabric-load-error" role="alert">
          标注加载失败：{loadError}（画框将无法保存）
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className={`image-fabric-canvas-scroll image-fabric-canvas-scroll--${tool}`}
      >
        <div className="image-fabric-canvas-inner">
          <canvas ref={canvasElRef} />
        </div>
      </div>
    </div>
  );
}
