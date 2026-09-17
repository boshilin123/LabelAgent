import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  type UIEventHandler,
} from 'react';
import { useScrollHostHeight } from '../hooks/useScrollHostHeight';
import { useOverlayVerticalScrollbar } from '../hooks/useOverlayVerticalScrollbar';
import './OverlayVerticalScrollArea.css';

interface OverlayVerticalScrollAreaProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  fillHost?: boolean;
  maxHeight?: string;
  enabled?: boolean;
  reserveBottom?: number;
  /** area：整块悬停显示滑块；edge：仅靠近右缘或滚动时显示 */
  hoverMode?: 'area' | 'edge';
  onScroll?: UIEventHandler<HTMLDivElement>;
  contentRef?: Ref<HTMLDivElement>;
  observeKey?: unknown;
  disabledContentClassName?: string;
}

const EDGE_HOVER_PX = 14;

export default function OverlayVerticalScrollArea({
  children,
  className = '',
  contentClassName = '',
  fillHost = false,
  maxHeight,
  enabled = true,
  reserveBottom = 0,
  hoverMode = 'area',
  onScroll,
  contentRef,
  observeKey,
  disabledContentClassName = '',
}: OverlayVerticalScrollAreaProps) {
  const { hostRef, height } = useScrollHostHeight();
  const {
    trackRef,
    thumb,
    scrollerClassName: baseScrollerClassName,
    handleScroll,
    handleTrackClick,
    handleThumbMouseDown,
    setHovered,
    mergeContentRef,
  } = useOverlayVerticalScrollbar({
    enabled,
    observeKey,
    onScroll,
  });

  if (!enabled) {
    return (
      <div className={disabledContentClassName || contentClassName}>
        {children}
      </div>
    );
  }

  const reserveBottomPx = reserveBottom > 0 ? `${reserveBottom}px` : undefined;
  const contentStyle: CSSProperties = {};
  if (maxHeight) {
    contentStyle.maxHeight = maxHeight;
  }
  if (fillHost && height > 0) {
    contentStyle.height = `${height}px`;
  }

  const scrollerClassName = [
    baseScrollerClassName,
    fillHost ? 'overlay-vertical-scroll-area--fill-host' : '',
    reserveBottom > 0 ? 'overlay-vertical-scroll-area--reserve-bottom' : '',
    hoverMode === 'edge' ? 'overlay-vertical-scroll-area--edge' : '',
    !fillHost ? className : '',
  ]
    .filter(Boolean)
    .join(' ');

  const scrollerStyle: CSSProperties | undefined =
    reserveBottomPx != null
      ? ({
          '--overlay-vertical-scroll-reserve-bottom': reserveBottomPx,
        } as CSSProperties)
      : undefined;

  const scroller = (
    <div
      className={scrollerClassName}
      style={scrollerStyle}
      onMouseEnter={hoverMode === 'area' ? () => setHovered(true) : undefined}
      onMouseMove={
        hoverMode === 'edge'
          ? (event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const nearEdge = rect.right - event.clientX <= EDGE_HOVER_PX;
              setHovered(nearEdge);
            }
          : undefined
      }
      onMouseLeave={() => setHovered(false)}
    >
      <div
        ref={mergeContentRef(contentRef)}
        className={`overlay-vertical-scroll-area__content${
          contentClassName ? ` ${contentClassName}` : ''
        }`}
        style={Object.keys(contentStyle).length > 0 ? contentStyle : undefined}
        onScroll={handleScroll}
      >
        {children}
      </div>
      {thumb.visible ? (
        <div
          ref={trackRef}
          className="overlay-vertical-scroll-area__track"
          role="presentation"
          onClick={handleTrackClick}
        >
          <div
            className="overlay-vertical-scroll-area__thumb"
            role="presentation"
            style={{
              height: `${thumb.heightPercent}%`,
              top: `${thumb.topPercent}%`,
            }}
            onMouseDown={handleThumbMouseDown}
          />
        </div>
      ) : null}
    </div>
  );

  if (!fillHost) {
    return scroller;
  }

  return (
    <div ref={hostRef} className={className || undefined}>
      {scroller}
    </div>
  );
}
