import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { getLabelChipStyle } from '../../utils/labelColor';
import {
  computeFloatingMenuPosition,
  type FloatingMenuPosition,
} from '../../utils/annotationMenuPosition';
import './AnnotationLabelOverflowMenuPortal.css';

interface LabelOption {
  id: string;
  name: string;
  color: string;
}

export interface AnnotationLabelOverflowMenuPortalProps {
  anchorEl: HTMLElement;
  labels: LabelOption[];
  activeLabelId: string | null;
  onSelect: (labelId: string) => void;
  onClose: () => void;
  ariaLabel?: string;
  chipClassName: string;
  chipActiveClassName: string;
  chipMenuClassName: string;
}

export default function AnnotationLabelOverflowMenuPortal({
  anchorEl,
  labels,
  activeLabelId,
  onSelect,
  onClose,
  ariaLabel = '更多标签',
  chipClassName,
  chipActiveClassName,
  chipMenuClassName,
}: AnnotationLabelOverflowMenuPortalProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<FloatingMenuPosition | null>(null);

  const updatePosition = useCallback(() => {
    const menuEl = menuRef.current;
    if (!menuEl) return;
    setPosition(
      computeFloatingMenuPosition(
        anchorEl,
        menuEl.offsetWidth,
        menuEl.offsetHeight,
      ),
    );
  }, [anchorEl]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition, labels]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    const onDismiss = () => onClose();

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className={`annotation-label-overflow-menu-portal${
        position?.openUp
          ? ' annotation-label-overflow-menu-portal--open-up'
          : ''
      }`}
      role="listbox"
      tabIndex={0}
      aria-label={ariaLabel}
      style={
        position
          ? {
              top: `${position.top}px`,
              left: `${position.left}px`,
            }
          : { visibility: 'hidden' }
      }
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {labels.map((lab) => {
        const active = lab.id === activeLabelId;
        return (
          <button
            key={lab.id}
            type="button"
            role="option"
            aria-selected={active}
            className={`${chipClassName} ${chipMenuClassName}${
              active ? ` ${chipActiveClassName}` : ''
            }`}
            style={getLabelChipStyle(lab.color)}
            onClick={() => onSelect(lab.id)}
          >
            {lab.name}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
