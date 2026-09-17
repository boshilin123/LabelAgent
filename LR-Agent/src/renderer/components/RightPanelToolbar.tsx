import ActivityIcon from './ActivityIcon';
import type { RightPanel } from './ActivityBar';
import './RightPanelToolbar.css';

interface RightPanelToolbarProps {
  activePanel: RightPanel;
  annotationTabDisabled?: boolean;
  qualityTabDisabled?: boolean;
  quickInferenceTabDisabled?: boolean;
  onAnnotationClick: () => void;
  onAgentClick: () => void;
  onQualityClick: () => void;
  onQuickInferenceClick: () => void;
}

export default function RightPanelToolbar({
  activePanel,
  annotationTabDisabled = false,
  qualityTabDisabled = false,
  quickInferenceTabDisabled = false,
  onAnnotationClick,
  onAgentClick,
  onQualityClick,
  onQuickInferenceClick,
}: RightPanelToolbarProps) {
  return (
    <div className="right-panel-icon-toolbar" role="tablist">
      <div
        role="tab"
        aria-selected={activePanel === 'annotation'}
        aria-disabled={annotationTabDisabled || undefined}
        className={`right-panel-icon-tab${annotationTabDisabled ? ' right-panel-icon-tab--disabled' : ''}`}
      >
        <ActivityIcon
          name="tag"
          label={
            annotationTabDisabled
              ? '标注列表（编辑器模式下不可用）'
              : '标注列表'
          }
          active={activePanel === 'annotation' && !annotationTabDisabled}
          disabled={annotationTabDisabled}
          onClick={onAnnotationClick}
        />
      </div>
      <div
        role="tab"
        aria-selected={activePanel === 'agent'}
        className="right-panel-icon-tab"
      >
        <ActivityIcon
          name="comment-discussion"
          label="AI Agent"
          active={activePanel === 'agent'}
          onClick={onAgentClick}
        />
      </div>
      <div
        role="tab"
        aria-selected={activePanel === 'quickInference'}
        aria-disabled={quickInferenceTabDisabled || undefined}
        className={`right-panel-icon-tab${quickInferenceTabDisabled ? ' right-panel-icon-tab--disabled' : ''}`}
      >
        <ActivityIcon
          name="sparkle"
          label={
            quickInferenceTabDisabled
              ? '快捷推理（编辑器模式下不可用）'
              : '快捷推理'
          }
          active={
            activePanel === 'quickInference' && !quickInferenceTabDisabled
          }
          disabled={quickInferenceTabDisabled}
          onClick={onQuickInferenceClick}
        />
      </div>
      <div
        role="tab"
        aria-selected={activePanel === 'quality'}
        aria-disabled={qualityTabDisabled || undefined}
        className={`right-panel-icon-tab${qualityTabDisabled ? ' right-panel-icon-tab--disabled' : ''}`}
      >
        <ActivityIcon
          name="graph-line"
          label={
            qualityTabDisabled ? '质量看板（标注模式下不可用）' : '质量看板'
          }
          active={activePanel === 'quality' && !qualityTabDisabled}
          disabled={qualityTabDisabled}
          onClick={onQualityClick}
        />
      </div>
    </div>
  );
}
