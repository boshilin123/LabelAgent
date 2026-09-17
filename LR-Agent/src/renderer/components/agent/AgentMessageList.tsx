import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type UIEvent,
} from 'react';
import { VscodeLabel } from '@vscode-elements/react-elements';
import { useAgentChat } from '../../context/AgentChatContext';
import { createResizeObserver } from '../../utils/resizeObserver';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import AgentMessageItem from './AgentMessageItem';
import ContextMenu, { type ContextMenuItem } from '../ContextMenu';
import {
  JUMP_TO_BOTTOM_DURATION_MS,
  interpolateScrollTop,
  isNearBottom,
  measurePrependAnchor,
  nextScrollTopAfterAnchor,
  resolvePinnedAfterUserScroll,
  shouldFollowPinnedContent,
  shouldLoadOlderMessages,
  type PrependAnchor,
} from './agentMessageListScroll';
import { groupMessagesIntoTurns } from './agentMessageTurns';
import './AgentMessageList.css';

/** 检查选区是否在消息列表容器内 */
function isSelectionInside(containerEl: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const { anchorNode, focusNode } = sel;
  return (
    Boolean(anchorNode && containerEl.contains(anchorNode)) ||
    Boolean(focusNode && containerEl.contains(focusNode))
  );
}

export default function AgentMessageList() {
  const {
    activeSessionId,
    activeSession,
    editTargetMessageId,
    getSessionMessages,
    loadOlderMessages,
    loadingOlderMessages,
  } = useAgentChat();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(0);
  const smoothScrollingRef = useRef(false);
  const smoothRafRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const editTargetMessageIdRef = useRef(editTargetMessageId);
  editTargetMessageIdRef.current = editTargetMessageId;
  const prependRestoreRef = useRef<PrependAnchor | null>(null);
  const messages = activeSessionId ? getSessionMessages(activeSessionId) : [];
  const lastMessage =
    messages.length > 0 ? messages[messages.length - 1] : null;
  const firstMessageId = messages[0]?.id ?? '';
  const lastMessageId = lastMessage?.id ?? '';
  const scrollKey = activeSessionId
    ? `${activeSessionId}:${lastMessageId || '_empty'}:${lastMessage?.updatedAt ?? 0}`
    : '';

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current += 1;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = Math.max(
        0,
        programmaticScrollRef.current - 1,
      );
    });
  }, []);

  const cancelSmoothScroll = useCallback(() => {
    if (smoothRafRef.current) {
      cancelAnimationFrame(smoothRafRef.current);
      smoothRafRef.current = 0;
    }
    smoothScrollingRef.current = false;
  }, []);

  const scrollToBottomIfPinned = useCallback(
    (force = false) => {
      const scroller = scrollerRef.current;
      if (!scroller || smoothScrollingRef.current) return;
      if (
        !force &&
        !shouldFollowPinnedContent({
          pinned: pinnedToBottomRef.current,
          editing: Boolean(editTargetMessageIdRef.current),
        })
      ) {
        return;
      }
      markProgrammaticScroll();
      scroller.scrollTop = scroller.scrollHeight;
      lastScrollTopRef.current = scroller.scrollTop;
    },
    [markProgrammaticScroll],
  );

  const scrollToBottomSmooth = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    cancelSmoothScroll();
    const startTop = scroller.scrollTop;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (isNearBottom(scroller) || maxTop <= startTop) {
      scrollToBottomIfPinned(true);
      return;
    }

    const startedAt = performance.now();
    smoothScrollingRef.current = true;

    const tick = (now: number) => {
      const el = scrollerRef.current;
      if (!el || !smoothScrollingRef.current) return;

      const progress = Math.min(
        1,
        (now - startedAt) / JUMP_TO_BOTTOM_DURATION_MS,
      );
      const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = interpolateScrollTop(startTop, targetTop, progress);
      lastScrollTopRef.current = el.scrollTop;

      if (progress < 1) {
        smoothRafRef.current = requestAnimationFrame(tick);
        return;
      }

      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      cancelSmoothScroll();
    };

    smoothRafRef.current = requestAnimationFrame(tick);
  }, [cancelSmoothScroll, scrollToBottomIfPinned]);

  const pinToBottom = useCallback(() => {
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, []);

  const applyPinnedState = useCallback((pinned: boolean) => {
    pinnedToBottomRef.current = pinned;
    setShowJumpToBottom(!pinned);
  }, []);

  useLayoutEffect(() => {
    cancelSmoothScroll();
    pinToBottom();
    scrollToBottomIfPinned(true);
  }, [
    activeSessionId,
    cancelSmoothScroll,
    lastMessageId,
    pinToBottom,
    scrollToBottomIfPinned,
  ]);

  useLayoutEffect(() => {
    if (editTargetMessageId || !scrollKey) return;
    scrollToBottomIfPinned();
  }, [editTargetMessageId, scrollKey, scrollToBottomIfPinned]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const pending = prependRestoreRef.current;
    if (!scroller || !pending) return;

    if (pinnedToBottomRef.current) {
      prependRestoreRef.current = null;
      scrollToBottomIfPinned(true);
      return;
    }

    const nextTop = nextScrollTopAfterAnchor(scroller, pending);
    if (nextTop !== scroller.scrollTop) {
      markProgrammaticScroll();
      scroller.scrollTop = nextTop;
    }
    lastScrollTopRef.current = scroller.scrollTop;
    prependRestoreRef.current =
      loadingOlderMessages && pending.element.isConnected
        ? {
            element: pending.element,
            offset:
              pending.element.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top,
          }
        : null;
  }, [
    firstMessageId,
    loadingOlderMessages,
    markProgrammaticScroll,
    messages.length,
    scrollToBottomIfPinned,
  ]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const container = containerRef.current;
    if (!scroller || !container) return undefined;

    const observer = createResizeObserver(() => {
      scrollToBottomIfPinned();
    });
    observer?.observe(container);
    observer?.observe(scroller);
    return () => observer?.disconnect();
  }, [activeSessionId, scrollToBottomIfPinned]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && scroller.scrollTop > 0) {
        cancelSmoothScroll();
        applyPinnedState(false);
      }
    };

    scroller.addEventListener('wheel', onWheel, { passive: true });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [activeSessionId, applyPinnedState, cancelSmoothScroll]);

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      const programmatic =
        programmaticScrollRef.current > 0 || smoothScrollingRef.current;
      if (!programmatic) {
        applyPinnedState(
          resolvePinnedAfterUserScroll({
            previousScrollTop: lastScrollTopRef.current,
            currentlyPinned: pinnedToBottomRef.current,
            next: el,
          }),
        );
      }
      lastScrollTopRef.current = el.scrollTop;

      if (
        shouldLoadOlderMessages({
          programmatic,
          pinned: pinnedToBottomRef.current,
          hasMore: Boolean(activeSession?.hasMoreMessagesBefore),
          loading: loadingOlderMessages,
          scrollTop: el.scrollTop,
        })
      ) {
        const container = containerRef.current;
        prependRestoreRef.current = container
          ? measurePrependAnchor(el, container)
          : null;
        void loadOlderMessages(activeSessionId ?? undefined);
      }
    },
    [
      activeSession?.hasMoreMessagesBefore,
      activeSessionId,
      loadOlderMessages,
      loadingOlderMessages,
      applyPinnedState,
    ],
  );

  const handleJumpToBottom = useCallback(() => {
    pinToBottom();
    scrollToBottomSmooth();
  }, [pinToBottom, scrollToBottomSmooth]);

  const handleContextMenu = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !isSelectionInside(container)) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  useEffect(() => () => cancelSmoothScroll(), [cancelSmoothScroll]);

  const contextMenuItems: ContextMenuItem[] = [
    {
      id: 'copy',
      label: '复制',
      shortcut: 'Ctrl+C',
      onClick: () => {
        document.execCommand('copy');
      },
    },
  ];

  if (!activeSessionId) {
    return null;
  }

  return (
    <div className="agent-message-list-scroll">
      <OverlayVerticalScrollArea
        className="agent-message-list-scroll-host"
        contentClassName="agent-message-list-scrollable"
        fillHost
        observeKey={scrollKey}
        contentRef={scrollerRef}
        onScroll={handleScroll}
      >
        <div
          ref={containerRef}
          className="agent-message-list"
          onContextMenu={handleContextMenu}
        >
          {loadingOlderMessages ? (
            <div className="agent-message-list-loading">加载更早的消息…</div>
          ) : null}
          {messages.length === 0 ? (
            <div className="agent-message-empty">
              <VscodeLabel>开始与 Agent 对话</VscodeLabel>
              <p>在下方输入问题，支持 Markdown 与数学公式渲染。</p>
            </div>
          ) : (
            groupMessagesIntoTurns(messages).map((turn) => (
              <div key={turn.key} className="agent-message-turn">
                {turn.messages.map((message) => (
                  <AgentMessageItem key={message.id} message={message} />
                ))}
              </div>
            ))
          )}
        </div>
        {contextMenu && (
          <ContextMenu
            items={contextMenuItems}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={closeContextMenu}
          />
        )}
      </OverlayVerticalScrollArea>
      {showJumpToBottom ? (
        <button
          type="button"
          className="agent-message-list-jump-bottom"
          aria-label="回到底部"
          title="回到底部"
          onClick={handleJumpToBottom}
        >
          <svg
            className="agent-message-list-jump-bottom-icon"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <path
              fill="currentColor"
              d="M8 11.15a.85.85 0 0 1-.6-.25L3.15 6.65a.85.85 0 1 1 1.2-1.2L8 9.1l3.65-3.65a.85.85 0 1 1 1.2 1.2l-4.25 4.25a.85.85 0 0 1-.6.25z"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
