import { useEffect, useRef, useState } from 'react';
import { KEYPOINT_TEMPLATES } from '../../types/keypointTemplate';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import PopoverMotion from '../../motion/PopoverMotion';
import './KeypointTemplateSelector.css';

export default function KeypointTemplateSelector() {
  const { activeTemplateId, setActiveTemplateId, activeTemplate } =
    useAnnotationWorkspace();

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const selectedLabel = activeTemplate
    ? `${activeTemplate.name} (${activeTemplate.keypoints.length}点)`
    : '选择骨架模板';

  return (
    <div className="keypoint-template-selector" ref={rootRef}>
      <span className="keypoint-template-label">骨架模板</span>
      <button
        type="button"
        className="keypoint-template-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="keypoint-template-value">{selectedLabel}</span>
        <span className="codicon codicon-chevron-down keypoint-template-chevron" />
      </button>

      <PopoverMotion
        open={open}
        className="keypoint-template-menu"
        origin="bottom"
        role="listbox"
      >
        {KEYPOINT_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="option"
            aria-selected={t.id === activeTemplateId}
            className={`keypoint-template-option${
              t.id === activeTemplateId
                ? ' keypoint-template-option--active'
                : ''
            }`}
            onClick={() => {
              setActiveTemplateId(t.id);
              setOpen(false);
            }}
          >
            <span className="keypoint-template-option-name">
              {t.name} ({t.keypoints.length}点)
            </span>
            <span className="keypoint-template-option-desc">
              {t.description}
            </span>
          </button>
        ))}
      </PopoverMotion>

      <span
        className="keypoint-template-hint"
        title={activeTemplate.description}
      >
        标签: {activeTemplate.defaultLabel}
      </span>
    </div>
  );
}
