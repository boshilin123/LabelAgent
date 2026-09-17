import { useLayoutEffect, useRef } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import {
  useAnnotationWorkspace,
  type ImageCanvasTool,
} from '../../context/AnnotationWorkspaceContext';
import { createResizeObserver } from '../../utils/resizeObserver';
import AnnotationDrawLabelPicker from './AnnotationDrawLabelPicker';
import KeypointTemplateSelector from './KeypointTemplateSelector';
import PreAnnotToolbarSection from './PreAnnotToolbarSection';
import './ImageAnnotationToolbar.css';

export interface ImageAnnotationToolbarProps {
  mode?:
    | 'bbox'
    | 'rotated_bbox'
    | 'polygon'
    | 'keypoint'
    | 'caption'
    | 'classification';
  imagePath?: string;
  canvasReady?: boolean;
  imageNatural?: { w: number; h: number };
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomFit?: () => void;
}

export default function ImageAnnotationToolbar({
  mode = 'bbox',
  imagePath = '',
  canvasReady = false,
  imageNatural = { w: 0, h: 0 },
  onZoomIn,
  onZoomOut,
  onZoomFit,
}: ImageAnnotationToolbarProps) {
  const { activeProject } = useAnnotation();
  const { tool, setTool, activeLabelId, setActiveLabelId, labelUsage } =
    useAnnotationWorkspace();
  const toolbarRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;

    const layout = el.closest<HTMLElement>('.layout');
    if (!layout) return;

    const syncHeight = () => {
      layout.style.setProperty(
        '--image-annotation-toolbar-height',
        `${el.offsetHeight}px`,
      );
    };

    syncHeight();
    const observer = createResizeObserver(syncHeight);
    observer?.observe(el);

    return () => {
      observer?.disconnect();
      layout.style.removeProperty('--image-annotation-toolbar-height');
    };
  }, [activeProject?.id, mode, imagePath, activeProject?.labels.length]);

  if (!activeProject) return null;

  const zoomDisabled =
    !canvasReady || imageNatural.w <= 0 || imageNatural.h <= 0;

  const setToolAndFocus = (next: ImageCanvasTool) => {
    setTool(next);
  };

  return (
    <div ref={toolbarRef} className="image-annotation-toolbar">
      <div
        className="image-annotation-tool-group"
        role="group"
        aria-label="画布缩放"
      >
        <VscodeButton
          secondary
          iconOnly
          icon="zoom-out"
          disabled={zoomDisabled}
          title="缩小"
          aria-label="缩小"
          onClick={onZoomOut}
        />
        <VscodeButton
          secondary
          iconOnly
          icon="zoom-in"
          disabled={zoomDisabled}
          title="放大"
          aria-label="放大"
          onClick={onZoomIn}
        />
        <VscodeButton
          secondary
          iconOnly
          icon="screen-full"
          disabled={zoomDisabled}
          title="适应窗口"
          aria-label="适应窗口"
          onClick={onZoomFit}
        />
      </div>

      <div className="image-annotation-toolbar-divider" aria-hidden />

      <div
        className="image-annotation-tool-group"
        role="group"
        aria-label="画布工具"
      >
        {mode === 'keypoint' ? (
          <>
            <VscodeButton
              secondary
              icon="symbol-ruler"
              className={`image-annotation-tool-btn${tool === 'place_pose' ? ' image-annotation-tool-btn--active' : ''}`}
              aria-pressed={tool === 'place_pose'}
              onClick={() => setToolAndFocus('place_pose')}
            >
              放置骨架 (P)
            </VscodeButton>
            <VscodeButton
              secondary
              icon="circle-filled"
              className={`image-annotation-tool-btn${tool === 'place_point' ? ' image-annotation-tool-btn--active' : ''}`}
              aria-pressed={tool === 'place_point'}
              onClick={() => setToolAndFocus('place_point')}
            >
              单点 (D)
            </VscodeButton>
          </>
        ) : mode === 'bbox' || mode === 'rotated_bbox' ? (
          <VscodeButton
            secondary
            icon="selection"
            className={`image-annotation-tool-btn${tool === 'draw' ? ' image-annotation-tool-btn--active' : ''}`}
            aria-pressed={tool === 'draw'}
            onClick={() => setToolAndFocus('draw')}
          >
            {mode === 'rotated_bbox' ? '画旋转框 (B)' : '画框 (B)'}
          </VscodeButton>
        ) : mode === 'caption' || mode === 'classification' ? (
          <span className="image-annotation-toolbar-hint">
            {mode === 'caption' ? '图片内容描述' : '整图分类标签'}
          </span>
        ) : (
          <VscodeButton
            secondary
            icon="type-hierarchy"
            className={`image-annotation-tool-btn${tool === 'polygon' ? ' image-annotation-tool-btn--active' : ''}`}
            aria-pressed={tool === 'polygon'}
            onClick={() => setToolAndFocus('polygon')}
          >
            多边形 (P)
          </VscodeButton>
        )}
        {mode !== 'caption' && mode !== 'classification' && (
          <VscodeButton
            secondary
            icon="cursor"
            className={`image-annotation-tool-btn${tool === 'select' ? ' image-annotation-tool-btn--active' : ''}`}
            aria-pressed={tool === 'select'}
            onClick={() => setToolAndFocus('select')}
          >
            选择 (V)
          </VscodeButton>
        )}
      </div>
      {mode === 'caption' ? null : mode === 'keypoint' ? (
        <div className="image-annotation-toolbar-labels">
          <KeypointTemplateSelector />
        </div>
      ) : (
        <div className="image-annotation-toolbar-labels">
          {activeProject.labels.length === 0 ? (
            <span className="image-annotation-toolbar-empty">
              请先在任务中定义标签
            </span>
          ) : (
            <AnnotationDrawLabelPicker
              className="image-annotation-toolbar-chips"
              variant="toolbar"
              labels={activeProject.labels}
              labelUsage={labelUsage}
              activeLabelId={activeLabelId}
              onSelect={setActiveLabelId}
            />
          )}
        </div>
      )}
      {imagePath && mode !== 'caption' && mode !== 'classification' ? (
        <PreAnnotToolbarSection
          mode={mode}
          imagePath={imagePath}
          disabled={!canvasReady}
        />
      ) : null}
    </div>
  );
}
