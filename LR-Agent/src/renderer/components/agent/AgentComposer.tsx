import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  useAgentChat,
  useAgentComposerDraft,
} from '../../context/AgentChatContext';
import { useAnnotation } from '../../context/AnnotationContext';
import { useWorkMode } from '../../context/WorkModeContext';
import { useLlmProviders } from '../../context/LlmProvidersContext';
import AgentModePicker from './AgentModePicker';
import AgentModelPicker from './AgentModelPicker';
import './AgentComposer.css';

const COMPOSER_MAX_HEIGHT_PX = 160;

export default function AgentComposer() {
  const {
    activeSessionId,
    activeSession,
    sendMessage,
    stopGeneration,
    isSessionStreaming,
    preparingContext,
    setSessionProvider,
    agentMode,
    setAgentMode,
  } = useAgentChat();
  // 草稿单独走一个轻量 context，避免每敲一个字都让整个消息列表重渲。
  const { composerDraft, setComposerDraft } = useAgentComposerDraft();
  const { activeProject } = useAnnotation();
  const { workMode } = useWorkMode();
  const { providers, defaultProvider } = useLlmProviders();
  const showAnnotateMode =
    (workMode === 'annotation' && activeProject != null) ||
    workMode === 'editor';
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const enabledProviders = useMemo(
    () => providers.filter((item) => item.enabled),
    [providers],
  );

  const streaming =
    activeSessionId != null && isSessionStreaming(activeSessionId);

  const busy = streaming || preparingContext;

  const canSend =
    Boolean(composerDraft.trim()) &&
    enabledProviders.length > 0 &&
    Boolean(activeSessionId) &&
    !busy;

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [composerDraft, resizeTextarea]);

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !composerDraft.trim()) return;
    await sendMessage(composerDraft);
    requestAnimationFrame(resizeTextarea);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组合态（如中文拼音按 Enter 选字）不应触发发送
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit().catch(() => undefined);
    }
  };

  const selectedProviderId =
    activeSession?.providerId || defaultProvider?.id || '';

  return (
    <div className="agent-composer">
      <form className="agent-composer-form" onSubmit={handleSubmit}>
        <div className="agent-composer-box">
          <textarea
            ref={textareaRef}
            className="agent-composer-input"
            value={composerDraft}
            placeholder="请描述任务，如：辅助标注、生成报告等"
            rows={1}
            onChange={(event) => {
              setComposerDraft(event.target.value);
              resizeTextarea();
            }}
            onKeyDown={handleKeyDown}
          />

          <div className="agent-composer-footer">
            <div className="agent-composer-footer-left">
              {showAnnotateMode ? (
                <AgentModePicker
                  mode={agentMode}
                  workMode={workMode}
                  disabled={busy}
                  onSelect={setAgentMode}
                />
              ) : null}

              <AgentModelPicker
                providers={enabledProviders}
                selectedId={selectedProviderId}
                disabled={!activeSessionId}
                inline
                onSelect={(providerId) => {
                  if (!activeSessionId) return;
                  setSessionProvider(activeSessionId, providerId);
                }}
              />
            </div>

            {busy ? (
              <button
                type="button"
                className="agent-composer-send agent-composer-send--stop"
                aria-label="停止生成"
                onClick={() => stopGeneration()}
              >
                <span className="codicon codicon-debug-stop" />
              </button>
            ) : (
              <button
                type="submit"
                className={`agent-composer-send${
                  canSend ? ' agent-composer-send--ready' : ''
                }`}
                disabled={!canSend}
                aria-label="发送"
              >
                <span className="codicon codicon-arrow-up" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
