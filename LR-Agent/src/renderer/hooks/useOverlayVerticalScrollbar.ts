import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type Ref,
  type UIEventHandler,
} from 'react';
import { createResizeObserver } from '../utils/resizeObserver';

export interface OverlayScrollThumb {
  visible: boolean;
  heightPercent: number;
  topPercent: number;
}

const SCROLL_HINT_MS = 800;

interface UseOverlayVerticalScrollbarOptions {
  enabled?: boolean;
  observeKey?: unknown;
  onScroll?: UIEventHandler<HTMLDivElement>;
}

export function useOverlayVerticalScrollbar({
  enabled = true,
  observeKey,
  onScroll,
}: UseOverlayVerticalScrollbarOptions = {}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbDragRef = useRef<{
    startY: number;
    startScrollTop: number;
    scrollPerPx: number;
  } | null>(null);

  const [hovered, setHovered] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [thumb, setThumb] = useState<OverlayScrollThumb>({
    visible: false,
    heightPercent: 100,
    topPercent: 0,
  });

  const updateThumb = useCallback(() => {
    const el = contentRef.current;
    if (!el || !enabled) return;

    const { scrollHeight, clientHeight, scrollTop } = el;
    if (scrollHeight <= clientHeight + 1) {
      setThumb({ visible: false, heightPercent: 100, topPercent: 0 });
      return;
    }

    const heightPercent = (clientHeight / scrollHeight) * 100;
    const topPercent = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;

    setThumb({
      visible: true,
      heightPercent: Math.max(heightPercent, 8),
      topPercent,
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;

    const el = contentRef.current;
    if (!el) return undefined;

    const sync = () => {
      updateThumb();
    };
    sync();
    const raf = requestAnimationFrame(sync);
    const observer = createResizeObserver(sync);
    if (observer) observer.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [enabled, observeKey, updateThumb]);

  useEffect(
    () => () => {
      if (scrollHintTimerRef.current) {
        clearTimeout(scrollHintTimerRef.current);
      }
    },
    [],
  );

  const markScrolling = useCallback(() => {
    setScrolling(true);
    if (scrollHintTimerRef.current) {
      clearTimeout(scrollHintTimerRef.current);
    }
    scrollHintTimerRef.current = setTimeout(() => {
      setScrolling(false);
      scrollHintTimerRef.current = null;
    }, SCROLL_HINT_MS);
  }, []);

  const handleScroll: UIEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      updateThumb();
      markScrolling();
      onScroll?.(event);
    },
    [markScrolling, onScroll, updateThumb],
  );

  const handleTrackClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;

      const el = contentRef.current;
      if (!el || !thumb.visible) return;

      const track = event.currentTarget;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(
        1,
        Math.max(0, (event.clientY - rect.top) / rect.height),
      );
      const maxScroll = el.scrollHeight - el.clientHeight;
      el.scrollTop = ratio * maxScroll;
      updateThumb();
      markScrolling();
    },
    [markScrolling, thumb.visible, updateThumb],
  );

  const handleThumbMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const content = contentRef.current;
      const track = trackRef.current;
      if (!content || !track || !thumb.visible) return;

      const trackHeight = track.clientHeight;
      const thumbHeightPx = (thumb.heightPercent / 100) * trackHeight;
      const maxThumbTravel = Math.max(1, trackHeight - thumbHeightPx);
      const maxScroll = content.scrollHeight - content.clientHeight;

      thumbDragRef.current = {
        startY: event.clientY,
        startScrollTop: content.scrollTop,
        scrollPerPx: maxScroll / maxThumbTravel,
      };
      setDragging(true);
      markScrolling();

      const onMove = (moveEvent: MouseEvent) => {
        const drag = thumbDragRef.current;
        const contentEl = contentRef.current;
        if (!drag || !contentEl) return;

        const deltaY = moveEvent.clientY - drag.startY;
        contentEl.scrollTop = drag.startScrollTop + deltaY * drag.scrollPerPx;
        updateThumb();
        markScrolling();
      };

      const onUp = () => {
        thumbDragRef.current = null;
        setDragging(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [markScrolling, thumb.visible, thumb.heightPercent, updateThumb],
  );

  const scrollerClassName = [
    'overlay-vertical-scroll-area',
    hovered ? 'is-hovered' : '',
    scrolling ? 'is-scrolling' : '',
    dragging ? 'is-dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const mergeContentRef = useCallback(
    (externalRef?: Ref<HTMLDivElement>) => (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (typeof externalRef === 'function') {
        externalRef(node);
      } else if (externalRef && 'current' in externalRef) {
        externalRef.current = node;
      }
    },
    [],
  );

  return {
    contentRef,
    trackRef,
    thumb,
    scrollerClassName,
    handleScroll,
    handleTrackClick,
    handleThumbMouseDown,
    setHovered,
    mergeContentRef,
    updateThumb,
  };
}
