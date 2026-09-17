import { useCallback, useEffect, useMemo, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import TextSourcePreviewPanel from './TextSourcePreviewPanel';
import './TextInstructionEditor.css';
import './TextPreferenceEditor.css';

export default function TextPreferenceEditor() {
  const {
    workspaceEnabled,
    freeformMode,
    selectedAnnotationId,
    selectAnnotation,
    preferenceAnnotations,
    addPreferenceAnnotation,
    updatePreferenceAnnotation,
  } = useAnnotationWorkspace();

  const editingAnn = useMemo(
    () =>
      preferenceAnnotations.find((ann) => ann.id === selectedAnnotationId) ??
      null,
    [preferenceAnnotations, selectedAnnotationId],
  );
  const isEditing = Boolean(editingAnn);
  const editingIndex = editingAnn
    ? preferenceAnnotations.findIndex((ann) => ann.id === editingAnn.id) + 1
    : 0;

  const [prompt, setPrompt] = useState('');
  const [chosen, setChosen] = useState('');
  const [rejected, setRejected] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (editingAnn) {
      setPrompt(editingAnn.prompt);
      setChosen(editingAnn.chosen);
      setRejected(editingAnn.rejected);
      setNote(editingAnn.preferenceNote || '');
    } else {
      setPrompt('');
      setChosen('');
      setRejected('');
      setNote('');
    }
  }, [editingAnn]);

  const handleAdd = useCallback(() => {
    if (!prompt.trim() || !chosen.trim() || !rejected.trim()) return;
    addPreferenceAnnotation({
      prompt: prompt.trim(),
      chosen: chosen.trim(),
      rejected: rejected.trim(),
      preferenceNote: note.trim() || undefined,
    });
    setPrompt('');
    setChosen('');
    setRejected('');
    setNote('');
    selectAnnotation(null);
  }, [
    prompt,
    chosen,
    rejected,
    note,
    addPreferenceAnnotation,
    selectAnnotation,
  ]);

  const handleSave = useCallback(() => {
    if (!editingAnn || !prompt.trim() || !chosen.trim() || !rejected.trim()) {
      return;
    }
    updatePreferenceAnnotation(editingAnn.id, {
      prompt: prompt.trim(),
      chosen: chosen.trim(),
      rejected: rejected.trim(),
      preferenceNote: note.trim() || undefined,
    });
    selectAnnotation(null);
  }, [
    editingAnn,
    prompt,
    chosen,
    rejected,
    note,
    updatePreferenceAnnotation,
    selectAnnotation,
  ]);

  const handleCancel = useCallback(() => {
    selectAnnotation(null);
  }, [selectAnnotation]);

  if (!workspaceEnabled) {
    return (
      <div className="text-lfm-editor">
        <div className="text-lfm-empty">
          <VscodeIcon name="info" size={36} />
          <p>请在资源管理器中选择项目内的文本文件。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="text-lfm-editor">
      <div className="text-lfm-toolbar">
        <span className="text-lfm-title">偏好数据集标注</span>
        <span className="text-lfm-stats">
          {preferenceAnnotations.length} 条偏好对
        </span>
      </div>

      {freeformMode && (
        <div className="text-lfm-freeform-banner">
          自由标注模式 - 选择一个文本文件可将其内容作为标注参考
        </div>
      )}

      <div className="text-lfm-body">
        <TextSourcePreviewPanel
          onQuoteSelection={setPrompt}
          onQuoteFull={setPrompt}
          quoteSelectionLabel="引用到 Prompt"
          quoteFullLabel="全文到 Prompt"
        />

        <div className="text-lfm-workspace">
          <div className="text-lfm-form">
            <h4 className="text-lfm-heading">
              {isEditing ? `编辑条目 #${editingIndex}` : '新增偏好条目'}
            </h4>
            <div className="text-lfm-field">
              <label className="text-lfm-label">Prompt *</label>
              <textarea
                className="text-lfm-textarea text-lfm-textarea--source"
                placeholder="输入 prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
              />
            </div>
            <div className="text-lfm-compare">
              <div className="text-lfm-compare-panel text-lfm-compare-chosen">
                <label className="text-lfm-label text-lfm-label--chosen">
                  Chosen（优选）*
                </label>
                <textarea
                  className="text-lfm-textarea text-lfm-textarea--large"
                  placeholder="更好的回答"
                  value={chosen}
                  onChange={(e) => setChosen(e.target.value)}
                  rows={5}
                />
              </div>
              <div className="text-lfm-compare-divider" />
              <div className="text-lfm-compare-panel text-lfm-compare-rejected">
                <label className="text-lfm-label text-lfm-label--rejected">
                  Rejected（劣选）*
                </label>
                <textarea
                  className="text-lfm-textarea text-lfm-textarea--large"
                  placeholder="较差的回答"
                  value={rejected}
                  onChange={(e) => setRejected(e.target.value)}
                  rows={5}
                />
              </div>
            </div>
            <div className="text-lfm-field">
              <label className="text-lfm-label">偏好理由（可选）</label>
              <textarea
                className="text-lfm-textarea text-lfm-textarea--compact"
                placeholder="可选，标注偏好原因"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
              />
            </div>
            <div className="text-lfm-form-actions">
              {isEditing ? (
                <>
                  <VscodeButton
                    disabled={
                      !prompt.trim() || !chosen.trim() || !rejected.trim()
                    }
                    onClick={handleSave}
                  >
                    保存
                  </VscodeButton>
                  <VscodeButton secondary onClick={handleCancel}>
                    取消
                  </VscodeButton>
                </>
              ) : (
                <VscodeButton
                  disabled={
                    !prompt.trim() || !chosen.trim() || !rejected.trim()
                  }
                  onClick={handleAdd}
                >
                  添加条目
                </VscodeButton>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
