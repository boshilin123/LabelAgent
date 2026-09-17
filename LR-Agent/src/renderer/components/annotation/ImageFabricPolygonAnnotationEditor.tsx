import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, FabricImage, type FabricObject } from 'fabric';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { useToast } from '../../context/ToastContext';
import type { PolygonAnnotation } from '../../types/annotationDocument';
import { BBOX_THEME } from './annotationBboxTheme';
import { VIEWPORT_EDGE_PAD } from './fabric/fabricBboxCoords';
import { normToScenePoints } from './fabric/fabricPolygonCoords';
import { BG_IMAGE_NAME } from './fabric/fabricBoxObjects';
import {
  patchAnnotationPolygonStyles,
  syncPolygonInteraction,
  syncPolygonsFromAnnotations,
} from './fabric/fabricPolygonCanvasSync';
import { PolygonCanvasInteraction } from './fabric/fabricPolygonInteraction';
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
import { runSam2PreAnnot } from './PreAnnotToolbarSection';
import {
  bindPreAnnotBoxDraw,
  isPreAnnotBoxTool,
} from './fabric/fabricPreAnnotBoxDraw';
import { usePretrainedModels } from '../../context/PretrainedModelsContext';
import {
  loadSavedPreAnnotModelId,
  pickDefaultPreAnnotModel,
  getEligiblePreAnnotModels,
} from '../../utils/preAnnotModelFilter';
import './ImageFabricAnnotationEditor.css';

interface ImageFabricPolygonAnnotationEditorProps {
  imageUrl: string;
  imagePath: string;
}

const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;

function getSceneExtents(
  naturalWidth: number,
  naturalHeight: number,
  annotations: PolygonAnnotation[],
) {
  let maxX = naturalWidth || 0;
  let maxY = naturalHeight || 0;
  annotations.forEach((ann) => {
    const pts = normToScenePoints(ann, naturalWidth, naturalHeight);
    pts.forEach((pt) => {
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    });
  });
  return { maxX: Math.max(maxX, 1), maxY: Math.max(maxY, 1) };
}

export default function ImageFabricPolygonAnnotationEditor({
  imageUrl,
  imagePath,
}: ImageFabricPolygonAnnotationEditorProps) {
  const { activeProject } = useAnnotation();
  const { showToast } = useToast();
  const { models } = usePretrainedModels();
  const {
    polygonAnnotations,
    selectedAnnotationId,
    selectAnnotation,
    activeLabelId,
    tool,
    setTool,
    addPolygonAnnotation,
    addPreAnnotPolygon,
    updatePolygonGeometry,
    deleteAnnotation,
    reportImageNaturalSize,
    loadError,
    setLocalUndoHandler,
  } = useAnnotationWorkspace();

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const naturalSizeRef = useRef({ width: 0, height: 0 });
  const viewZoomRef = useRef(1);
  const zoomAnimatorRef = useRef<ViewportZoomAnimator | null>(null);
  const prevPolyIdsRef = useRef<Set<string>>(new Set());
  const syncingToFabricRef = useRef(false);
  const polygonInteractionRef = useRef<PolygonCanvasInteraction | null>(null);
  const unbindInteractionRef = useRef<(() => void) | null>(null);
  const toolRef = useRef(tool);
  const activeLabelIdRef = useRef(activeLabelId);
  const polygonAnnotationsRef = useRef(polygonAnnotations);
  const selectedIdRef = useRef(selectedAnnotationId);
  const loadErrorRef = useRef(loadError);
  const initGenRef = useRef(0);
  /** Skip full polygon resync when geometry was just committed from canvas (Fabric is source of truth) */
  const skipCanvasGeometrySyncRef = useRef(false);

  toolRef.current = tool;
  activeLabelIdRef.current = activeLabelId;
  polygonAnnotationsRef.current = polygonAnnotations;
  selectedIdRef.current = selectedAnnotationId;
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
      polygonAnnotationsRef.current,
    );
    const contentW = VIEWPORT_EDGE_PAD * 2 + maxX * zLayout;
    const contentH = VIEWPORT_EDGE_PAD * 2 + maxY * zLayout;
    const { width: cw, height: ch } = resolveContentCanvasSize(
      contentW,
      contentH,
    );

    const dimsChanged = applyCanvasDimensions(canvas, cw, ch);
    const vptChanged = applyViewportTransform(canvas, zDisplay);
    if (dimsChanged || vptChanged) canvas.requestRenderAll();
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
          polygonAnnotationsRef.current,
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
    if (naturalSizeRef.current.width <= 0) return;
    setViewZoomTarget(
      Math.min(viewZoomRef.current * ZOOM_STEP, ZOOM_MAX),
      true,
    );
  }, [setViewZoomTarget]);

  const zoomOut = useCallback(() => {
    if (naturalSizeRef.current.width <= 0) return;
    setViewZoomTarget(
      Math.max(viewZoomRef.current / ZOOM_STEP, ZOOM_MIN),
      true,
    );
  }, [setViewZoomTarget]);

  const disposeCanvas = useCallback(() => {
    unbindInteractionRef.current?.();
    unbindInteractionRef.current = null;
    polygonInteractionRef.current = null;
    zoomAnimatorRef.current?.cancel();
    zoomAnimatorRef.current = null;
    prevPolyIdsRef.current = new Set();
    const canvas = fabricRef.current;
    if (canvas) {
      canvas.dispose();
      fabricRef.current = null;
    }
    setCanvasReady(false);
  }, []);

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
    prevPolyIdsRef.current = new Set();

    const interaction = new PolygonCanvasInteraction({
      getCanvas: () => fabricRef.current,
      getNaturalSize: () => naturalSizeRef.current,
      getViewZoom: () => viewZoomRef.current,
      getTool: () => toolRef.current,
      getActiveLabelColor: () => {
        const lab = labelResolverRef.current(activeLabelIdRef.current ?? '');
        return lab?.color ?? BBOX_THEME.defaultLabelColor;
      },
      getActiveLabelId: () => activeLabelIdRef.current,
      getPolygonAnnotations: () => polygonAnnotationsRef.current,
      addPolygonAnnotation,
      updatePolygonGeometry: (id, points) => {
        skipCanvasGeometrySyncRef.current = true;
        updatePolygonGeometry(id, points);
      },
      onBeforeCanvasGeometryCommit: () => {
        skipCanvasGeometrySyncRef.current = true;
      },
      deleteAnnotation,
      selectAnnotation,
      getSelectedId: () => selectedIdRef.current,
      onLayoutChange: applyCanvasLayout,
      showToast,
    });
    polygonInteractionRef.current = interaction;
    unbindInteractionRef.current = interaction.bind(canvas);

    try {
      await loadBackgroundImage(canvas);
      if (gen !== initGenRef.current) return;

      syncingToFabricRef.current = true;
      syncPolygonsFromAnnotations(
        canvas,
        polygonAnnotationsRef.current,
        labelResolverRef.current,
        naturalSizeRef.current.width,
        naturalSizeRef.current.height,
        toolRef.current,
      );
      syncingToFabricRef.current = false;
      syncPolygonInteraction(canvas, toolRef.current);
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
    addPolygonAnnotation,
    updatePolygonGeometry,
    deleteAnnotation,
    selectAnnotation,
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
      if (fabricRef.current) applyCanvasLayout();
    });
    if (ro) ro.observe(scroll);
    return () => ro?.disconnect();
  }, [canvasReady, applyCanvasLayout]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady || syncingToFabricRef.current) return;

    if (skipCanvasGeometrySyncRef.current) {
      skipCanvasGeometrySyncRef.current = false;
      patchAnnotationPolygonStyles(
        canvas,
        polygonAnnotations,
        labelResolverRef.current,
      );
      syncPolygonInteraction(canvas, tool);
      return;
    }

    const fadeIds = new Set<string>();
    if (prevPolyIdsRef.current.size > 0) {
      polygonAnnotations.forEach((ann) => {
        if (!prevPolyIdsRef.current.has(ann.id)) fadeIds.add(ann.id);
      });
    }
    prevPolyIdsRef.current = new Set(polygonAnnotations.map((a) => a.id));

    syncingToFabricRef.current = true;
    syncPolygonsFromAnnotations(
      canvas,
      polygonAnnotations,
      labelResolverRef.current,
      naturalSizeRef.current.width,
      naturalSizeRef.current.height,
      tool,
      fadeIds.size > 0 ? fadeIds : undefined,
    );
    syncingToFabricRef.current = false;
    syncPolygonInteraction(canvas, tool);
    applyCanvasLayout();
  }, [polygonAnnotations, canvasReady, tool, applyCanvasLayout]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady) return;
    patchAnnotationPolygonStyles(canvas, polygonAnnotations, labelResolver);
  }, [polygonAnnotations, labelResolver, canvasReady, activeProject?.labels]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady) return;
    polygonInteractionRef.current?.onToolChange(tool);
    syncPolygonInteraction(canvas, tool);
    if (tool === 'polygon') {
      canvas.discardActiveObject();
      polygonInteractionRef.current?.hideVertexHandles();
      canvas.requestRenderAll();
    }
  }, [tool, canvasReady]);

  useEffect(() => {
    polygonInteractionRef.current?.syncSelection(selectedAnnotationId);
  }, [selectedAnnotationId, canvasReady, tool]);

  useEffect(() => {
    if (!canvasReady) {
      setLocalUndoHandler(null);
      return undefined;
    }
    setLocalUndoHandler(
      () => polygonInteractionRef.current?.tryUndoDraftPoint() ?? false,
    );
    return () => setLocalUndoHandler(null);
  }, [canvasReady, setLocalUndoHandler]);

  const resolveSamModel = useCallback(() => {
    if (!activeProject) return null;
    const eligible = getEligiblePreAnnotModels('polygon', models);
    if (eligible.length === 0) return null;
    const saved = loadSavedPreAnnotModelId(activeProject.id);
    return (
      eligible.find((m) => m.id === saved) ??
      pickDefaultPreAnnotModel('polygon', models)
    );
  }, [activeProject, models]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady) return undefined;

    return bindPreAnnotBoxDraw(canvas, {
      getTool: () => toolRef.current,
      getNaturalSize: () => naturalSizeRef.current,
      onTooSmall: () => {
        showToast('框太小，请拖大一点再松手', { type: 'info' });
      },
      onComplete: async (box) => {
        if (toolRef.current !== 'preannot_sam_box') return;

        const model = resolveSamModel();
        if (!model) {
          showToast('未找到可用的 SAM2 模型', { type: 'info' });
          setTool('select');
          return;
        }
        if (!activeLabelIdRef.current) {
          showToast('请先选择绘制标签', { type: 'info' });
          setTool('select');
          return;
        }

        showToast('分割中…', { type: 'info' });
        try {
          const points = await runSam2PreAnnot({
            imagePath,
            model,
            box,
          });
          if (points.length < 3) {
            showToast('未生成有效多边形，请调整框选区域', { type: 'info' });
          } else {
            addPreAnnotPolygon(points);
            showToast('已添加多边形预标注', { type: 'info' });
          }
        } catch (error) {
          showToast(error instanceof Error ? error.message : 'SAM2 分割失败', {
            type: 'error',
          });
        } finally {
          setTool('select');
        }
      },
    });
  }, [
    canvasReady,
    imagePath,
    resolveSamModel,
    addPreAnnotPolygon,
    setTool,
    showToast,
  ]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (polygonInteractionRef.current?.handleKeyDown(ev)) {
        ev.preventDefault();
        return;
      }
      if (ev.key === 'p' || ev.key === 'P') {
        setTool('polygon');
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

  const scrollToolClass = isPreAnnotBoxTool(tool)
    ? 'draw'
    : tool === 'polygon'
      ? 'polygon'
      : tool === 'select'
        ? 'select'
        : 'draw';

  return (
    <div className="image-fabric-editor">
      <ImageAnnotationToolbar
        mode="polygon"
        imagePath={imagePath}
        canvasReady={canvasReady}
        imageNatural={imageNatural}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomFit={fitImageToView}
      />
      {loadError ? (
        <div className="image-fabric-load-error" role="alert">
          标注加载失败：{loadError}（多边形将无法保存）
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className={`image-fabric-canvas-scroll image-fabric-canvas-scroll--${scrollToolClass}`}
      >
        <div className="image-fabric-canvas-inner">
          <canvas ref={canvasElRef} />
        </div>
      </div>
    </div>
  );
}
