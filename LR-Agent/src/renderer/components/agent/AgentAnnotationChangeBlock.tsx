import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import type {
  PipelineKind,
  ProposalBlockStatus,
} from '../../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import type { AnnotationInstance } from '../../types/annotationDocument';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import { basename } from '../../types/file';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import { useWorkMode } from '../../context/WorkModeContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import {
  annotationChangeDiffStats,
  summarizeAnnotationChange,
  formatAnnotationPreviewText,
  buildLabelMap,
} from '../../services/agentProposalApply';
import { proposalAnchorId } from '../../utils/fileDiffStats';
import { getOpenActionLabels } from './agentAnnotationNavigation';
import { requestOpenAnnotationPreview } from './agentAnnotationPreview';
import './AgentReasoningBlock.css';
import './AgentAnnotationChangeBlock.css';

const PREVIEW_CARD_MAX_HEIGHT_PX = 24 * 6;

interface AgentAnnotationChangeBlockProps {
  messageId: string;
  blockIndex: number;
  proposal: AnnotationBatchProposal;
  status: ProposalBlockStatus;
  /** 提案来源流水线（批量标注/标注修改），历史数据可能缺失 */
  sourceKind?: PipelineKind;
}

const SOURCE_KIND_LABELS: Record<PipelineKind, string> = {
  batch: '批量标注',
  mutation: '标注修改',
  report: '报告',
};

const KIND_LABELS: Record<string, string> = {
  bbox: 'bbox',
  rotated_bbox: 'rotated_bbox',
  polygon: 'polygon',
  pose: 'pose',
  point: 'point',
  caption: 'caption',
  classification: '分类',
  span_ner: 'NER',
  text_classification: '文本分类',
  instruction: '指令',
  cot: 'CoT',
  conversation: '对话',
  preference: '偏好',
};

function handleCardKeyDown(
  event: KeyboardEvent<HTMLElement>,
  onOpen: () => void,
): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onOpen();
  }
}

function AnnotationPreviewCard({
  ann,
  labelMap,
  index,
  openLabel,
  onOpen,
}: {
  ann: AnnotationInstance;
  labelMap: Map<string, string>;
  index: number;
  openLabel: string;
  onOpen: (ann: AnnotationInstance) => void;
}) {
  const previewText = formatAnnotationPreviewText(ann, labelMap);
  const kindLabel = KIND_LABELS[ann.kind] ?? ann.kind;

  return (
    <div
      className="agent-annotation-change-block__preview-card"
      role="button"
      tabIndex={0}
      aria-label={`${openLabel}：${kindLabel} #${index + 1}`}
      onClick={() => onOpen(ann)}
      onKeyDown={(event) => handleCardKeyDown(event, () => onOpen(ann))}
    >
      <span className="agent-annotation-change-block__preview-index">
        #{index + 1}
      </span>
      <span className="agent-annotation-change-block__preview-kind">
        {kindLabel}
      </span>
      <span
        className="agent-annotation-change-block__preview-text"
        title={previewText}
      >
        {previewText || '(空)'}
      </span>
      <span className="agent-annotation-change-block__preview-open">
        {openLabel}
      </span>
    </div>
  );
}

function AnnotationPreviewCards({
  annotations,
  labelMap,
  openLabel,
  onOpenAnnotation,
}: {
  annotations: AnnotationInstance[];
  labelMap: Map<string, string>;
  openLabel: string;
  onOpenAnnotation: (ann: AnnotationInstance) => void;
}) {
  if (annotations.length === 0) {
    return (
      <div className="agent-annotation-change-block__preview-area">
        <div className="agent-annotation-change-block__preview-empty">
          无标注数据
        </div>
      </div>
    );
  }

  return (
    <div className="agent-annotation-change-block__preview-area">
      <OverlayVerticalScrollArea
        enabled
        maxHeight={`${PREVIEW_CARD_MAX_HEIGHT_PX}px`}
        disabledContentClassName="agent-annotation-change-block__preview-cards"
        contentClassName="agent-annotation-change-block__preview-cards"
        observeKey={annotations.length}
      >
        {annotations.map((ann, idx) => (
          <AnnotationPreviewCard
            key={ann.id ?? idx}
            ann={ann}
            labelMap={labelMap}
            index={idx}
            openLabel={openLabel}
            onOpen={(annotation) => onOpenAnnotation(annotation)}
          />
        ))}
      </OverlayVerticalScrollArea>
    </div>
  );
}

export default function AgentAnnotationChangeBlock({
  messageId,
  blockIndex,
  proposal,
  status,
  sourceKind,
}: AgentAnnotationChangeBlockProps) {
  const { activeProject } = useAnnotation();
  const { rootPath, openFileInEditor } = useApp();
  const { setWorkMode } = useWorkMode();
  const {
    enterAgentPreview,
    schedulePendingAgentNavigation,
    applyImmediateAnnotationPreview,
    relativeFilePath,
    loadSyntheticAnnotationForView,
    selectAnnotation,
    setTool,
  } = useAnnotationWorkspace();
  const anchorId = proposalAnchorId(messageId, blockIndex);
  const modality = activeProject?.modality;

  const labelMap = useMemo(
    () => buildLabelMap(activeProject?.labels ?? []),
    [activeProject?.labels],
  );

  const items = useMemo(
    () =>
      proposal.changes.map((change) => ({
        key: `${change.relativePath}-${change.operation}`,
        path: change.relativePath,
        absolutePath: change.absolutePath,
        summary: summarizeAnnotationChange(change),
        operation: change.operation,
        annotations: change.annotations,
        ...annotationChangeDiffStats(change),
      })),
    [proposal.changes],
  );

  const [expandedItems, setExpandedItems] = useState<Set<string>>(
    () => new Set(),
  );

  const handleToggleExpand = useCallback((key: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleOpenAnnotationPreview = useCallback(
    (
      relativePath: string,
      absolutePath: string,
      annotation: AnnotationInstance,
    ) => {
      if (!annotation.id) return;
      requestOpenAnnotationPreview(
        {
          relativePath,
          absolutePath,
          annotationId: annotation.id,
          status,
          proposal,
          proposalAnchorId: anchorId,
        },
        {
          activeProject: activeProject ?? null,
          rootPath,
          workspaceRelativePath: relativeFilePath,
          setWorkMode,
          openFileInEditor,
          schedulePendingAgentNavigation,
          applyImmediateAnnotationPreview,
          enterAgentPreview,
          selectAnnotation,
          setTool,
          loadSyntheticAnnotationForView,
        },
      );
    },
    [
      activeProject,
      anchorId,
      applyImmediateAnnotationPreview,
      enterAgentPreview,
      loadSyntheticAnnotationForView,
      openFileInEditor,
      proposal,
      relativeFilePath,
      rootPath,
      schedulePendingAgentNavigation,
      selectAnnotation,
      setTool,
      setWorkMode,
      status,
    ],
  );

  return (
    <>
      {sourceKind ? (
        <div className="agent-annotation-change-block__source">
          来自{SOURCE_KIND_LABELS[sourceKind] ?? '批量标注'}
        </div>
      ) : null}
      {items.map((item) => {
        const isExpanded = expandedItems.has(item.key);
        const isDelete = item.operation === 'delete';
        const fileName = basename(item.path) || item.path;
        return (
          <div
            key={item.key}
            className="agent-tool-block"
            data-proposal-id={anchorId}
          >
            <button
              type="button"
              className="agent-block-toggle"
              aria-expanded={isExpanded}
              onClick={() => handleToggleExpand(item.key)}
            >
              <VscodeIcon
                name={isExpanded ? 'chevron-down' : 'chevron-right'}
                size={12}
              />
              <span>
                {isDelete ? 'Deleted' : 'Edited'} {fileName}
              </span>
              {item.additions > 0 || item.deletions > 0 ? (
                <span className="agent-edit-stats">
                  {item.additions > 0 ? (
                    <span className="agent-edit-stats__add">
                      +{item.additions}
                    </span>
                  ) : null}
                  {item.deletions > 0 ? (
                    <span className="agent-edit-stats__del">
                      -{item.deletions}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </button>
            {isExpanded ? (
              <div className="agent-tool-body">
                <div className="agent-annotation-change-block__file-summary">
                  {item.summary}
                </div>
                {item.annotations && item.annotations.length > 0 ? (
                  <AnnotationPreviewCards
                    annotations={item.annotations}
                    labelMap={labelMap}
                    openLabel={getOpenActionLabels(modality, item.path).button}
                    onOpenAnnotation={(annotation) =>
                      handleOpenAnnotationPreview(
                        item.path,
                        item.absolutePath,
                        annotation,
                      )
                    }
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
