import { type ReactNode, type Ref, type UIEventHandler } from 'react';
import { useOverlayHorizontalScrollbar } from '../hooks/useOverlayHorizontalScrollbar';
import './OverlayHorizontalScrollArea.css';

interface OverlayHorizontalScrollAreaProps {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  enabled?: boolean;
  observeKey?: unknown;
  onScroll?: UIEventHandler<HTMLDivElement>;
  contentRef?: Ref<HTMLDivElement>;
}

export default function OverlayHorizontalScrollArea({
  children,
  className = '',
  viewportClassName = '',
  contentClassName = '',
  enabled = true,
  observeKey,
  onScroll,
  contentRef,
}: OverlayHorizontalScrollAreaProps) {
  const {
    trackRef,
    thumb,
    scrollerClassName: baseScrollerClassName,
    handleScroll,
    handleTrackClick,
    handleThumbMouseDown,
    setHovered,
    mergeContentRef,
    mergeScrollerRef,
  } = useOverlayHorizontalScrollbar({
    enabled,
    observeKey,
    onScroll,
  });

  if (!enabled) {
    return <div className={contentClassName || className}>{children}</div>;
  }

  const scrollerClassName = [baseScrollerClassName, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={mergeScrollerRef()}
      className={scrollerClassName}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`overlay-horizontal-scroll-area__viewport${
          viewportClassName ? ` ${viewportClassName}` : ''
        }`}
      >
        <div
          ref={mergeContentRef(contentRef)}
          className={`overlay-horizontal-scroll-area__content${
            contentClassName ? ` ${contentClassName}` : ''
          }`}
          onScroll={handleScroll}
        >
          {children}
        </div>
        {thumb.visible ? (
          <div
            ref={trackRef}
            className="overlay-horizontal-scroll-area__track"
            role="presentation"
            onClick={handleTrackClick}
          >
            <div
              className="overlay-horizontal-scroll-area__thumb"
              role="presentation"
              style={{
                width: `${thumb.widthPercent}%`,
                left: `${thumb.leftPercent}%`,
              }}
              onMouseDown={handleThumbMouseDown}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
