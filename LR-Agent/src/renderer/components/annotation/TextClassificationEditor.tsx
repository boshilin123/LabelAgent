import { useCallback, useMemo } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { getLabelChipStyle } from '../../utils/labelColor';
import './TextClassificationEditor.css';

export default function TextClassificationEditor() {
  const { activeProject } = useAnnotation();
  const {
    workspaceEnabled,
    relativeFilePath,
    textContent,
    textContentLoading,
    textClassificationAnnotations,
    addTextClassificationAnnotation,
    updateTextClassificationAnnotation,
    deleteAnnotation,
  } = useAnnotationWorkspace();

  const labels = activeProject?.labels ?? [];

  // 已分配的 labelId 集合（允许重复分配不同实例，但默认列表展示已分配的 labelId）
  // 这里我们展示所有已创建的分类标注实例（多个实例可以有不同 labelId）
  const assigned = textClassificationAnnotations;

  const handleAssign = useCallback(
    (labelId: string) => {
      addTextClassificationAnnotation(labelId);
    },
    [addTextClassificationAnnotation],
  );

  const handleChange = useCallback(
    (annId: string, newLabelId: string) => {
      updateTextClassificationAnnotation(annId, newLabelId);
    },
    [updateTextClassificationAnnotation],
  );

  const handleRemove = useCallback(
    (annId: string) => {
      deleteAnnotation(annId);
    },
    [deleteAnnotation],
  );

  if (!workspaceEnabled) {
    return (
      <div className="text-classification-editor">
        <div className="text-classification-empty">
          <VscodeIcon name="info" size={36} />
          <p>请在资源管理器中选择项目内的文本文件。</p>
        </div>
      </div>
    );
  }

  if (textContentLoading) {
    return (
      <div className="text-classification-editor">
        <div className="text-classification-empty">
          <p>加载文本内容…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="text-classification-editor">
      {/* 工具栏 */}
      <div className="text-classification-toolbar">
        <span
          className="text-classification-file-path"
          title={relativeFilePath ?? ''}
        >
          {relativeFilePath ?? '无文件'}
        </span>
        <span className="text-classification-stats">
          {assigned.length} 个分类标签
        </span>
      </div>

      {/* 主内容区：左侧文本预览，右侧分类面板 */}
      <div className="text-classification-body">
        {/* 文本预览 */}
        <div className="text-classification-text-panel">
          <div className="text-classification-text-scroll">
            <pre className="text-classification-text-content">
              {textContent || '无文本内容'}
            </pre>
          </div>
        </div>

        {/* 分类面板 */}
        <div className="text-classification-labels-panel">
          {/* 已分配标签 */}
          <div className="text-classification-section">
            <h4 className="text-classification-heading">已分配标签</h4>
            {assigned.length === 0 ? (
              <p className="text-classification-muted">未分配任何标签。</p>
            ) : (
              <div className="text-classification-assigned-list">
                {assigned.map((ann, idx) => {
                  const currentLabel = labels.find((l) => l.id === ann.labelId);
                  const otherLabels = labels.filter(
                    (l) => l.id !== ann.labelId,
                  );
                  return (
                    <div
                      key={ann.id}
                      className="text-classification-assigned-item"
                    >
                      <span className="text-classification-index">
                        #{idx + 1}
                      </span>
                      {currentLabel ? (
                        <span
                          className="text-classification-chip"
                          style={getLabelChipStyle(currentLabel.color)}
                        >
                          {currentLabel.name}
                        </span>
                      ) : (
                        <span className="text-classification-unknown">
                          未知标签
                        </span>
                      )}
                      <div className="text-classification-assigned-actions">
                        {otherLabels.length > 0 && (
                          <select
                            className="text-classification-label-select"
                            value=""
                            onChange={(e) => {
                              if (e.target.value) {
                                handleChange(ann.id, e.target.value);
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

          {/* 可选标签 */}
          {labels.length > 0 && (
            <div className="text-classification-section">
              <h4 className="text-classification-heading">可选标签</h4>
              <div className="text-classification-available-list">
                {labels.map((label) => (
                  <button
                    key={label.id}
                    type="button"
                    className="text-classification-label-btn"
                    style={
                      {
                        borderColor: label.color,
                        '--label-color': label.color,
                      } as React.CSSProperties
                    }
                    onClick={() => handleAssign(label.id)}
                  >
                    <span
                      className="text-classification-label-dot"
                      style={{ background: label.color }}
                    />
                    {label.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {labels.length === 0 && (
            <div className="text-classification-section">
              <p className="text-classification-muted">
                未定义标签。请在「标注任务」中编辑项目并添加类别。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
