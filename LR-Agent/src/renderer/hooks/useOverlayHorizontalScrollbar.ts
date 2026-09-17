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

export interface OverlayHorizontalScrollThumb {
  visible: boolean;
  widthPercent: number;
  leftPercent: number;
}

const SCROLL_HINT_MS = 800;

interface UseOverlayHorizontalScrollbarOptions {
  enabled?: boolean;
  observeKey?: unknown;
  onScroll?: UIEventHandler<HTMLDivElement>;
}

export function useOverlayHorizontalScrollbar({
  enabled = true,
  observeKey,
  onScroll,
}: UseOverlayHorizontalScrollbarOptions = {}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbDragRef = useRef<{
    startX: number;
    startScrollLeft: number;
    scrollPerPx: number;
  } | null>(null);

  const [hovered, setHovered] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [thumb, setThumb] = useState<OverlayHorizontalScrollThumb>({
    visible: false,
    widthPercent: 100,
    leftPercent: 0,
  });

  const updateThumb = useCallback(() => {
    const el = contentRef.current;
    if (!el || !enabled) return;

    const { scrollWidth, clientWidth, scrollLeft } = el;
    if (scrollWidth <= clientWidth + 1) {
      setThumb({ visible: false, widthPercent: 100, leftPercent: 0 });
      return;
    }

    const widthPercent = (clientWidth / scrollWidth) * 100;
    const leftPercent = scrollWidth > 0 ? (scrollLeft / scrollWidth) * 100 : 0;

    setThumb({
      visible: true,
      widthPercent: Math.max(widthPercent, 8),
      leftPercent,
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

  useEffect(() => {
    if (!enabled) return undefined;

    const scroller = scrollerRef.current;
    if (!scroller) return undefined;

    const onWheel = (event: WheelEvent) => {
      const content = contentRef.current;
      if (!content || content.scrollWidth <= content.clientWidth + 1) return;

      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      if (!delta) return;

      event.preventDefault();
      content.scrollLeft += delta;
      updateThumb();
      markScrolling();
    };

    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [enabled, markScrolling, observeKey, updateThumb]);

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
        Math.max(0, (event.clientX - rect.left) / rect.width),
      );
      const maxScroll = el.scrollWidth - el.clientWidth;
      el.scrollLeft = ratio * maxScroll;
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

      const trackWidth = track.clientWidth;
      const thumbWidthPx = (thumb.widthPercent / 100) * trackWidth;
      const maxThumbTravel = Math.max(1, trackWidth - thumbWidthPx);
      const maxScroll = content.scrollWidth - content.clientWidth;

      thumbDragRef.current = {
        startX: event.clientX,
        startScrollLeft: content.scrollLeft,
        scrollPerPx: maxScroll / maxThumbTravel,
      };
      setDragging(true);
      markScrolling();

      const onMove = (moveEvent: MouseEvent) => {
        const drag = thumbDragRef.current;
        const contentEl = contentRef.current;
        if (!drag || !contentEl) return;

        const deltaX = moveEvent.clientX - drag.startX;
        contentEl.scrollLeft = drag.startScrollLeft + deltaX * drag.scrollPerPx;
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
    [markScrolling, thumb.visible, thumb.widthPercent, updateThumb],
  );

  const scrollerClassName = [
    'overlay-horizontal-scroll-area',
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

  const mergeScrollerRef = useCallback(
    (externalRef?: Ref<HTMLDivElement>) => (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
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
    scrollerRef,
    trackRef,
    thumb,
    scrollerClassName,
    handleScroll,
    handleTrackClick,
    handleThumbMouseDown,
    setHovered,
    mergeContentRef,
    mergeScrollerRef,
    updateThumb,
  };
}
