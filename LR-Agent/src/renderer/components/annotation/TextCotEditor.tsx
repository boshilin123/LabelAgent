import { useCallback, useEffect, useMemo, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import TextSourcePreviewPanel from './TextSourcePreviewPanel';
import './TextInstructionEditor.css';
import './TextCotEditor.css';

interface EditableStep {
  description: string;
  conclusion: string;
}

const DEFAULT_STEPS: EditableStep[] = [{ description: '', conclusion: '' }];

export default function TextCotEditor() {
  const {
    workspaceEnabled,
    freeformMode,
    selectedAnnotationId,
    selectAnnotation,
    cotAnnotations,
    addCotAnnotation,
    updateCotAnnotation,
  } = useAnnotationWorkspace();

  const editingAnn = useMemo(
    () => cotAnnotations.find((ann) => ann.id === selectedAnnotationId) ?? null,
    [cotAnnotations, selectedAnnotationId],
  );
  const isEditing = Boolean(editingAnn);
  const editingIndex = editingAnn
    ? cotAnnotations.findIndex((ann) => ann.id === editingAnn.id) + 1
    : 0;

  const [instruction, setInstruction] = useState('');
  const [input, setInput] = useState('');
  const [steps, setSteps] = useState<EditableStep[]>(DEFAULT_STEPS);
  const [answer, setAnswer] = useState('');

  useEffect(() => {
    if (editingAnn) {
      setInstruction(editingAnn.instruction || '');
      setInput(editingAnn.input || '');
      setSteps(editingAnn.steps.map((step) => ({ ...step })));
      setAnswer(editingAnn.answer);
    } else {
      setInstruction('');
      setInput('');
      setSteps(DEFAULT_STEPS);
      setAnswer('');
    }
  }, [editingAnn]);

  const addStep = useCallback(() => {
    setSteps((prev) => [...prev, { description: '', conclusion: '' }]);
  }, []);

  const updateStep = useCallback(
    (index: number, field: 'description' | 'conclusion', value: string) => {
      setSteps((prev) =>
        prev.map((step, i) =>
          i === index ? { ...step, [field]: value } : step,
        ),
      );
    },
    [],
  );

  const removeStep = useCallback((index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const hasValidSteps = steps.some(
    (step) => step.description.trim() && step.conclusion.trim(),
  );

  const handleAdd = useCallback(() => {
    const validSteps = steps.filter(
      (step) => step.description.trim() && step.conclusion.trim(),
    );
    if (validSteps.length === 0 || !answer.trim()) return;
    addCotAnnotation({
      instruction: instruction.trim() || undefined,
      input: input.trim() || undefined,
      steps: validSteps,
      answer: answer.trim(),
    });
    setInstruction('');
    setInput('');
    setSteps(DEFAULT_STEPS);
    setAnswer('');
    selectAnnotation(null);
  }, [instruction, input, steps, answer, addCotAnnotation, selectAnnotation]);

  const handleSave = useCallback(() => {
    if (!editingAnn) return;
    const validSteps = steps.filter(
      (step) => step.description.trim() && step.conclusion.trim(),
    );
    if (validSteps.length === 0 || !answer.trim()) return;
    updateCotAnnotation(editingAnn.id, {
      instruction: instruction.trim() || undefined,
      input: input.trim() || undefined,
      steps: validSteps,
      answer: answer.trim(),
    });
    selectAnnotation(null);
  }, [
    editingAnn,
    instruction,
    input,
    steps,
    answer,
    updateCotAnnotation,
    selectAnnotation,
  ]);

  const handleCancel = useCallback(() => {
    selectAnnotation(null);
  }, [selectAnnotation]);

  const renderStepsEditor = (
    stepList: EditableStep[],
    onUpdate: (
      idx: number,
      field: 'description' | 'conclusion',
      value: string,
    ) => void,
    onRemove: (idx: number) => void,
    onAdd: () => void,
  ) => (
    <div className="text-cot-steps">
      {stepList.map((step, idx) => (
        <div key={idx} className="text-cot-step">
          <div className="text-cot-step-header">
            <span className="text-cot-step-index">步骤 {idx + 1}</span>
            <VscodeButton secondary onClick={() => onRemove(idx)}>
              删除
            </VscodeButton>
          </div>
          <div className="text-lfm-field">
            <label className="text-lfm-label">推理描述</label>
            <textarea
              className="text-lfm-textarea text-lfm-textarea--compact"
              value={step.description}
              onChange={(e) => onUpdate(idx, 'description', e.target.value)}
              placeholder="这一步的推理过程…"
              rows={2}
            />
          </div>
          <div className="text-lfm-field">
            <label className="text-lfm-label">中间结论</label>
            <textarea
              className="text-lfm-textarea text-lfm-textarea--compact"
              value={step.conclusion}
              onChange={(e) => onUpdate(idx, 'conclusion', e.target.value)}
              placeholder="这一步得出的结论…"
              rows={2}
            />
          </div>
        </div>
      ))}
      <VscodeButton secondary onClick={onAdd}>
        + 添加步骤
      </VscodeButton>
    </div>
  );

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
        <span className="text-lfm-title">思维链数据集标注</span>
        <span className="text-lfm-stats">{cotAnnotations.length} 条思维链</span>
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
              {isEditing ? `编辑条目 #${editingIndex}` : '新增思维链条目'}
            </h4>
            <div className="text-lfm-field">
              <label className="text-lfm-label">Instruction（可选）</label>
              <textarea
                className="text-lfm-textarea text-lfm-textarea--compact"
                placeholder="任务指令，如：请逐步推理以下问题"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={2}
              />
            </div>
            <div className="text-lfm-field">
              <label className="text-lfm-label">Input（问题描述）*</label>
              <textarea
                className="text-lfm-textarea text-lfm-textarea--source"
                placeholder="输入问题或需要推理的内容"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={3}
              />
            </div>
            <div className="text-lfm-field">
              <label className="text-lfm-label">推理步骤</label>
              {renderStepsEditor(steps, updateStep, removeStep, addStep)}
            </div>
            <div className="text-lfm-field">
              <label className="text-lfm-label">最终答案 *</label>
              <textarea
                className="text-lfm-textarea"
                placeholder="推理得出的最终答案"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={3}
              />
            </div>
            <div className="text-lfm-form-actions">
              {isEditing ? (
                <>
                  <VscodeButton
                    disabled={!hasValidSteps || !answer.trim()}
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
                  disabled={!hasValidSteps || !answer.trim()}
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
