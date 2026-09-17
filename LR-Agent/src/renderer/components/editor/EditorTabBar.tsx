import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { basename } from '../../types/file';
import { createResizeObserver } from '../../utils/resizeObserver';
import FileTypeIcon from '../FileTypeIcon';
import './EditorTabBar.css';

interface EditorTabBarProps {
  tabs: Array<{
    id: string;
    filePath: string;
    dirty: boolean;
    preview: boolean;
  }>;
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onPinTab?: (tabId: string) => void;
}

interface TabScrollThumb {
  visible: boolean;
  widthPercent: number;
  leftPercent: number;
}

const SCROLL_HINT_MS = 800;

export default function EditorTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onPinTab,
}: EditorTabBarProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbDragRef = useRef<{
    startX: number;
    startScrollLeft: number;
    scrollPerPx: number;
  } | null>(null);

  const [thumb, setThumb] = useState<TabScrollThumb>({
    visible: false,
    widthPercent: 100,
    leftPercent: 0,
  });
  const [scrolling, setScrolling] = useState(false);
  const [thumbDragging, setThumbDragging] = useState(false);

  const updateThumb = useCallback(() => {
    const el = listRef.current;
    if (!el) return;

    const { scrollWidth, clientWidth, scrollLeft } = el;
    if (scrollWidth <= clientWidth + 1) {
      setThumb({ visible: false, widthPercent: 100, leftPercent: 0 });
      return;
    }

    const widthPercent = (clientWidth / scrollWidth) * 100;
    const maxLeft = scrollWidth - clientWidth;
    const leftPercent = maxLeft > 0 ? (scrollLeft / scrollWidth) * 100 : 0;

    setThumb({
      visible: true,
      widthPercent: Math.max(widthPercent, 8),
      leftPercent,
    });
  }, []);

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

  const handleListScroll = useCallback(() => {
    updateThumb();
    markScrolling();
  }, [markScrolling, updateThumb]);

  useEffect(() => {
    const el = listRef.current;
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
  }, [tabs, updateThumb]);

  useEffect(
    () => () => {
      if (scrollHintTimerRef.current) {
        clearTimeout(scrollHintTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;

    const onWheel = (event: WheelEvent) => {
      const list = listRef.current;
      if (!list || list.scrollWidth <= list.clientWidth + 1) return;

      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      if (!delta) return;

      event.preventDefault();
      list.scrollLeft += delta;
      updateThumb();
      markScrolling();
    };

    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [markScrolling, tabs.length, updateThumb]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !activeTabId) return;

    const activeEl = list.querySelector<HTMLElement>(
      `[data-tab-id="${activeTabId}"]`,
    );
    activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateThumb();
  }, [activeTabId, tabs, updateThumb]);

  const handleScrollbarTrackClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;

      const el = listRef.current;
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

      const list = listRef.current;
      const track = scrollbarTrackRef.current;
      if (!list || !track || !thumb.visible) return;

      const trackWidth = track.clientWidth;
      const thumbWidthPx = (thumb.widthPercent / 100) * trackWidth;
      const maxThumbTravel = Math.max(1, trackWidth - thumbWidthPx);
      const maxScroll = list.scrollWidth - list.clientWidth;

      thumbDragRef.current = {
        startX: event.clientX,
        startScrollLeft: list.scrollLeft,
        scrollPerPx: maxScroll / maxThumbTravel,
      };
      setThumbDragging(true);
      markScrolling();

      const onMove = (moveEvent: MouseEvent) => {
        const drag = thumbDragRef.current;
        const listEl = listRef.current;
        if (!drag || !listEl) return;

        const deltaX = moveEvent.clientX - drag.startX;
        listEl.scrollLeft = drag.startScrollLeft + deltaX * drag.scrollPerPx;
        updateThumb();
        markScrolling();
      };

      const onUp = () => {
        thumbDragRef.current = null;
        setThumbDragging(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [markScrolling, thumb.visible, thumb.widthPercent, updateThumb],
  );

  if (tabs.length === 0) return null;

  const scrollerClassName = [
    'editor-tab-bar-scroller',
    scrolling ? 'is-scrolling' : '',
    thumbDragging ? 'is-dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={scrollerRef} className={scrollerClassName}>
      <div
        ref={listRef}
        className="editor-tab-bar"
        role="tablist"
        onScroll={handleListScroll}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const name = basename(tab.filePath);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={active}
              className={`editor-tab${active ? ' editor-tab--active' : ''}${
                tab.preview ? ' editor-tab--preview' : ''
              }`}
              onDoubleClick={() => onPinTab?.(tab.id)}
            >
              <button
                type="button"
                className="editor-tab-main"
                onClick={() => onSelectTab(tab.id)}
                title={tab.filePath}
              >
                <FileTypeIcon path={tab.filePath} size={14} />
                <span className="editor-tab-name">{name}</span>
                {tab.dirty ? (
                  <span className="editor-tab-dirty" aria-label="未保存">
                    ●
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="editor-tab-close"
                aria-label={`关闭 ${name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <span className="codicon codicon-close" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>

      <div
        ref={scrollbarTrackRef}
        className="editor-tab-bar-scrollbar"
        role="presentation"
        onClick={thumb.visible ? handleScrollbarTrackClick : undefined}
      >
        {thumb.visible ? (
          <div
            className="editor-tab-bar-scrollbar-thumb"
            role="presentation"
            style={{
              width: `${thumb.widthPercent}%`,
              left: `${thumb.leftPercent}%`,
            }}
            onMouseDown={handleThumbMouseDown}
          />
        ) : null}
      </div>
    </div>
  );
}
