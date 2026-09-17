import {
  VscodeButton,
  VscodeIcon,
  VscodeLabel,
} from '@vscode-elements/react-elements';
import type { CSSProperties, KeyboardEventHandler, ReactElement } from 'react';
import {
  type AnnotationProject,
  getAnnotationTypeLabel,
  TASK_TYPE_CONFIG,
} from '../../types/annotation';
import type {
  BboxAnnotation,
  CaptionAnnotation,
  ClassificationAnnotation,
  ImagePointAnnotation,
  PolygonAnnotation,
  PoseAnnotation,
  RotatedBboxAnnotation,
  SpanAnnotation,
  TextClassificationAnnotation,
  InstructionAnnotation,
  PreferenceAnnotation,
  ConversationAnnotation,
  CotAnnotation,
} from '../../types/annotationDocument';
import { getKeypointTemplate } from '../../types/keypointTemplate';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import {
  AnnotationMotionList,
  AnnotationMotionListItem,
} from '../../motion/AnnotationListMotion';
import { getAnnotationLabelState } from '../../utils/annotationLabel';
import { getLabelChipStyle, hexToRgba } from '../../utils/labelColor';
import VscodeScrollHost from '../VscodeScrollHost';
import AnnotationDrawLabelPicker from './AnnotationDrawLabelPicker';
import KeypointTemplateSelector from './KeypointTemplateSelector';
import AnnotationItemLabelMenu from './AnnotationItemLabelMenu';
import './AnnotationRightPanel.css';

function getAnnotationItemStyle(accentColor?: string): CSSProperties {
  if (!accentColor) {
    return {
      '--annotation-accent': 'var(--vscode-descriptionForeground, #858585)',
      '--annotation-accent-bg': 'rgba(255, 255, 255, 0.03)',
      '--annotation-accent-bg-hover': 'rgba(255, 255, 255, 0.06)',
      '--annotation-accent-bg-active':
        'var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.31))',
    } as CSSProperties;
  }

  return {
    '--annotation-accent': accentColor,
    '--annotation-accent-bg': hexToRgba(accentColor, 0.08),
    '--annotation-accent-bg-hover': hexToRgba(accentColor, 0.12),
    '--annotation-accent-bg-active': hexToRgba(accentColor, 0.2),
  } as CSSProperties;
}

function handleAnnotationItemKeyDown(
  onSelect: () => void,
): KeyboardEventHandler<HTMLDivElement> {
  return (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };
}

function AnnotationListRow({
  index,
  labelId,
  labels,
  onChangeLabel,
  onDelete,
  suffix,
}: {
  index: number;
  labelId: string | null;
  labels: { id: string; name: string; color: string }[];
  onChangeLabel: (labelId: string) => void;
  onDelete: () => void;
  suffix?: string;
}) {
  const activeLabel = labelId ? labels.find((l) => l.id === labelId) : null;
  const labelState = getAnnotationLabelState(labelId, labels);

  return (
    <div className="annotation-right-item-row">
      <div className="annotation-right-item-label-group">
        <span className="annotation-right-item-main">
          <span className="annotation-right-index">#{index + 1}</span>
          {suffix ? (
            <span className="annotation-right-suffix">{suffix}</span>
          ) : null}
          {labelState === 'labeled' && activeLabel ? (
            <span
              className="annotation-right-chip"
              style={getLabelChipStyle(activeLabel.color)}
            >
              {activeLabel.name}
            </span>
          ) : null}
          {labelState === 'unlabeled' ? (
            <span className="annotation-right-unlabeled">未标注</span>
          ) : null}
          {labelState === 'orphaned' ? (
            <span className="annotation-right-unknown">未知标签</span>
          ) : null}
        </span>

        <AnnotationItemLabelMenu
          labels={labels}
          value={labelId ?? ''}
          onChange={onChangeLabel}
          ariaLabel={`标注 #${index + 1} 切换类别`}
        />
      </div>

      <VscodeButton
        secondary
        icon="trash"
        iconOnly
        type="button"
        className="annotation-right-label-more-btn annotation-right-item-label-more-btn annotation-right-delete vscode-btn-danger"
        aria-label={`删除标注 #${index + 1}`}
        title={`删除标注 #${index + 1}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      />
    </div>
  );
}

function renderBboxWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  bboxAnnotations: BboxAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  updateAnnotationLabel: (annotationId: string, labelId: string) => void,
  deleteAnnotation: (annotationId: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择一张项目内的图片。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }

  const emptyHint =
    project.labels.length === 0
      ? '添加标签后即可在画布上拖拽绘制矩形。'
      : '在画布空白处拖拽以新建矩形标注。';

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      {bboxAnnotations.length === 0 ? (
        <p className="annotation-right-muted">{emptyHint}</p>
      ) : (
        <AnnotationMotionList className="annotation-right-items">
          {bboxAnnotations.map((ann, idx) => {
            const selected = ann.id === selectedAnnotationId;
            const activeLabel = project.labels.find(
              (l) => l.id === ann.labelId,
            );
            const selectItem = () => selectAnnotation(ann.id);
            return (
              <AnnotationMotionListItem
                key={ann.id}
                layoutKey={ann.id}
                className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
                style={getAnnotationItemStyle(activeLabel?.color)}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`选择标注 ${idx + 1}`}
                onClick={selectItem}
                onKeyDown={handleAnnotationItemKeyDown(selectItem)}
              >
                <AnnotationListRow
                  index={idx}
                  labelId={ann.labelId}
                  labels={project.labels}
                  onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                  onDelete={() => deleteAnnotation(ann.id)}
                />
              </AnnotationMotionListItem>
            );
          })}
        </AnnotationMotionList>
      )}
    </VscodeScrollHost>
  );
}

function renderRotatedBboxWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  rotatedBboxAnnotations: RotatedBboxAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  setTool: (tool: 'select') => void,
  updateAnnotationLabel: (annotationId: string, labelId: string) => void,
  deleteAnnotation: (annotationId: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择一张项目内的图片。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }

  const emptyHint =
    project.labels.length === 0
      ? '添加标签后即可在画布上拖拽绘制旋转矩形。'
      : '在画布空白处拖拽以新建旋转矩形；选择模式下可拖动旋转控制点调整角度。';

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      {rotatedBboxAnnotations.length === 0 ? (
        <p className="annotation-right-muted">{emptyHint}</p>
      ) : (
        <AnnotationMotionList className="annotation-right-items">
          {rotatedBboxAnnotations.map((ann, idx) => {
            const selected = ann.id === selectedAnnotationId;
            const activeLabel = project.labels.find(
              (l) => l.id === ann.labelId,
            );
            const selectItem = () => {
              setTool('select');
              selectAnnotation(ann.id);
            };
            return (
              <AnnotationMotionListItem
                key={ann.id}
                layoutKey={ann.id}
                className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
                style={getAnnotationItemStyle(activeLabel?.color)}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`选择标注 ${idx + 1}`}
                onClick={selectItem}
                onKeyDown={handleAnnotationItemKeyDown(selectItem)}
              >
                <AnnotationListRow
                  index={idx}
                  labelId={ann.labelId}
                  labels={project.labels}
                  onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                  onDelete={() => deleteAnnotation(ann.id)}
                  suffix={`${Math.round(ann.angle)}°`}
                />
              </AnnotationMotionListItem>
            );
          })}
        </AnnotationMotionList>
      )}
    </VscodeScrollHost>
  );
}

function renderPolygonWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  polygonAnnotations: PolygonAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  setTool: (tool: 'select') => void,
  updateAnnotationLabel: (annotationId: string, labelId: string) => void,
  deleteAnnotation: (annotationId: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择一张项目内的图片。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }

  const emptyHint =
    project.labels.length === 0
      ? '添加标签后即可在画布上绘制多边形。'
      : '使用「多边形」工具在画布上点击描点，靠近起点或按 Enter 闭合。';

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      {polygonAnnotations.length === 0 ? (
        <p className="annotation-right-muted">{emptyHint}</p>
      ) : (
        <AnnotationMotionList className="annotation-right-items">
          {polygonAnnotations.map((ann, idx) => {
            const selected = ann.id === selectedAnnotationId;
            const activeLabel = project.labels.find(
              (l) => l.id === ann.labelId,
            );
            const selectItem = () => {
              setTool('select');
              selectAnnotation(ann.id);
            };
            return (
              <AnnotationMotionListItem
                key={ann.id}
                layoutKey={ann.id}
                className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
                style={getAnnotationItemStyle(activeLabel?.color)}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`选择标注 ${idx + 1}`}
                onClick={selectItem}
                onKeyDown={handleAnnotationItemKeyDown(selectItem)}
              >
                <AnnotationListRow
                  index={idx}
                  labelId={ann.labelId}
                  labels={project.labels}
                  onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                  onDelete={() => deleteAnnotation(ann.id)}
                />
              </AnnotationMotionListItem>
            );
          })}
        </AnnotationMotionList>
      )}
    </VscodeScrollHost>
  );
}

function renderKeypointWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  poseAnnotations: PoseAnnotation[],
  pointAnnotations: ImagePointAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  setTool: (tool: 'select' | 'place_pose') => void,
  updateAnnotationLabel: (annotationId: string, labelId: string) => void,
  deleteAnnotation: (id: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择一张项目内的图片。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }

  const total = poseAnnotations.length + pointAnnotations.length;
  const emptyHint =
    '选择骨架模板后，使用「放置骨架」在画布上单击；右键关键点可切换可见性。';

  type ListItem =
    | { kind: 'pose'; ann: PoseAnnotation }
    | { kind: 'point'; ann: ImagePointAnnotation };

  const items: ListItem[] = [
    ...poseAnnotations.map((ann) => ({ kind: 'pose' as const, ann })),
    ...pointAnnotations.map((ann) => ({ kind: 'point' as const, ann })),
  ];

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      {total === 0 ? (
        <p className="annotation-right-muted">{emptyHint}</p>
      ) : (
        <AnnotationMotionList className="annotation-right-items">
          {items.map((item, idx) => {
            const { ann } = item;
            const selected = ann.id === selectedAnnotationId;
            const activeLabel = project.labels.find(
              (l) => l.id === ann.labelId,
            );
            const selectItem = () => {
              setTool('select');
              selectAnnotation(ann.id);
            };
            const template =
              item.kind === 'pose'
                ? getKeypointTemplate(item.ann.templateId)
                : null;
            const suffix =
              item.kind === 'pose'
                ? `${template?.name ?? item.ann.templateId} · ${item.ann.keypoints.length}点`
                : '单点';
            return (
              <AnnotationMotionListItem
                key={ann.id}
                layoutKey={ann.id}
                className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
                style={getAnnotationItemStyle(activeLabel?.color)}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`选择标注 ${idx + 1}`}
                onClick={selectItem}
                onKeyDown={handleAnnotationItemKeyDown(selectItem)}
              >
                <AnnotationListRow
                  index={idx}
                  labelId={ann.labelId}
                  labels={project.labels}
                  onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                  onDelete={() => deleteAnnotation(ann.id)}
                  suffix={suffix}
                />
              </AnnotationMotionListItem>
            );
          })}
        </AnnotationMotionList>
      )}
    </VscodeScrollHost>
  );
}

function renderCaptionWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  captionAnnotations: CaptionAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  deleteAnnotation: (annotationId: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择一张项目内的图片。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }

  if (captionAnnotations.length === 0) {
    return <p className="annotation-right-muted">暂无描述。请在编辑区添加。</p>;
  }

  const GRANULARITY_LABELS: Record<string, string> = {
    brief: '简短',
    detailed: '详细',
    dense: '密集',
  };

  return (
    <VscodeScrollHost
      className="annotation-right-scroll-host"
      scrollableClassName="annotation-right-scrollable"
    >
      <AnnotationMotionList className="annotation-right-items">
        {captionAnnotations.map((ann, idx) => {
          const selected = ann.id === selectedAnnotationId;
          const selectItem = () => selectAnnotation(selected ? null : ann.id);
          return (
            <AnnotationMotionListItem
              key={ann.id}
              layoutKey={ann.id}
              className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
              style={getAnnotationItemStyle()}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`选择描述 ${idx + 1}`}
              onClick={selectItem}
              onKeyDown={handleAnnotationItemKeyDown(selectItem)}
            >
              <div className="annotation-right-item-row">
                <div className="annotation-right-item-label-group">
                  <span className="annotation-right-item-main">
                    <span className="annotation-right-index">#{idx + 1}</span>
                    <span className="annotation-right-suffix">
                      {GRANULARITY_LABELS[ann.granularity] ?? ann.granularity}
                    </span>
                  </span>
                  <p className="annotation-right-caption-summary">
                    {ann.text.length > 60
                      ? `${ann.text.slice(0, 60)}…`
                      : ann.text}
                  </p>
                </div>
                <VscodeButton
                  secondary
                  icon="trash"
                  iconOnly
                  type="button"
                  className="annotation-right-label-more-btn annotation-right-item-label-more-btn annotation-right-delete vscode-btn-danger"
                  aria-label="删除描述"
                  title="删除描述"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteAnnotation(ann.id);
                  }}
                />
              </div>
            </AnnotationMotionListItem>
          );
        })}
      </AnnotationMotionList>
    </VscodeScrollHost>
  );
}

function renderClassificationWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  classificationAnnotations: ClassificationAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  updateAnnotationLabel: (annotationId: string, labelId: string) => void,
  deleteAnnotation: (annotationId: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择一张项目内的图片。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }

  if (classificationAnnotations.length === 0) {
    return <p className="annotation-right-muted">未分配分类标签。</p>;
  }

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      <AnnotationMotionList className="annotation-right-items">
        {classificationAnnotations.map((ann, idx) => {
          const selected = ann.id === selectedAnnotationId;
          const activeLabel = project.labels.find((l) => l.id === ann.labelId);
          const selectItem = () => selectAnnotation(ann.id);
          return (
            <AnnotationMotionListItem
              key={ann.id}
              layoutKey={ann.id}
              className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
              style={getAnnotationItemStyle(activeLabel?.color)}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`选择分类 ${idx + 1}`}
              onClick={selectItem}
              onKeyDown={handleAnnotationItemKeyDown(selectItem)}
            >
              <AnnotationListRow
                index={idx}
                labelId={ann.labelId}
                labels={project.labels}
                onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                onDelete={() => deleteAnnotation(ann.id)}
              />
            </AnnotationMotionListItem>
          );
        })}
      </AnnotationMotionList>
    </VscodeScrollHost>
  );
}

// ── 文本标注渲染函数 ──

function renderSpanNerWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  spanAnnotations: SpanAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  updateAnnotationLabel: (annotationId: string, labelId: string) => void,
  deleteAnnotation: (annotationId: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择项目内的文本文件。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }

  if (spanAnnotations.length === 0) {
    return (
      <p className="annotation-right-muted">
        在文本编辑区选中文字后按 Ctrl+E 或点击「标注选中文本」创建实体标注。
      </p>
    );
  }

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      <AnnotationMotionList className="annotation-right-items">
        {spanAnnotations.map((ann, idx) => {
          const selected = ann.id === selectedAnnotationId;
          const activeLabel = project.labels.find((l) => l.id === ann.labelId);
          const selectItem = () => selectAnnotation(ann.id);
          return (
            <AnnotationMotionListItem
              key={ann.id}
              layoutKey={ann.id}
              className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
              style={getAnnotationItemStyle(activeLabel?.color)}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`选择标注 ${idx + 1}`}
              onClick={selectItem}
              onKeyDown={handleAnnotationItemKeyDown(selectItem)}
            >
              <AnnotationListRow
                index={idx}
                labelId={ann.labelId}
                labels={project.labels}
                onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                onDelete={() => deleteAnnotation(ann.id)}
                suffix={`[${ann.start}-${ann.end}]`}
              />
            </AnnotationMotionListItem>
          );
        })}
      </AnnotationMotionList>
    </VscodeScrollHost>
  );
}

function renderTextClassificationWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  textClassificationAnnotations: TextClassificationAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  updateAnnotationLabel: (annotationId: string, labelId: string) => void,
  deleteAnnotation: (annotationId: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择项目内的文本文件。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }

  if (textClassificationAnnotations.length === 0) {
    return <p className="annotation-right-muted">未分配分类标签。</p>;
  }

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      <AnnotationMotionList className="annotation-right-items">
        {textClassificationAnnotations.map((ann, idx) => {
          const selected = ann.id === selectedAnnotationId;
          const activeLabel = project.labels.find((l) => l.id === ann.labelId);
          const selectItem = () => selectAnnotation(ann.id);
          return (
            <AnnotationMotionListItem
              key={ann.id}
              layoutKey={ann.id}
              className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
              style={getAnnotationItemStyle(activeLabel?.color)}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`选择分类 ${idx + 1}`}
              onClick={selectItem}
              onKeyDown={handleAnnotationItemKeyDown(selectItem)}
            >
              <AnnotationListRow
                index={idx}
                labelId={ann.labelId}
                labels={project.labels}
                onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                onDelete={() => deleteAnnotation(ann.id)}
              />
            </AnnotationMotionListItem>
          );
        })}
      </AnnotationMotionList>
    </VscodeScrollHost>
  );
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function renderTextEntryDeleteButton(
  annId: string,
  deleteAnnotation: (id: string) => void,
  ariaLabel: string,
): ReactElement {
  return (
    <VscodeButton
      secondary
      icon="trash"
      iconOnly
      type="button"
      className="annotation-right-label-more-btn annotation-right-item-label-more-btn annotation-right-delete vscode-btn-danger"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        deleteAnnotation(annId);
      }}
    />
  );
}

function renderInstructionWorkspaceBody(
  workspaceEnabled: boolean,
  loadError: string | null,
  instructionAnnotations: InstructionAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  deleteAnnotation: (id: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择项目内的文本文件。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }
  if (instructionAnnotations.length === 0) {
    return <p className="annotation-right-muted">暂无条目，请在编辑区添加。</p>;
  }
  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      <AnnotationMotionList className="annotation-right-items">
        {instructionAnnotations.map((ann, idx) => {
          const selected = ann.id === selectedAnnotationId;
          const selectItem = () => selectAnnotation(selected ? null : ann.id);
          return (
            <AnnotationMotionListItem
              key={ann.id}
              layoutKey={ann.id}
              className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
              style={getAnnotationItemStyle()}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`选择指令条目 ${idx + 1}`}
              onClick={selectItem}
              onKeyDown={handleAnnotationItemKeyDown(selectItem)}
            >
              <div className="annotation-right-item-row">
                <div className="annotation-right-item-label-group">
                  <span className="annotation-right-item-main">
                    <span className="annotation-right-index">#{idx + 1}</span>
                  </span>
                  <p className="annotation-right-caption-summary">
                    {truncateText(ann.instruction, 60)}
                  </p>
                  <p className="annotation-right-text-entry-meta">
                    Output: {truncateText(ann.output, 48)}
                  </p>
                </div>
                {renderTextEntryDeleteButton(
                  ann.id,
                  deleteAnnotation,
                  `删除指令条目 ${idx + 1}`,
                )}
              </div>
            </AnnotationMotionListItem>
          );
        })}
      </AnnotationMotionList>
    </VscodeScrollHost>
  );
}

function renderPreferenceWorkspaceBody(
  workspaceEnabled: boolean,
  loadError: string | null,
  preferenceAnnotations: PreferenceAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  deleteAnnotation: (id: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择项目内的文本文件。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }
  if (preferenceAnnotations.length === 0) {
    return <p className="annotation-right-muted">暂无条目，请在编辑区添加。</p>;
  }
  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      <AnnotationMotionList className="annotation-right-items">
        {preferenceAnnotations.map((ann, idx) => {
          const selected = ann.id === selectedAnnotationId;
          const selectItem = () => selectAnnotation(selected ? null : ann.id);
          return (
            <AnnotationMotionListItem
              key={ann.id}
              layoutKey={ann.id}
              className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
              style={getAnnotationItemStyle()}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`选择偏好条目 ${idx + 1}`}
              onClick={selectItem}
              onKeyDown={handleAnnotationItemKeyDown(selectItem)}
            >
              <div className="annotation-right-item-row">
                <div className="annotation-right-item-label-group">
                  <span className="annotation-right-item-main">
                    <span className="annotation-right-index">#{idx + 1}</span>
                  </span>
                  <p className="annotation-right-caption-summary">
                    {truncateText(ann.prompt, 60)}
                  </p>
                  <p className="annotation-right-text-entry-meta annotation-right-text-entry-meta--chosen">
                    Chosen: {truncateText(ann.chosen, 40)}
                  </p>
                  <p className="annotation-right-text-entry-meta annotation-right-text-entry-meta--rejected">
                    Rejected: {truncateText(ann.rejected, 40)}
                  </p>
                </div>
                {renderTextEntryDeleteButton(
                  ann.id,
                  deleteAnnotation,
                  `删除偏好条目 ${idx + 1}`,
                )}
              </div>
            </AnnotationMotionListItem>
          );
        })}
      </AnnotationMotionList>
    </VscodeScrollHost>
  );
}

function renderConversationWorkspaceBody(
  workspaceEnabled: boolean,
  loadError: string | null,
  conversationAnnotations: ConversationAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  deleteAnnotation: (id: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择项目内的文本文件。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }
  if (conversationAnnotations.length === 0) {
    return <p className="annotation-right-muted">暂无条目，请在编辑区添加。</p>;
  }
  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      <AnnotationMotionList className="annotation-right-items">
        {conversationAnnotations.map((ann, idx) => {
          const firstUser =
            ann.turns.find((t) => t.role === 'user')?.content ??
            ann.turns[0]?.content ??
            '';
          const selected = ann.id === selectedAnnotationId;
          const selectItem = () => selectAnnotation(selected ? null : ann.id);
          return (
            <AnnotationMotionListItem
              key={ann.id}
              layoutKey={ann.id}
              className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
              style={getAnnotationItemStyle()}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`选择对话条目 ${idx + 1}`}
              onClick={selectItem}
              onKeyDown={handleAnnotationItemKeyDown(selectItem)}
            >
              <div className="annotation-right-item-row">
                <div className="annotation-right-item-label-group">
                  <span className="annotation-right-item-main">
                    <span className="annotation-right-index">
                      #{idx + 1} · {ann.turns.length} 轮
                    </span>
                  </span>
                  <p className="annotation-right-caption-summary">
                    {truncateText(firstUser, 60)}
                  </p>
                </div>
                {renderTextEntryDeleteButton(
                  ann.id,
                  deleteAnnotation,
                  `删除对话条目 ${idx + 1}`,
                )}
              </div>
            </AnnotationMotionListItem>
          );
        })}
      </AnnotationMotionList>
    </VscodeScrollHost>
  );
}

function renderCotWorkspaceBody(
  workspaceEnabled: boolean,
  loadError: string | null,
  cotAnnotations: CotAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  deleteAnnotation: (id: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择项目内的文本文件。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }
  if (cotAnnotations.length === 0) {
    return <p className="annotation-right-muted">暂无条目，请在编辑区添加。</p>;
  }
  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      <AnnotationMotionList className="annotation-right-items">
        {cotAnnotations.map((ann, idx) => {
          const selected = ann.id === selectedAnnotationId;
          const selectItem = () => selectAnnotation(selected ? null : ann.id);
          return (
            <AnnotationMotionListItem
              key={ann.id}
              layoutKey={ann.id}
              className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
              style={getAnnotationItemStyle()}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`选择思维链条目 ${idx + 1}`}
              onClick={selectItem}
              onKeyDown={handleAnnotationItemKeyDown(selectItem)}
            >
              <div className="annotation-right-item-row">
                <div className="annotation-right-item-label-group">
                  <span className="annotation-right-item-main">
                    <span className="annotation-right-index">
                      #{idx + 1} · {ann.steps.length} 步
                    </span>
                  </span>
                  {ann.input ? (
                    <p className="annotation-right-text-entry-meta">
                      Input: {truncateText(ann.input, 48)}
                    </p>
                  ) : null}
                  <p className="annotation-right-caption-summary">
                    Answer: {truncateText(ann.answer, 48)}
                  </p>
                </div>
                {renderTextEntryDeleteButton(
                  ann.id,
                  deleteAnnotation,
                  `删除思维链条目 ${idx + 1}`,
                )}
              </div>
            </AnnotationMotionListItem>
          );
        })}
      </AnnotationMotionList>
    </VscodeScrollHost>
  );
}

export default function AnnotationRightPanel() {
  const { activeProject, openExportProject } = useAnnotation();
  const {
    annotationPanelVisible,
    workspaceEnabled,
    projectRootMatched,
    bboxAnnotations,
    rotatedBboxAnnotations,
    polygonAnnotations,
    poseAnnotations,
    pointAnnotations,
    captionAnnotations,
    classificationAnnotations,
    spanAnnotations,
    textClassificationAnnotations,
    instructionAnnotations,
    preferenceAnnotations,
    conversationAnnotations,
    cotAnnotations,
    textAnnotationType,
    textContent,
    textContentLoading,
    dirty,
    saving,
    loadError,
    sourceStale,
    selectedAnnotationId,
    selectAnnotation,
    setTool,
    activeLabelId,
    setActiveLabelId,
    labelUsage,
    deleteAnnotation,
    updateAnnotationLabel,
  } = useAnnotationWorkspace();

  if (!annotationPanelVisible || !activeProject) {
    return null;
  }

  if (!projectRootMatched) {
    return (
      <div className="annotation-right-root">
        <VscodeScrollHost
          className="annotation-right-scroll-host"
          scrollableClassName="annotation-right-scrollable"
        >
          <div className="annotation-right-placeholder">
            <VscodeIcon name="warning" size={36} />
            <VscodeLabel>工作区文件夹与标注任务目录不一致。</VscodeLabel>
            <p className="annotation-right-placeholder-hint">
              请先通过左侧「标注任务」打开该项目，以使资源管理器根目录指向任务文件夹。
            </p>
          </div>
        </VscodeScrollHost>
      </div>
    );
  }

  const isImageBbox =
    activeProject.modality === 'image' &&
    activeProject.annotationType === 'bbox';
  const isImagePolygon =
    activeProject.modality === 'image' &&
    activeProject.annotationType === 'polygon';
  const isImageRotatedBbox =
    activeProject.modality === 'image' &&
    activeProject.annotationType === 'rotated_bbox';
  const isImageKeypoint =
    activeProject.modality === 'image' &&
    activeProject.annotationType === 'keypoint';
  const isImageCaption =
    activeProject.modality === 'image' &&
    activeProject.annotationType === 'caption';
  const isImageClassification =
    activeProject.modality === 'image' &&
    activeProject.annotationType === 'classification';
  const isTextSpanNer =
    activeProject.modality === 'text' &&
    activeProject.annotationType === 'span_ner';
  const isTextClassification =
    activeProject.modality === 'text' &&
    activeProject.annotationType === 'text_classification';
  const isInstruction =
    activeProject.modality === 'text' &&
    activeProject.annotationType === 'instruction';
  const isPreference =
    activeProject.modality === 'text' &&
    activeProject.annotationType === 'preference';
  const isConversation =
    activeProject.modality === 'text' &&
    activeProject.annotationType === 'conversation';
  const isCot =
    activeProject.modality === 'text' && activeProject.annotationType === 'cot';
  const isTextLlm = isInstruction || isPreference || isConversation || isCot;
  const isImageAnnotatable =
    isImageBbox ||
    isImagePolygon ||
    isImageRotatedBbox ||
    isImageKeypoint ||
    isImageCaption ||
    isImageClassification;
  const isTextAnnotatable =
    isTextSpanNer ||
    isTextClassification ||
    isInstruction ||
    isPreference ||
    isConversation ||
    isCot;

  if (!isImageAnnotatable && !isTextAnnotatable) {
    const modalityLabel = TASK_TYPE_CONFIG[activeProject.modality].label;
    const kindLabel = getAnnotationTypeLabel(
      activeProject.modality,
      activeProject.annotationType,
    );
    return (
      <div className="annotation-right-root">
        <VscodeScrollHost
          className="annotation-right-scroll-host"
          scrollableClassName="annotation-right-scrollable"
        >
          <div className="annotation-right-placeholder">
            <VscodeIcon name="tag" size={36} />
            <VscodeLabel>
              {modalityLabel} · {kindLabel}
            </VscodeLabel>
            <p className="annotation-right-placeholder-hint">
              画布与列表标注即将支持当前类型。
            </p>
          </div>
        </VscodeScrollHost>
      </div>
    );
  }

  let statusMessage = '已保存';
  if (saving) statusMessage = '保存中…';
  else if (dirty) statusMessage = '未保存更改';

  return (
    <div className="annotation-right-root">
      <header className="annotation-right-header">
        <div className="annotation-right-header-main">
          <span className="annotation-right-status">{statusMessage}</span>
          {sourceStale && (
            <span
              className="annotation-right-warning"
              title="源文件可能与上次保存时不同"
            >
              文件已变更
            </span>
          )}
        </div>
        <div className="annotation-right-header-actions">
          <VscodeButton
            secondary
            icon="export"
            type="button"
            className="annotation-right-export-btn"
            onClick={() => {
              if (activeProject) openExportProject(activeProject);
            }}
          >
            导出标注
          </VscodeButton>
        </div>
      </header>

      {!isTextLlm && (
        <section className="annotation-right-section">
          {isImageKeypoint ? (
            <>
              <h4 className="annotation-right-heading">骨架模板</h4>
              <KeypointTemplateSelector />
              <p className="annotation-right-muted annotation-right-template-note">
                放置骨架时自动使用模板对应标签（如 person / hand / face）。
              </p>
            </>
          ) : isImageCaption ? (
            <h4 className="annotation-right-heading">图片内容描述</h4>
          ) : isTextSpanNer || isTextClassification ? (
            <>
              <h4 className="annotation-right-heading">标注用标签</h4>
              {activeProject.labels.length === 0 ? (
                <p className="annotation-right-muted">
                  未定义标签。请在「标注任务」中编辑项目并添加类别。
                </p>
              ) : (
                <AnnotationDrawLabelPicker
                  className="annotation-right-chip-row"
                  variant="panel"
                  labels={activeProject.labels}
                  labelUsage={labelUsage}
                  activeLabelId={activeLabelId}
                  onSelect={setActiveLabelId}
                />
              )}
            </>
          ) : (
            <>
              <h4 className="annotation-right-heading">绘制用标签</h4>
              {activeProject.labels.length === 0 ? (
                <p className="annotation-right-muted">
                  未定义标签。请在「标注任务」中编辑项目并添加类别。
                </p>
              ) : (
                <AnnotationDrawLabelPicker
                  className="annotation-right-chip-row"
                  variant="panel"
                  labels={activeProject.labels}
                  labelUsage={labelUsage}
                  activeLabelId={activeLabelId}
                  onSelect={setActiveLabelId}
                />
              )}
            </>
          )}
        </section>
      )}

      <section className="annotation-right-section annotation-right-section--grow">
        <h4 className="annotation-right-heading">
          {isImageKeypoint
            ? '当前图片关键点'
            : isImagePolygon
              ? '当前图片多边形'
              : isImageRotatedBbox
                ? '当前图片旋转矩形框'
                : isImageCaption
                  ? '当前图片描述'
                  : isImageClassification
                    ? '当前图片分类'
                    : isTextSpanNer
                      ? '当前文本实体标注'
                      : isTextClassification
                        ? '当前文本分类'
                        : '数据集条目'}
        </h4>
        {isImageKeypoint
          ? renderKeypointWorkspaceBody(
              activeProject,
              workspaceEnabled,
              loadError,
              poseAnnotations,
              pointAnnotations,
              selectedAnnotationId,
              selectAnnotation,
              setTool,
              updateAnnotationLabel,
              deleteAnnotation,
            )
          : isImagePolygon
            ? renderPolygonWorkspaceBody(
                activeProject,
                workspaceEnabled,
                loadError,
                polygonAnnotations,
                selectedAnnotationId,
                selectAnnotation,
                setTool,
                updateAnnotationLabel,
                deleteAnnotation,
              )
            : isImageRotatedBbox
              ? renderRotatedBboxWorkspaceBody(
                  activeProject,
                  workspaceEnabled,
                  loadError,
                  rotatedBboxAnnotations,
                  selectedAnnotationId,
                  selectAnnotation,
                  setTool,
                  updateAnnotationLabel,
                  deleteAnnotation,
                )
              : isImageCaption
                ? renderCaptionWorkspaceBody(
                    activeProject,
                    workspaceEnabled,
                    loadError,
                    captionAnnotations,
                    selectedAnnotationId,
                    selectAnnotation,
                    deleteAnnotation,
                  )
                : isImageClassification
                  ? renderClassificationWorkspaceBody(
                      activeProject,
                      workspaceEnabled,
                      loadError,
                      classificationAnnotations,
                      selectedAnnotationId,
                      selectAnnotation,
                      updateAnnotationLabel,
                      deleteAnnotation,
                    )
                  : isTextSpanNer
                    ? renderSpanNerWorkspaceBody(
                        activeProject,
                        workspaceEnabled,
                        loadError,
                        spanAnnotations,
                        selectedAnnotationId,
                        selectAnnotation,
                        updateAnnotationLabel,
                        deleteAnnotation,
                      )
                    : isTextClassification
                      ? renderTextClassificationWorkspaceBody(
                          activeProject,
                          workspaceEnabled,
                          loadError,
                          textClassificationAnnotations,
                          selectedAnnotationId,
                          selectAnnotation,
                          updateAnnotationLabel,
                          deleteAnnotation,
                        )
                      : isInstruction
                        ? renderInstructionWorkspaceBody(
                            workspaceEnabled,
                            loadError,
                            instructionAnnotations,
                            selectedAnnotationId,
                            selectAnnotation,
                            deleteAnnotation,
                          )
                        : isPreference
                          ? renderPreferenceWorkspaceBody(
                              workspaceEnabled,
                              loadError,
                              preferenceAnnotations,
                              selectedAnnotationId,
                              selectAnnotation,
                              deleteAnnotation,
                            )
                          : isConversation
                            ? renderConversationWorkspaceBody(
                                workspaceEnabled,
                                loadError,
                                conversationAnnotations,
                                selectedAnnotationId,
                                selectAnnotation,
                                deleteAnnotation,
                              )
                            : isCot
                              ? renderCotWorkspaceBody(
                                  workspaceEnabled,
                                  loadError,
                                  cotAnnotations,
                                  selectedAnnotationId,
                                  selectAnnotation,
                                  deleteAnnotation,
                                )
                              : renderBboxWorkspaceBody(
                                  activeProject,
                                  workspaceEnabled,
                                  loadError,
                                  bboxAnnotations,
                                  selectedAnnotationId,
                                  selectAnnotation,
                                  updateAnnotationLabel,
                                  deleteAnnotation,
                                )}
      </section>
    </div>
  );
}
