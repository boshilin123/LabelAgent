import type { Canvas } from 'fabric';
import { VIEWPORT_EDGE_PAD } from './fabricBboxCoords';

const ZOOM_ANIM_MS = 150;

/** Minimum Fabric backing-store size (px). */
export const MIN_CANVAS_PX = 2;

/** Canvas pixel size from scene content only (not the scroll viewport). */
export function resolveContentCanvasSize(
  contentW: number,
  contentH: number,
): { width: number; height: number } {
  return {
    width: Math.max(MIN_CANVAS_PX, Math.ceil(contentW)),
    height: Math.max(MIN_CANVAS_PX, Math.ceil(contentH)),
  };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export interface ViewportZoomAnimator {
  /** Current zoom used for viewport transform (may be mid-lerp). */
  getDisplayZoom: () => number;
  /** Target zoom for layout math. */
  getTargetZoom: () => number;
  setTargetZoom: (z: number, opts?: { animate?: boolean }) => void;
  cancel: () => void;
}

export function createViewportZoomAnimator(
  initialZoom: number,
  onDisplayZoomChange: () => void,
): ViewportZoomAnimator {
  let targetZoom = initialZoom;
  let displayZoom = initialZoom;
  let rafId: number | null = null;
  let animStart = 0;
  let animFrom = initialZoom;

  const cancel = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  const tick = (now: number) => {
    if (animStart === 0) animStart = now;
    const t = Math.min(1, (now - animStart) / ZOOM_ANIM_MS);
    displayZoom = animFrom + (targetZoom - animFrom) * easeOutCubic(t);
    onDisplayZoomChange();
    if (t < 1) {
      rafId = requestAnimationFrame(tick);
    } else {
      displayZoom = targetZoom;
      rafId = null;
      onDisplayZoomChange();
    }
  };

  const setTargetZoom = (z: number, opts?: { animate?: boolean }) => {
    targetZoom = z;
    if (opts?.animate === false) {
      cancel();
      displayZoom = z;
      animFrom = z;
      onDisplayZoomChange();
      return;
    }
    animFrom = displayZoom;
    animStart = 0;
    cancel();
    rafId = requestAnimationFrame(tick);
  };

  return {
    getDisplayZoom: () => displayZoom,
    getTargetZoom: () => targetZoom,
    setTargetZoom,
    cancel,
  };
}

/** Resize backing store only when width/height actually change. */
export function applyCanvasDimensions(
  canvas: Canvas,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (canvas.width === canvasWidth && canvas.height === canvasHeight) {
    return false;
  }
  canvas.setDimensions({ width: canvasWidth, height: canvasHeight });
  return true;
}

/** Update viewport scale (cheap; safe to call every animation frame). */
export function applyViewportTransform(
  canvas: Canvas,
  displayZoom: number,
): boolean {
  const vpt = canvas.viewportTransform;
  if (
    vpt[0] === displayZoom &&
    vpt[3] === displayZoom &&
    vpt[4] === VIEWPORT_EDGE_PAD &&
    vpt[5] === VIEWPORT_EDGE_PAD
  ) {
    return false;
  }
  canvas.setViewportTransform([
    displayZoom,
    0,
    0,
    displayZoom,
    VIEWPORT_EDGE_PAD,
    VIEWPORT_EDGE_PAD,
  ]);
  return true;
}
