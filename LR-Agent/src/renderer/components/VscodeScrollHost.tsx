import { type ReactNode, type Ref, type UIEventHandler } from 'react';
import OverlayVerticalScrollArea from './OverlayVerticalScrollArea';

interface VscodeScrollHostProps {
  className?: string;
  scrollableClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  children: ReactNode;
}

/**
 * 侧栏滚动宿主：细悬浮滑块，仅在滚动或鼠标靠近右缘时显示。
 */
export default function VscodeScrollHost({
  className = '',
  scrollableClassName = '',
  scrollRef,
  onScroll,
  children,
}: VscodeScrollHostProps) {
  return (
    <OverlayVerticalScrollArea
      fillHost
      hoverMode="edge"
      className={`sidebar-scroll-host${className ? ` ${className}` : ''}`}
      contentClassName={`sidebar-panel-scroll${
        scrollableClassName ? ` ${scrollableClassName}` : ''
      }`}
      contentRef={scrollRef}
      onScroll={onScroll}
    >
      {children}
    </OverlayVerticalScrollArea>
  );
}
