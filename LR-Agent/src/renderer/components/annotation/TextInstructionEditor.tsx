import { useCallback, useEffect, useMemo, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import TextSourcePreviewPanel from './TextSourcePreviewPanel';
import './TextInstructionEditor.css';

export default function TextInstructionEditor() {
  const {
    workspaceEnabled,
    freeformMode,
    selectedAnnotationId,
    selectAnnotation,
    instructionAnnotations,
    addInstructionAnnotation,
    updateInstructionAnnotation,
  } = useAnnotationWorkspace();

  const editingAnn = useMemo(
    () =>
      instructionAnnotations.find((ann) => ann.id === selectedAnnotationId) ??
      null,
    [instructionAnnotations, selectedAnnotationId],
  );
  const isEditing = Boolean(editingAnn);
  const editingIndex = editingAnn
    ? instructionAnnotations.findIndex((ann) => ann.id === editingAnn.id) + 1
    : 0;

  const [instruction, setInstruction] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');

  useEffect(() => {
    if (editingAnn) {
      setInstruction(editingAnn.instruction);
      setInput(editingAnn.input || '');
      setOutput(editingAnn.output);
    } else {
      setInstruction('');
      setInput('');
      setOutput('');
    }
  }, [editingAnn]);

  const handleAdd = useCallback(() => {
    if (!instruction.trim() || !output.trim()) return;
    addInstructionAnnotation({
      instruction: instruction.trim(),
      input: input.trim() || undefined,
      output: output.trim(),
    });
    setInstruction('');
    setInput('');
    setOutput('');
    selectAnnotation(null);
  }, [instruction, input, output, addInstructionAnnotation, selectAnnotation]);

  const handleSave = useCallback(() => {
    if (!editingAnn || !instruction.trim() || !output.trim()) return;
    updateInstructionAnnotation(editingAnn.id, {
      instruction: instruction.trim(),
      input: input.trim() || undefined,
      output: output.trim(),
    });
    selectAnnotation(null);
  }, [
    editingAnn,
    instruction,
    input,
    output,
    updateInstructionAnnotation,
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
        <span className="text-lfm-title">指令数据集标注</span>
        <span className="text-lfm-stats">
          {instructionAnnotations.length} 条指令
        </span>
      </div>

      {freeformMode && (
        <div className="text-lfm-freeform-banner">
          自由标注模式 - 选择一个文本文件可将其内容作为标注参考
        </div>
      )}

      <div className="text-lfm-body">
        <TextSourcePreviewPanel
          onQuoteSelection={setInput}
          onQuoteFull={setInput}
          quoteSelectionLabel="引用到 Input"
          quoteFullLabel="全文到 Input"
        />

        <div className="text-lfm-workspace">
          <div className="text-lfm-form">
            <h4 className="text-lfm-heading">
              {isEditing ? `编辑条目 #${editingIndex}` : '新增指令条目'}
            </h4>
            <div className="text-lfm-field">
              <label className="text-lfm-label">Instruction（任务指令）*</label>
              <textarea
                className="text-lfm-textarea"
                placeholder="输入任务指令，如：翻译以下文本为英文"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={3}
              />
            </div>
            <div className="text-lfm-field">
              <label className="text-lfm-label">Input（可选）</label>
              <textarea
                className="text-lfm-textarea text-lfm-textarea--source"
                placeholder="可选，输入上下文或原始文本"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={4}
              />
            </div>
            <div className="text-lfm-field">
              <label className="text-lfm-label">Output（标准答案）*</label>
              <textarea
                className="text-lfm-textarea text-lfm-textarea--large"
                placeholder="标准答案/期望输出"
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                rows={4}
              />
            </div>
            <div className="text-lfm-form-actions">
              {isEditing ? (
                <>
                  <VscodeButton
                    disabled={!instruction.trim() || !output.trim()}
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
                  disabled={!instruction.trim() || !output.trim()}
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
