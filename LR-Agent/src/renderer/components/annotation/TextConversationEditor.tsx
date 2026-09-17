import { useCallback, useEffect, useMemo, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import type { ConversationRole } from '../../types/annotationDocument';
import TextSourcePreviewPanel from './TextSourcePreviewPanel';
import './TextInstructionEditor.css';
import './TextConversationEditor.css';

interface EditableTurn {
  role: ConversationRole;
  content: string;
}

export default function TextConversationEditor() {
  const {
    workspaceEnabled,
    freeformMode,
    selectedAnnotationId,
    selectAnnotation,
    conversationAnnotations,
    addConversationAnnotation,
    updateConversationAnnotation,
  } = useAnnotationWorkspace();

  const editingAnn = useMemo(
    () =>
      conversationAnnotations.find((ann) => ann.id === selectedAnnotationId) ??
      null,
    [conversationAnnotations, selectedAnnotationId],
  );
  const isEditing = Boolean(editingAnn);
  const editingIndex = editingAnn
    ? conversationAnnotations.findIndex((ann) => ann.id === editingAnn.id) + 1
    : 0;

  const [turns, setTurns] = useState<EditableTurn[]>([]);

  useEffect(() => {
    if (editingAnn) {
      setTurns(editingAnn.turns.map((turn) => ({ ...turn })));
    } else {
      setTurns([]);
    }
  }, [editingAnn]);

  const addTurn = useCallback((role: ConversationRole) => {
    setTurns((prev) => [...prev, { role, content: '' }]);
  }, []);

  const updateTurnContent = useCallback((index: number, content: string) => {
    setTurns((prev) =>
      prev.map((turn, i) => (i === index ? { ...turn, content } : turn)),
    );
  }, []);

  const updateTurnRole = useCallback(
    (index: number, role: ConversationRole) => {
      setTurns((prev) =>
        prev.map((turn, i) => (i === index ? { ...turn, role } : turn)),
      );
    },
    [],
  );

  const removeTurn = useCallback((index: number) => {
    setTurns((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAdd = useCallback(() => {
    const valid = turns.filter((turn) => turn.content.trim());
    if (valid.length === 0) return;
    addConversationAnnotation({ turns: valid });
    setTurns([]);
    selectAnnotation(null);
  }, [turns, addConversationAnnotation, selectAnnotation]);

  const handleSave = useCallback(() => {
    if (!editingAnn) return;
    const valid = turns.filter((turn) => turn.content.trim());
    if (valid.length === 0) return;
    updateConversationAnnotation(editingAnn.id, valid);
    selectAnnotation(null);
  }, [editingAnn, turns, updateConversationAnnotation, selectAnnotation]);

  const handleCancel = useCallback(() => {
    selectAnnotation(null);
  }, [selectAnnotation]);

  const handleQuoteSelection = useCallback((text: string) => {
    setTurns((prev) => [
      ...prev,
      { role: 'user' as ConversationRole, content: text },
    ]);
  }, []);

  const handleQuoteFull = useCallback((text: string) => {
    setTurns((prev) => {
      if (prev.length === 0) {
        return [{ role: 'user' as ConversationRole, content: text }];
      }
      return [...prev, { role: 'user' as ConversationRole, content: text }];
    });
  }, []);

  const renderTurnEditor = (
    turnList: EditableTurn[],
    onContentChange: (idx: number, content: string) => void,
    onRoleChange: (idx: number, role: ConversationRole) => void,
    onRemove: (idx: number) => void,
    onAdd: (role: ConversationRole) => void,
  ) => (
    <div className="text-conv-turn-list">
      {turnList.map((turn, idx) => (
        <div
          key={idx}
          className={`text-conv-turn text-conv-turn--${turn.role}`}
        >
          <div className="text-conv-turn-header">
            <select
              className="text-conv-role-select"
              value={turn.role}
              onChange={(e) =>
                onRoleChange(idx, e.target.value as ConversationRole)
              }
            >
              <option value="user">User</option>
              <option value="assistant">Assistant</option>
            </select>
            <span className="text-conv-turn-index">#{idx + 1}</span>
            <VscodeButton secondary onClick={() => onRemove(idx)}>
              删除
            </VscodeButton>
          </div>
          <textarea
            className="text-lfm-textarea"
            value={turn.content}
            onChange={(e) => onContentChange(idx, e.target.value)}
            placeholder={turn.role === 'user' ? '用户消息…' : '助手回复…'}
            rows={3}
          />
        </div>
      ))}
      <div className="text-conv-add-turn">
        <VscodeButton secondary onClick={() => onAdd('user')}>
          + 添加 User
        </VscodeButton>
        <VscodeButton secondary onClick={() => onAdd('assistant')}>
          + 添加 Assistant
        </VscodeButton>
      </div>
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
        <span className="text-lfm-title">多轮对话数据集标注</span>
        <span className="text-lfm-stats">
          {conversationAnnotations.length} 条对话
        </span>
      </div>

      {freeformMode && (
        <div className="text-lfm-freeform-banner">
          自由标注模式 - 选择一个文本文件可将其内容作为标注参考
        </div>
      )}

      <div className="text-lfm-body">
        <TextSourcePreviewPanel
          onQuoteSelection={handleQuoteSelection}
          onQuoteFull={handleQuoteFull}
          quoteSelectionLabel="引用为 User 消息"
          quoteFullLabel="全文为 User 消息"
        />

        <div className="text-lfm-workspace">
          <div className="text-lfm-form">
            <h4 className="text-lfm-heading">
              {isEditing ? `编辑条目 #${editingIndex}` : '新增对话'}
            </h4>
            {renderTurnEditor(
              turns,
              updateTurnContent,
              updateTurnRole,
              removeTurn,
              addTurn,
            )}
            <div className="text-lfm-form-actions">
              {isEditing ? (
                <>
                  <VscodeButton
                    disabled={!turns.some((turn) => turn.content.trim())}
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
                  disabled={!turns.some((turn) => turn.content.trim())}
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
