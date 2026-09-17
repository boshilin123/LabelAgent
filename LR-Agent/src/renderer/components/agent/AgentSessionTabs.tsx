import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useLayoutResizing } from '../../hooks/useLayoutResizing';
import { createResizeObserver } from '../../utils/resizeObserver';
import {
  motionDuration,
  motionEase,
  motionDistance,
} from '../../motion/tokens';
import VscodeClickableToolbarButton from '../VscodeClickableButton';
import { useAgentChat } from '../../context/AgentChatContext';
import {
  findSubagentBlock,
  isSamePanelTab,
  truncateSubagentQuery,
} from '../../services/subagentBlocks';
import { useAnnotation } from '../../context/AnnotationContext';
import { useWorkMode } from '../../context/WorkModeContext';
import AgentHistoryPopover, {
  computeHistoryPopoverPosition,
} from './AgentHistoryPopover';
import './AgentSessionTabs.css';

interface TabScrollThumb {
  visible: boolean;
  widthPercent: number;
  leftPercent: number;
}

const SCROLL_HINT_MS = 800;

export default function AgentSessionTabs() {
  const {
    openPanelTabs,
    activePanelTab,
    sessions,
    messagesBySession,
    createSession,
    closePanelTab,
    switchPanelTab,
    historyOpen,
    setHistoryOpen,
    isSessionStreaming,
  } = useAgentChat();
  const { activeProject, openWorkspaceMemory } = useAnnotation();
  const { workMode } = useWorkMode();
  const showWorkspaceMemory =
    workMode === 'annotation' && Boolean(activeProject);
  const reducedMotion = useReducedMotion();
  const isLayoutResizing = useLayoutResizing();
  const enableTabLayout = !reducedMotion && !isLayoutResizing;

  const listRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbDragRef = useRef<{
    startX: number;
    startScrollLeft: number;
    scrollPerPx: number;
  } | null>(null);

  const historyAnchorRef = useRef<HTMLDivElement>(null);
  const [historyPosition, setHistoryPosition] = useState<{
    top: number;
    right: number;
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
  }, [openPanelTabs, updateThumb]);

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

  const handleListScroll = useCallback(() => {
    updateThumb();
    markScrolling();
  }, [markScrolling, updateThumb]);

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
  }, [markScrolling, updateThumb, openPanelTabs.length]);

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

  const toggleHistory = () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }

    const anchor = historyAnchorRef.current;
    if (anchor) {
      setHistoryPosition(computeHistoryPopoverPosition(anchor));
    }
    setHistoryOpen(true);
  };

  const closeHistory = () => {
    setHistoryOpen(false);
  };

  const openMemory = () => {
    if (!activeProject) return;
    openWorkspaceMemory(activeProject);
  };

  const scrollerClassName = [
    'agent-session-tab-scroller',
    scrolling ? 'is-scrolling' : '',
    thumbDragging ? 'is-dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="agent-session-tabs">
      <div ref={scrollerRef} className={scrollerClassName}>
        <div
          ref={listRef}
          className="agent-session-tab-list"
          role="tablist"
          onScroll={handleListScroll}
        >
          <AnimatePresence
            initial={false}
            mode={enableTabLayout ? 'popLayout' : 'sync'}
          >
            {openPanelTabs.map((tab) => {
              const active = isSamePanelTab(tab, activePanelTab);
              if (tab.kind === 'session') {
                const session = sessions[tab.sessionId];
                if (!session) return null;
                const streaming = isSessionStreaming(tab.sessionId);
                return (
                  <m.div
                    key={`session:${tab.sessionId}`}
                    role="tab"
                    aria-selected={active}
                    layout={enableTabLayout}
                    className={`agent-session-tab${active ? ' agent-session-tab--active' : ''}`}
                    initial={
                      reducedMotion
                        ? { opacity: 0 }
                        : { opacity: 0, x: motionDistance.x, scale: 0.95 }
                    }
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={
                      reducedMotion
                        ? { opacity: 0 }
                        : { opacity: 0, x: -motionDistance.x / 2, scale: 0.95 }
                    }
                    transition={{
                      duration: reducedMotion ? 0.1 : motionDuration.tab,
                      ease: motionEase,
                    }}
                  >
                    <button
                      type="button"
                      className="agent-session-tab-main"
                      onClick={() => switchPanelTab(tab)}
                    >
                      <span
                        className="codicon codicon-comment agent-session-tab-icon"
                        aria-hidden
                      />
                      {streaming && <span className="agent-session-tab-dot" />}
                      <span className="agent-session-tab-title">
                        {session.title}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="agent-session-tab-close"
                      aria-label="关闭会话"
                      onClick={(event) => {
                        event.stopPropagation();
                        closePanelTab(tab);
                      }}
                    >
                      <span className="codicon codicon-close" aria-hidden />
                    </button>
                  </m.div>
                );
              }

              const found = findSubagentBlock(messagesBySession, tab.runId);
              const query = found?.block.query ?? '查阅';
              const running = found?.block.status === 'running';
              return (
                <m.div
                  key={`subagent:${tab.runId}`}
                  role="tab"
                  aria-selected={active}
                  layout={enableTabLayout}
                  className={`agent-session-tab agent-session-tab--subagent${active ? ' agent-session-tab--active' : ''}`}
                  initial={
                    reducedMotion
                      ? { opacity: 0 }
                      : { opacity: 0, x: motionDistance.x, scale: 0.95 }
                  }
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={
                    reducedMotion
                      ? { opacity: 0 }
                      : { opacity: 0, x: -motionDistance.x / 2, scale: 0.95 }
                  }
                  transition={{
                    duration: reducedMotion ? 0.1 : motionDuration.tab,
                    ease: motionEase,
                  }}
                >
                  <button
                    type="button"
                    className="agent-session-tab-main"
                    onClick={() => switchPanelTab(tab)}
                  >
                    <span
                      className={`agent-session-tab-dot${
                        running ? ' agent-subagent-row-dot--running' : ''
                      }`}
                    />
                    <span className="agent-session-tab-subagent-label">
                      subagent
                    </span>
                    <span className="agent-session-tab-title">
                      {truncateSubagentQuery(query, 20)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="agent-session-tab-close"
                    aria-label="关闭查阅"
                    onClick={(event) => {
                      event.stopPropagation();
                      closePanelTab(tab);
                    }}
                  >
                    <span className="codicon codicon-close" aria-hidden />
                  </button>
                </m.div>
              );
            })}
          </AnimatePresence>
        </div>

        <div
          ref={scrollbarTrackRef}
          className="agent-session-tab-scrollbar"
          role="presentation"
          onClick={thumb.visible ? handleScrollbarTrackClick : undefined}
        >
          {thumb.visible && (
            <div
              className="agent-session-tab-scrollbar-thumb"
              role="presentation"
              style={{
                width: `${thumb.widthPercent}%`,
                left: `${thumb.leftPercent}%`,
              }}
              onMouseDown={handleThumbMouseDown}
            />
          )}
        </div>
      </div>

      <div className="agent-session-tab-actions">
        <VscodeClickableToolbarButton
          icon="add"
          label="新建 Agent 会话"
          title="新建 Agent 会话"
          onClick={() => createSession()}
        />
        {showWorkspaceMemory ? (
          <VscodeClickableToolbarButton
            icon="thinking"
            label="查看记忆"
            title="查看工作区记忆"
            onClick={openMemory}
          />
        ) : null}
        <div ref={historyAnchorRef} className="agent-history-anchor">
          <VscodeClickableToolbarButton
            icon="history"
            label="历史对话"
            title="历史对话"
            onClick={toggleHistory}
          />
          {historyPosition && (
            <AgentHistoryPopover
              open={historyOpen}
              anchorRef={historyAnchorRef}
              initialPosition={historyPosition}
              onClose={closeHistory}
              onExitComplete={() => setHistoryPosition(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
