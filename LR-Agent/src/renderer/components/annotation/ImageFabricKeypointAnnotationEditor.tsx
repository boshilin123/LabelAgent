import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, FabricImage, type FabricObject } from 'fabric';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { useToast } from '../../context/ToastContext';
import type { PoseAnnotation } from '../../types/annotationDocument';
import { BBOX_THEME } from './annotationBboxTheme';
import { VIEWPORT_EDGE_PAD } from './fabric/fabricBboxCoords';
import { BG_IMAGE_NAME } from './fabric/fabricBoxObjects';
import { poseAnnToSceneGeometry } from './fabric/fabricKeypointCoords';
import {
  syncKeypointInteraction,
  syncPointsFromAnnotations,
  syncPosesFromAnnotations,
} from './fabric/fabricKeypointCanvasSync';
import { KeypointCanvasInteraction } from './fabric/fabricKeypointInteraction';
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
import { runKeypointRoiPreAnnot } from './PreAnnotToolbarSection';
import {
  bindPreAnnotBoxDraw,
  isPreAnnotBoxTool,
} from './fabric/fabricPreAnnotBoxDraw';
import { usePretrainedModels } from '../../context/PretrainedModelsContext';
import {
  getEligiblePreAnnotModels,
  loadSavedPreAnnotModelId,
  pickDefaultPreAnnotModel,
} from '../../utils/preAnnotModelFilter';
import { resolveLabelIdForPoseTemplate } from '../../utils/preAnnotLabelMapping';
import './ImageFabricAnnotationEditor.css';

interface ImageFabricKeypointAnnotationEditorProps {
  imageUrl: string;
  imagePath: string;
}

const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;

function getSceneExtents(
  naturalWidth: number,
  naturalHeight: number,
  poseAnnotations: PoseAnnotation[],
) {
  let maxX = naturalWidth || 0;
  let maxY = naturalHeight || 0;
  poseAnnotations.forEach((ann) => {
    const scene = poseAnnToSceneGeometry(ann, naturalWidth, naturalHeight);
    maxX = Math.max(maxX, scene.cx + scene.width / 2);
    maxY = Math.max(maxY, scene.cy + scene.height / 2);
    scene.keypoints.forEach((kp) => {
      maxX = Math.max(maxX, kp.x);
      maxY = Math.max(maxY, kp.y);
    });
  });
  return { maxX: Math.max(maxX, 1), maxY: Math.max(maxY, 1) };
}

export default function ImageFabricKeypointAnnotationEditor({
  imageUrl,
  imagePath,
}: ImageFabricKeypointAnnotationEditorProps) {
  const { activeProject } = useAnnotation();
  const { showToast } = useToast();
  const { models } = usePretrainedModels();
  const {
    poseAnnotations,
    pointAnnotations,
    selectedAnnotationId,
    selectAnnotation,
    tool,
    setTool,
    activeTemplate,
    activeTemplateId,
    addPoseAnnotation,
    addPointAnnotation,
    addPreAnnotPoses,
    updatePoseGeometry,
    updatePointGeometry,
    updateKeypointVisibility,
    deleteAnnotation,
    reportImageNaturalSize,
    loadError,
  } = useAnnotationWorkspace();

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const naturalSizeRef = useRef({ width: 0, height: 0 });
  const viewZoomRef = useRef(1);
  const zoomAnimatorRef = useRef<ViewportZoomAnimator | null>(null);
  const syncingToFabricRef = useRef(false);
  const skipCanvasGeometrySyncRef = useRef(false);
  const keypointInteractionRef = useRef<KeypointCanvasInteraction | null>(null);
  const unbindInteractionRef = useRef<(() => void) | null>(null);
  const toolRef = useRef(tool);
  const activeTemplateRef = useRef(activeTemplate);
  const poseAnnotationsRef = useRef(poseAnnotations);
  const pointAnnotationsRef = useRef(pointAnnotations);
  const selectedIdRef = useRef(selectedAnnotationId);
  const loadErrorRef = useRef(loadError);
  const initGenRef = useRef(0);

  toolRef.current = tool;
  activeTemplateRef.current = activeTemplate;
  poseAnnotationsRef.current = poseAnnotations;
  pointAnnotationsRef.current = pointAnnotations;
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
    const { maxX, maxY } = getSceneExtents(nw, nh, poseAnnotationsRef.current);
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
          poseAnnotationsRef.current,
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
    keypointInteractionRef.current = null;
    zoomAnimatorRef.current?.cancel();
    zoomAnimatorRef.current = null;
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

  const syncAllToCanvas = useCallback((canvas: Canvas) => {
    const nw = naturalSizeRef.current.width;
    const nh = naturalSizeRef.current.height;
    syncPosesFromAnnotations(
      canvas,
      poseAnnotationsRef.current,
      labelResolverRef.current,
      nw,
      nh,
      toolRef.current,
      selectedIdRef.current,
    );
    syncPointsFromAnnotations(
      canvas,
      pointAnnotationsRef.current,
      labelResolverRef.current,
      nw,
      nh,
      toolRef.current,
    );
  }, []);

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

    const interaction = new KeypointCanvasInteraction({
      getCanvas: () => fabricRef.current,
      getNaturalSize: () => naturalSizeRef.current,
      getViewZoom: () => viewZoomRef.current,
      getTool: () => toolRef.current,
      getActiveTemplate: () => activeTemplateRef.current,
      getProjectLabels: () => activeProject?.labels ?? [],
      getPoseAnnotations: () => poseAnnotationsRef.current,
      getPointAnnotations: () => pointAnnotationsRef.current,
      addPoseAnnotation: (templateId, centerScene) => {
        const { width, height } = naturalSizeRef.current;
        return addPoseAnnotation(templateId, centerScene, width, height);
      },
      addPointAnnotation: (scene, labelId) => {
        const { width, height } = naturalSizeRef.current;
        const nx = width > 0 ? scene.x / width : 0;
        const ny = height > 0 ? scene.y / height : 0;
        return addPointAnnotation(nx, ny, labelId);
      },
      updatePoseGeometry: (id, ann) => {
        skipCanvasGeometrySyncRef.current = true;
        updatePoseGeometry(id, ann);
      },
      updatePointGeometry: (id, x, y) => {
        skipCanvasGeometrySyncRef.current = true;
        updatePointGeometry(id, x, y);
      },
      updateKeypointVisibility,
      onBeforeCanvasGeometryCommit: () => {
        skipCanvasGeometrySyncRef.current = true;
      },
      deleteAnnotation,
      selectAnnotation,
      getSelectedId: () => selectedIdRef.current,
      onLayoutChange: applyCanvasLayout,
      showToast,
    });
    keypointInteractionRef.current = interaction;
    unbindInteractionRef.current = interaction.bind(canvas);

    try {
      await loadBackgroundImage(canvas);
      if (gen !== initGenRef.current) return;

      syncingToFabricRef.current = true;
      syncAllToCanvas(canvas);
      syncingToFabricRef.current = false;
      syncKeypointInteraction(canvas, toolRef.current, selectedIdRef.current);
      fitImageToView(false);
      if (gen !== initGenRef.current) return;
      setCanvasReady(true);
    } catch {
      if (gen === initGenRef.current) {
        showToast('无法加载图片到标注画布', { type: 'error' });
      }
    }
  }, [
    activeProject?.labels,
    applyCanvasLayout,
    disposeCanvas,
    fitImageToView,
    loadBackgroundImage,
    addPoseAnnotation,
    addPointAnnotation,
    updatePoseGeometry,
    updatePointGeometry,
    updateKeypointVisibility,
    deleteAnnotation,
    selectAnnotation,
    showToast,
    syncAllToCanvas,
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
      syncKeypointInteraction(canvas, tool, selectedAnnotationId);
      return;
    }

    syncingToFabricRef.current = true;
    syncAllToCanvas(canvas);
    syncingToFabricRef.current = false;
    syncKeypointInteraction(canvas, tool, selectedAnnotationId);
    applyCanvasLayout();
  }, [
    poseAnnotations,
    pointAnnotations,
    canvasReady,
    tool,
    selectedAnnotationId,
    activeTemplateId,
    applyCanvasLayout,
    syncAllToCanvas,
  ]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !canvasReady) return;
    syncKeypointInteraction(canvas, tool, selectedAnnotationId);
  }, [tool, selectedAnnotationId, canvasReady]);

  const resolveKeypointModel = useCallback(() => {
    if (!activeProject) return null;
    const eligible = getEligiblePreAnnotModels(
      'keypoint',
      models,
      activeTemplateId,
    );
    if (eligible.length === 0) return null;
    const saved = loadSavedPreAnnotModelId(activeProject.id);
    return (
      eligible.find((m) => m.id === saved) ??
      pickDefaultPreAnnotModel('keypoint', models, activeTemplateId)
    );
  }, [activeProject, models, activeTemplateId]);

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
        if (toolRef.current !== 'preannot_roi_box') return;

        const model = resolveKeypointModel();
        if (!model) {
          showToast('未找到可用的关键点模型', { type: 'info' });
          setTool('select');
          return;
        }

        const labels = activeProject?.labels ?? [];
        const labelId = resolveLabelIdForPoseTemplate(activeTemplate, labels);
        if (!labelId) {
          showToast(`请先在项目中添加标签「${activeTemplate.defaultLabel}」`, {
            type: 'info',
          });
          setTool('select');
          return;
        }

        showToast('检测中…', { type: 'info' });
        try {
          const poses = await runKeypointRoiPreAnnot({
            imagePath,
            model,
            templateId: activeTemplateId,
            box,
          });
          const items = poses.map((pose) => ({
            labelId,
            templateId: pose.templateId || activeTemplateId,
            cx: pose.cx,
            cy: pose.cy,
            width: pose.width,
            height: pose.height,
            angle: pose.angle,
            keypoints: pose.keypoints,
          }));
          const count = addPreAnnotPoses(items);
          showToast(
            count > 0
              ? `已生成 ${count} 条骨架预标注`
              : '框选区域内未检测到实例',
            { type: 'info' },
          );
        } catch (error) {
          showToast(error instanceof Error ? error.message : '关键点检测失败', {
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
    activeProject,
    activeTemplate,
    activeTemplateId,
    resolveKeypointModel,
    addPreAnnotPoses,
    setTool,
    showToast,
  ]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (ev.key === 'p' || ev.key === 'P') {
        setTool('place_pose');
        ev.preventDefault();
      }
      if (ev.key === 'd' || ev.key === 'D') {
        setTool('place_point');
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

  const scrollToolClass =
    tool === 'place_pose' || tool === 'place_point'
      ? 'polygon'
      : isPreAnnotBoxTool(tool)
        ? 'draw'
        : tool === 'select'
          ? 'select'
          : 'draw';

  return (
    <div className="image-fabric-editor">
      <ImageAnnotationToolbar
        mode="keypoint"
        imagePath={imagePath}
        canvasReady={canvasReady}
        imageNatural={imageNatural}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomFit={fitImageToView}
      />
      {loadError ? (
        <div className="image-fabric-load-error" role="alert">
          标注加载失败：{loadError}（关键点将无法保存）
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
