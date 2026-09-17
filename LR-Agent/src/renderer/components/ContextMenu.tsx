import { useCallback, useEffect, useRef, useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import './ContextMenu.css';

export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separatorAfter?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

const MENU_MAX_HEIGHT = 400;
const MENU_WIDTH = 220;
const MENU_ITEM_HEIGHT = 30;
const SEPARATOR_HEIGHT = 9; // 1px height + 4px top margin + 4px bottom margin
const MENU_PADDING_V = 8; // 4px top + 4px bottom

function estimateMenuHeight(items: ContextMenuItem[]): number {
  const separatorCount = items.filter((i) => i.separatorAfter).length;
  return (
    items.length * MENU_ITEM_HEIGHT +
    separatorCount * SEPARATOR_HEIGHT +
    MENU_PADDING_V
  );
}

export default function ContextMenu({
  items,
  x,
  y,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const mousePos = useRef({ x, y });
  const [adjustedPos, setAdjustedPos] = useState(() => {
    let adjustedX = x;
    let adjustedY = y;

    // 水平溢出修正
    if (adjustedX + MENU_WIDTH > window.innerWidth) {
      adjustedX = window.innerWidth - MENU_WIDTH - 4;
    }
    if (adjustedX < 0) adjustedX = 4;

    // 垂直方向：下方空间不足时向上翻转
    const totalHeight = estimateMenuHeight(items);
    if (adjustedY + totalHeight > window.innerHeight) {
      // 下方不够，尝试翻转向上
      if (adjustedY - totalHeight >= 0) {
        adjustedY -= totalHeight;
      } else {
        // 上下都不够，贴窗口底部
        adjustedY = Math.max(4, window.innerHeight - totalHeight - 4);
      }
    }
    // 上方不够时不再额外处理（上面有检查 adjustedY - totalHeight >= 0）

    return { x: adjustedX, y: adjustedY };
  });

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        // 延迟关闭避免刚打开的菜单被同一个 mousedown 关闭
        const dx = e.clientX - mousePos.current.x;
        const dy = e.clientY - mousePos.current.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          onClose();
        }
      }
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    // 微延迟注册监听，避免"同一个右键 click 立即关闭"
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside, true);
      document.addEventListener('keydown', handleKeyDown, true);
    }, 50);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [handleClickOutside, handleKeyDown]);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.disabled) return;
    item.onClick();
    onClose();
  };

  return (
    <AnimatePresence>
      <m.div
        ref={menuRef}
        className="lr-context-menu"
        style={{ left: adjustedPos.x, top: adjustedPos.y }}
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.92 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        role="menu"
      >
        {items.map((item) => (
          <div key={item.id}>
            <button
              type="button"
              className={`lr-context-menu-item${item.disabled ? ' lr-context-menu-item--disabled' : ''}`}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => handleItemClick(item)}
            >
              <span className="lr-context-menu-item-label">{item.label}</span>
              {item.shortcut && (
                <span className="lr-context-menu-item-shortcut">
                  {item.shortcut}
                </span>
              )}
            </button>
            {item.separatorAfter && (
              <div className="lr-context-menu-separator" />
            )}
          </div>
        ))}
      </m.div>
    </AnimatePresence>
  );
}
