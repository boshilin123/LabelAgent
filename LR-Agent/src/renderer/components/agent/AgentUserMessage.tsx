import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import type { ChatMessage } from '../../types/agent';
import { useAgentChat } from '../../context/AgentChatContext';
import { useStickyHeaderStuck } from './stickyHeaderStuck';
import './AgentComposer.css';

interface AgentUserMessageProps {
  message: ChatMessage;
}

export default function AgentUserMessage({ message }: AgentUserMessageProps) {
  const {
    editTargetMessageId,
    editDraft,
    setEditDraft,
    beginEditMessage,
    cancelEdit,
    sendMessage,
    isSessionStreaming,
  } = useAgentChat();

  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stuck = useStickyHeaderStuck(sentinelRef);
  const isEditing = editTargetMessageId === message.id;
  const userItemClassName = `agent-message-item agent-message-item--user${
    stuck ? ' agent-message-item--user-stuck' : ''
  }`;
  const streaming = isSessionStreaming(message.sessionId);
  const canEdit = message.status === 'done' && !streaming;

  const textContent = message.blocks
    .filter(
      (block): block is Extract<typeof block, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.content)
    .join('\n');

  useEffect(() => {
    if (!isEditing || !textareaRef.current) return;
    const el = textareaRef.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [isEditing]);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  const canSubmit = Boolean(editDraft.trim()) && !streaming;

  const handleSubmit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const trimmed = editDraft.trim();
      if (!trimmed || streaming) return;
      await sendMessage(trimmed, { editMessageId: message.id });
    },
    [editDraft, message.id, sendMessage, streaming],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // 输入法组合态（如中文拼音按 Enter 选字）不应触发提交/取消
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (canSubmit) {
          handleSubmit().catch(() => undefined);
        }
      }
    },
    [cancelEdit, canSubmit, handleSubmit],
  );

  return (
    <>
      <div
        ref={sentinelRef}
        className="agent-message-sticky-sentinel"
        aria-hidden="true"
      />
      <div
        ref={rootRef}
        className={userItemClassName}
        data-editing-bubble={isEditing ? 'true' : undefined}
      >
        {isEditing ? (
          <form
            className="agent-user-bubble agent-user-bubble--editing"
            onSubmit={handleSubmit}
          >
            <textarea
              ref={textareaRef}
              className="agent-user-bubble-input"
              value={editDraft}
              rows={1}
              onChange={(event) => {
                setEditDraft(event.target.value);
                resizeTextarea();
              }}
              onKeyDown={handleKeyDown}
            />
            <div className="agent-user-bubble-footer">
              <button
                type="submit"
                className={`agent-composer-send${
                  canSubmit ? ' agent-composer-send--ready' : ''
                }`}
                disabled={!canSubmit}
                aria-label="发送"
              >
                <span className="codicon codicon-arrow-up" />
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="agent-user-bubble"
            disabled={!canEdit}
            onClick={() => {
              if (!canEdit) return;
              beginEditMessage(message.id);
            }}
          >
            {textContent || ' '}
          </button>
        )}
      </div>
    </>
  );
}
