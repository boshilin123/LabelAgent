import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { LlmProviderConfig } from '../../types/agent';
import {
  computeFloatingMenuPosition,
  type FloatingMenuPosition,
} from '../../utils/annotationMenuPosition';
import PopoverMotion from '../../motion/PopoverMotion';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import './AgentModelPicker.css';

interface AgentModelPickerProps {
  providers: LlmProviderConfig[];
  selectedId: string;
  disabled?: boolean;
  /** 与模式选择器并排时，使用 Cursor 式纯文本触发样式 */
  inline?: boolean;
  /** 下拉菜单相对触发按钮的展开方向；Agent Composer 在底部用 above */
  menuPlacement?: 'above' | 'below';
  onSelect: (providerId: string) => void;
}

const MENU_GAP = 6;

/** 与 OverlayVerticalScrollArea 的 maxHeight 保持一致，同时供定位测量使用 */
const MENU_MAX_HEIGHT = 'min(320px, calc(100vh - 16px))';

/** 锚点位移小于该值时视为「未被滚走」（流式输出自动滚到底不会移动 composer） */
const ANCHOR_MOVE_EPSILON_PX = 1;

export default function AgentModelPicker({
  providers,
  selectedId,
  disabled = false,
  inline = false,
  menuPlacement = 'above',
  onSelect,
}: AgentModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FloatingMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** OverlayVerticalScrollArea 内层滚动元素，用于打开时把选中项滚进可视区 */
  const listRef = useRef<HTMLDivElement>(null);
  /** 打开瞬间的锚点位置，用于判断滚动是否真的把菜单锚点带走了 */
  const anchorRectRef = useRef<DOMRect | null>(null);

  const selected =
    providers.find((item) => item.id === selectedId) ?? providers[0] ?? null;

  const updatePosition = useCallback(() => {
    const anchorEl = triggerRef.current;
    const menuEl = menuRef.current;
    if (!anchorEl || !menuEl) return;
    const next = computeFloatingMenuPosition(
      anchorEl,
      menuEl.offsetWidth,
      menuEl.offsetHeight,
      {
        gap: MENU_GAP,
        alignEnd: false,
        preferOpenUp: menuPlacement === 'above',
      },
    );
    setPosition((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.openUp === next.openUp
        ? prev
        : next,
    );
  }, [menuPlacement]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    // 记录锚点基准位置：只有锚点真的移动了才认为菜单位置失效
    anchorRectRef.current = triggerRef.current?.getBoundingClientRect() ?? null;
    updatePosition();
  }, [open, providers, updatePosition]);

  // 打开时把当前选中的模型滚进可视区，避免 provider 很多时看不到当前项
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(
      '.agent-model-picker-option--active',
    );
    if (!active) return;
    const centered =
      active.offsetTop - (list.clientHeight - active.offsetHeight) / 2;
    const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.max(0, Math.min(centered, maxScroll));
  }, [open, providers, selectedId]);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    // scroll 事件不冒泡，但捕获阶段仍会从 window 下发到目标元素，
    // 所以必须放行「菜单自身」的滚动，否则滚轮一滚菜单就被当成外部滚动而关闭。
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;

      const anchor = triggerRef.current;
      const before = anchorRectRef.current;
      if (anchor && before) {
        const now = anchor.getBoundingClientRect();
        // 锚点没动（例如消息列表流式输出自动滚到底）说明菜单位置仍有效，无需关闭
        if (
          Math.abs(now.top - before.top) < ANCHOR_MOVE_EPSILON_PX &&
          Math.abs(now.left - before.left) < ANCHOR_MOVE_EPSILON_PX
        ) {
          return;
        }
      }
      setOpen(false);
    };

    const onResize = () => setOpen(false);

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const label = selected
    ? selected.name || selected.model
    : providers.length === 0
      ? '请先配置大模型'
      : '选择模型';

  const menuOpen = open && providers.length > 0;

  const menu = menuOpen
    ? createPortal(
        <PopoverMotion
          open
          innerRef={menuRef}
          className={`agent-model-picker-menu agent-model-picker-menu--portal${
            position?.openUp ? ' agent-model-picker-menu--open-up' : ''
          }`}
          style={
            position
              ? {
                  top: `${position.top}px`,
                  left: `${position.left}px`,
                }
              : { visibility: 'hidden' }
          }
          origin={position?.openUp ? 'bottom' : 'top'}
          role="listbox"
        >
          {/* 契约测试要求显式给出高度来源：菜单宿主不是 flex 受限子项，故用 maxHeight */}
          <OverlayVerticalScrollArea
            maxHeight={MENU_MAX_HEIGHT}
            observeKey={providers.length}
            contentRef={listRef}
            contentClassName="agent-model-picker-menu-list"
          >
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                role="option"
                aria-selected={provider.id === selectedId}
                className={`agent-model-picker-option${
                  provider.id === selectedId
                    ? ' agent-model-picker-option--active'
                    : ''
                }`}
                onClick={() => {
                  onSelect(provider.id);
                  setOpen(false);
                }}
              >
                <span className="agent-model-picker-option-name">
                  {provider.name || provider.model}
                </span>
                <span className="agent-model-picker-option-model">
                  {provider.model}
                </span>
              </button>
            ))}
          </OverlayVerticalScrollArea>
        </PopoverMotion>,
        document.body,
      )
    : null;

  return (
    <div
      className={`agent-model-picker${inline ? ' agent-model-picker--inline' : ''}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className="agent-model-picker-trigger"
        disabled={disabled || providers.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          selected
            ? `${selected.name || selected.model} · ${selected.model}`
            : undefined
        }
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-model-picker-label">{label}</span>
        <span className="codicon codicon-chevron-down agent-model-picker-chevron" />
      </button>
      {menu}
    </div>
  );
}
