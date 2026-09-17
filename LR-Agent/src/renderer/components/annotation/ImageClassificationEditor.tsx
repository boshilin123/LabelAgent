import { useCallback, useMemo } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import ImageAnnotationToolbar from './ImageAnnotationToolbar';
import './ImageClassificationEditor.css';

interface ImageClassificationEditorProps {
  imageUrl: string;
  imagePath: string;
}

export default function ImageClassificationEditor({
  imageUrl,
  imagePath,
}: ImageClassificationEditorProps) {
  const { activeProject } = useAnnotation();
  const {
    classificationAnnotations,
    addClassificationAnnotation,
    updateClassificationAnnotation,
    deleteAnnotation,
  } = useAnnotationWorkspace();

  const labels = activeProject?.labels ?? [];

  const assignedIds = useMemo(
    () =>
      new Set(
        classificationAnnotations
          .map((a) => a.labelId)
          .filter(Boolean) as string[],
      ),
    [classificationAnnotations],
  );

  const availableLabels = useMemo(
    () => labels.filter((l) => !assignedIds.has(l.id)),
    [labels, assignedIds],
  );

  const handleAssignLabel = useCallback(
    (labelId: string) => {
      addClassificationAnnotation(labelId);
    },
    [addClassificationAnnotation],
  );

  const handleChangeLabel = useCallback(
    (annId: string, currentLabelId: string, newLabelId: string) => {
      updateClassificationAnnotation(annId, newLabelId);
    },
    [updateClassificationAnnotation],
  );

  const handleRemove = useCallback(
    (annId: string) => {
      deleteAnnotation(annId);
    },
    [deleteAnnotation],
  );

  if (!activeProject) return null;

  return (
    <div className="image-classification-editor">
      <ImageAnnotationToolbar mode="classification" imagePath={imagePath} />

      <div className="image-classification-body">
        <div className="image-classification-preview">
          <img
            src={imageUrl}
            alt="标注图片预览"
            className="image-classification-preview-img"
          />
        </div>

        <div className="image-classification-panel">
          <div className="image-classification-panel-section">
            <h4 className="image-classification-panel-heading">已分配标签</h4>
            {classificationAnnotations.length === 0 ? (
              <p className="image-classification-empty">未分配任何标签。</p>
            ) : (
              <div className="image-classification-assigned-list">
                {classificationAnnotations.map((ann) => {
                  const currentLabel = labels.find((l) => l.id === ann.labelId);
                  const otherLabels = labels.filter(
                    (l) => l.id !== ann.labelId,
                  );
                  return (
                    <div
                      key={ann.id}
                      className="image-classification-assigned-item"
                    >
                      <span className="image-classification-assigned-index">
                        #{classificationAnnotations.indexOf(ann) + 1}
                      </span>
                      {currentLabel ? (
                        <span
                          className="image-classification-chip"
                          style={{
                            background: currentLabel.color,
                            color: '#ffffff',
                          }}
                        >
                          {currentLabel.name}
                        </span>
                      ) : (
                        <span className="image-classification-unknown">
                          未知标签
                        </span>
                      )}
                      <div className="image-classification-assigned-actions">
                        {otherLabels.length > 0 && (
                          <select
                            className="image-classification-label-select"
                            value=""
                            onChange={(e) => {
                              if (e.target.value) {
                                handleChangeLabel(
                                  ann.id,
                                  ann.labelId ?? '',
                                  e.target.value,
                                );
                                e.target.value = '';
                              }
                            }}
                          >
                            <option value="">切换标签…</option>
                            {otherLabels.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <VscodeButton
                          secondary
                          onClick={() => handleRemove(ann.id)}
                          title="删除此分类"
                        >
                          移除
                        </VscodeButton>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {availableLabels.length > 0 && (
            <div className="image-classification-panel-section">
              <h4 className="image-classification-panel-heading">可选标签</h4>
              <div className="image-classification-available-list">
                {availableLabels.map((label) => (
                  <button
                    key={label.id}
                    type="button"
                    className="image-classification-label-btn"
                    style={
                      {
                        borderColor: label.color,
                        '--label-color': label.color,
                      } as React.CSSProperties
                    }
                    onClick={() => handleAssignLabel(label.id)}
                  >
                    <span
                      className="image-classification-label-dot"
                      style={{ background: label.color }}
                    />
                    {label.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {labels.length === 0 && (
            <div className="image-classification-panel-section">
              <p className="image-classification-empty">
                未定义标签。请在「标注任务」中编辑项目并添加类别。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
