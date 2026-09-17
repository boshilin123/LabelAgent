import { useCallback, useRef, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import AnnotationLabelOverflowMenuPortal from './AnnotationLabelOverflowMenuPortal';
import './AnnotationDrawLabelPicker.css';

interface LabelOption {
  id: string;
  name: string;
  color: string;
}

export interface AnnotationItemLabelMenuProps {
  labels: LabelOption[];
  value: string;
  onChange: (labelId: string) => void;
  ariaLabel?: string;
}

export default function AnnotationItemLabelMenu({
  labels,
  value,
  onChange,
  ariaLabel = '切换标签',
}: AnnotationItemLabelMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);

  const selectLabel = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
    },
    [onChange],
  );

  if (labels.length === 0) return null;

  return (
    <div className="annotation-right-label-more-wrap" ref={buttonRef}>
      <VscodeButton
        secondary
        icon="tag"
        iconOnly
        type="button"
        className={`annotation-right-label-more-btn annotation-right-item-label-more-btn${
          open ? ' annotation-right-label-more-btn--open' : ''
        }`}
        title="更多标签"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      />
      {open && buttonRef.current ? (
        <AnnotationLabelOverflowMenuPortal
          anchorEl={buttonRef.current}
          labels={labels}
          activeLabelId={value}
          onSelect={selectLabel}
          onClose={() => setOpen(false)}
          ariaLabel={ariaLabel}
          chipClassName="annotation-right-label-btn"
          chipActiveClassName="annotation-right-label-btn--picked"
          chipMenuClassName="annotation-right-label-btn--menu"
        />
      ) : null}
    </div>
  );
}
