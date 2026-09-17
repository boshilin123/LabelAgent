import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import type { AgentSession } from '../../types/agent';
import { useAgentChat } from '../../context/AgentChatContext';
import { getPopoverMotionProps } from '../../motion/PopoverMotion';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import './AgentHistoryPopover.css';

interface AgentHistoryPopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  initialPosition: { top: number; right: number };
  onClose: () => void;
  onExitComplete?: () => void;
}

export function computeHistoryPopoverPosition(anchor: HTMLElement): {
  top: number;
  right: number;
} {
  const rect = anchor.getBoundingClientRect();
  return {
    top: rect.bottom + 6,
    right: Math.max(8, window.innerWidth - rect.right),
  };
}

interface HistoryGroup {
  label: string;
  sessions: AgentSession[];
}

function startOfDay(date: Date): number {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
}

function groupSessions(sessions: AgentSession[]): HistoryGroup[] {
  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  const today: AgentSession[] = [];
  const yesterday: AgentSession[] = [];
  const previous7Days: AgentSession[] = [];
  const older: AgentSession[] = [];

  for (const session of sessions) {
    const ts = session.updatedAt;
    if (ts >= todayStart) today.push(session);
    else if (ts >= yesterdayStart) yesterday.push(session);
    else if (ts >= weekStart) previous7Days.push(session);
    else older.push(session);
  }

  const groups: HistoryGroup[] = [];
  if (today.length) groups.push({ label: 'Today', sessions: today });
  if (yesterday.length)
    groups.push({ label: 'Yesterday', sessions: yesterday });
  if (previous7Days.length) {
    groups.push({ label: 'Previous 7 days', sessions: previous7Days });
  }
  if (older.length) groups.push({ label: 'Older', sessions: older });
  return groups;
}

export default function AgentHistoryPopover({
  open,
  anchorRef,
  initialPosition,
  onClose,
  onExitComplete,
}: AgentHistoryPopoverProps) {
  const {
    sessionOrderForProject: sessionOrder,
    sessions,
    activeSessionId,
    openSessionTab,
    deleteSession,
    isSessionStreaming,
    sessionsHasMore,
    loadingMoreSessions,
    loadMoreSessions,
  } = useAgentChat();
  const reducedMotion = useReducedMotion();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(initialPosition);

  useLayoutEffect(() => {
    setPosition(initialPosition);
  }, [initialPosition]);

  const updatePosition = () => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    setPosition(computeHistoryPopoverPosition(anchor));
  };

  useLayoutEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef]);

  const orderedSessions = useMemo(
    () =>
      sessionOrder
        .map((id) => sessions[id])
        .filter((session): session is AgentSession => Boolean(session)),
    [sessionOrder, sessions],
  );

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orderedSessions;
    return orderedSessions.filter((session) =>
      session.title.toLowerCase().includes(q),
    );
  }, [orderedSessions, query]);

  const groups = useMemo(
    () => groupSessions(filteredSessions),
    [filteredSessions],
  );

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [anchorRef, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <AnimatePresence onExitComplete={onExitComplete}>
      {open && (
        <m.div
          ref={popoverRef}
          className="agent-history-popover"
          style={{ top: position.top, right: position.right }}
          role="dialog"
          aria-label="历史对话"
          {...getPopoverMotionProps('top', reducedMotion)}
        >
          <div className="agent-history-search">
            <span className="codicon codicon-search agent-history-search-icon" />
            <input
              type="search"
              value={query}
              placeholder="Search Agents..."
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {/* fillHost：弹层是 flex 列，宿主拿到 flex:1/min-height:0 后内层才有确定高度，
              否则内容撑出弹层被 overflow:hidden 裁掉，滚动与「加载更多」都不会触发 */}
          <OverlayVerticalScrollArea
            className="agent-history-groups-scroll"
            fillHost
            onScroll={(event) => {
              const el = event.currentTarget;
              if (
                sessionsHasMore &&
                !loadingMoreSessions &&
                el.scrollHeight - el.scrollTop - el.clientHeight < 48
              ) {
                void loadMoreSessions();
              }
            }}
          >
            <div className="agent-history-groups">
              {groups.length === 0 ? (
                <div className="agent-history-empty">暂无历史对话</div>
              ) : (
                groups.map((group) => (
                  <section key={group.label} className="agent-history-group">
                    <div className="agent-history-group-label">
                      {group.label}
                    </div>
                    <ul className="agent-history-group-list">
                      {group.sessions.map((session) => {
                        const streaming = isSessionStreaming(session.id);
                        const active = session.id === activeSessionId;
                        return (
                          <li key={session.id} className="agent-history-row">
                            <button
                              type="button"
                              className={`agent-history-row-main${
                                active ? ' agent-history-row-main--active' : ''
                              }`}
                              onClick={() => openSessionTab(session.id)}
                            >
                              <span
                                className={`codicon ${
                                  streaming
                                    ? 'codicon-sync codicon-mod-spin'
                                    : active
                                      ? 'codicon-check'
                                      : 'codicon-history'
                                } agent-history-row-icon`}
                              />
                              <span className="agent-history-row-text">
                                <span className="agent-history-row-title">
                                  {session.title}
                                </span>
                                {session.lastMessagePreview ? (
                                  <span className="agent-history-row-preview">
                                    {session.lastMessagePreview}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="agent-history-row-delete"
                              aria-label="删除对话"
                              title="删除"
                              onClick={() => deleteSession(session.id)}
                            >
                              <span className="codicon codicon-trash" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))
              )}
              {loadingMoreSessions ? (
                <div className="agent-history-loading">加载中…</div>
              ) : null}
            </div>
          </OverlayVerticalScrollArea>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
