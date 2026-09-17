import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { LabelDefinition } from '../../types/annotation';
import { getLabelChipStyle } from '../../utils/labelColor';
import {
  computeVisibleLabelCount,
  orderLabelsForToolbar,
  splitLabelsForToolbar,
  type LabelUsageMap,
} from '../../utils/annotationLabelUsage';
import { createResizeObserver } from '../../utils/resizeObserver';
import AnnotationLabelOverflowMenuPortal from './AnnotationLabelOverflowMenuPortal';
import './AnnotationDrawLabelPicker.css';

type PickerVariant = 'toolbar' | 'panel';

const TOOLBAR_CHIP_GAP = 6;

const VARIANT_CLASSES: Record<
  PickerVariant,
  {
    chip: string;
    chipActive: string;
    chipMenu: string;
    moreWrap: string;
    moreBtn: string;
    moreBtnOpen: string;
  }
> = {
  toolbar: {
    chip: 'image-annotation-toolbar-chip',
    chipActive: 'image-annotation-toolbar-chip--active',
    chipMenu: 'image-annotation-toolbar-chip--menu',
    moreWrap: 'image-annotation-toolbar-more-wrap',
    moreBtn: 'image-annotation-toolbar-more-btn',
    moreBtnOpen: 'image-annotation-toolbar-more-btn--open',
  },
  panel: {
    chip: 'annotation-right-label-btn',
    chipActive: 'annotation-right-label-btn--picked',
    chipMenu: 'annotation-right-label-btn--menu',
    moreWrap: 'annotation-right-label-more-wrap',
    moreBtn: 'annotation-right-label-more-btn',
    moreBtnOpen: 'annotation-right-label-more-btn--open',
  },
};

export interface AnnotationDrawLabelPickerProps {
  labels: LabelDefinition[];
  labelUsage: LabelUsageMap;
  activeLabelId: string | null;
  onSelect: (labelId: string) => void;
  variant: PickerVariant;
  className?: string;
}

function readChipWidths(measureRoot: HTMLElement): {
  chipWidths: Map<string, number>;
  moreButtonWidth: number;
} {
  const chipWidths = new Map<string, number>();
  measureRoot.querySelectorAll<HTMLElement>('[data-label-id]').forEach((el) => {
    const id = el.dataset.labelId;
    if (id) chipWidths.set(id, el.offsetWidth);
  });
  const moreEl = measureRoot.querySelector<HTMLElement>('[data-measure-more]');
  return {
    chipWidths,
    moreButtonWidth: moreEl?.offsetWidth ?? 28,
  };
}

export default function AnnotationDrawLabelPicker({
  labels,
  labelUsage,
  activeLabelId,
  onSelect,
  variant,
  className = '',
}: AnnotationDrawLabelPickerProps) {
  const classes = VARIANT_CLASSES[variant];
  const isToolbar = variant === 'toolbar';
  const [moreOpen, setMoreOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [toolbarSplit, setToolbarSplit] = useState<{
    pinned: LabelDefinition[];
    overflow: LabelDefinition[];
  }>(() => ({ pinned: labels, overflow: [] }));

  const orderedToolbarLabels = useMemo(
    () => orderLabelsForToolbar(labels, labelUsage, activeLabelId),
    [labels, labelUsage, activeLabelId],
  );

  const panelSplit = useMemo(
    () => splitLabelsForToolbar(labels, labelUsage, activeLabelId),
    [labels, labelUsage, activeLabelId],
  );

  const recomputeToolbarSplit = useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) {
      setToolbarSplit({ pinned: orderedToolbarLabels, overflow: [] });
      return;
    }

    const { chipWidths, moreButtonWidth } = readChipWidths(measure);
    const visibleCount = computeVisibleLabelCount(
      orderedToolbarLabels,
      chipWidths,
      container.clientWidth,
      moreButtonWidth,
      TOOLBAR_CHIP_GAP,
    );

    setToolbarSplit({
      pinned: orderedToolbarLabels.slice(0, visibleCount),
      overflow: orderedToolbarLabels.slice(visibleCount),
    });
  }, [orderedToolbarLabels]);

  useLayoutEffect(() => {
    if (!isToolbar) return;
    recomputeToolbarSplit();
  }, [isToolbar, recomputeToolbarSplit]);

  useEffect(() => {
    if (!isToolbar) return undefined;

    const container = containerRef.current;
    if (!container) return undefined;

    const observer = createResizeObserver(recomputeToolbarSplit);
    if (observer) observer.observe(container);
    return () => observer?.disconnect();
  }, [isToolbar, recomputeToolbarSplit]);

  const { pinned, overflow } = isToolbar ? toolbarSplit : panelSplit;

  useEffect(() => {
    if (overflow.length === 0) {
      setMoreOpen(false);
    }
  }, [overflow.length]);

  const selectLabel = useCallback(
    (id: string) => {
      onSelect(id);
      setMoreOpen(false);
    },
    [onSelect],
  );

  return (
    <div ref={containerRef} className={className || undefined}>
      {isToolbar ? (
        <div
          ref={measureRef}
          className="annotation-draw-label-picker-measure"
          aria-hidden
        >
          {orderedToolbarLabels.map((lab) => (
            <button
              key={lab.id}
              type="button"
              tabIndex={-1}
              data-label-id={lab.id}
              className={classes.chip}
              style={getLabelChipStyle(lab.color)}
            >
              {lab.name}
            </button>
          ))}
          <button
            type="button"
            tabIndex={-1}
            data-measure-more
            className={classes.moreBtn}
          >
            <span className="codicon codicon-tag" aria-hidden />
          </button>
        </div>
      ) : null}
      {pinned.map((lab) => {
        const active = lab.id === activeLabelId;
        return (
          <button
            key={lab.id}
            type="button"
            className={`${classes.chip}${active ? ` ${classes.chipActive}` : ''}`}
            style={getLabelChipStyle(lab.color)}
            onClick={() => selectLabel(lab.id)}
          >
            {lab.name}
          </button>
        );
      })}
      {overflow.length > 0 && (
        <div className={classes.moreWrap}>
          <button
            ref={moreButtonRef}
            type="button"
            className={`${classes.moreBtn}${moreOpen ? ` ${classes.moreBtnOpen}` : ''}`}
            title="更多标签"
            aria-label="更多标签"
            aria-expanded={moreOpen}
            aria-haspopup="listbox"
            onClick={() => setMoreOpen((open) => !open)}
          >
            <span className="codicon codicon-tag" aria-hidden />
          </button>
          {moreOpen && moreButtonRef.current ? (
            <AnnotationLabelOverflowMenuPortal
              anchorEl={moreButtonRef.current}
              labels={overflow}
              activeLabelId={activeLabelId}
              onSelect={selectLabel}
              onClose={() => setMoreOpen(false)}
              ariaLabel="更多标签"
              chipClassName={classes.chip}
              chipActiveClassName={classes.chipActive}
              chipMenuClassName={classes.chipMenu}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
