import { FormEvent, useEffect, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import {
  maskApiKey,
  normalizeBaseUrl,
  type LlmProviderConfig,
} from '../../types/agent';
import './LlmProviderFormModal.css';

interface LlmProviderFormModalProps {
  open: boolean;
  initial: LlmProviderConfig;
  isNew: boolean;
  onClose: () => void;
  onSave: (provider: LlmProviderConfig) => Promise<void>;
}

export default function LlmProviderFormModal({
  open,
  initial,
  isNew,
  onClose,
  onSave,
}: LlmProviderFormModalProps) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [contextWindowInput, setContextWindowInput] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm(initial);
    setContextWindowInput(
      initial.contextWindowTokens == null
        ? ''
        : String(initial.contextWindowTokens),
    );
    setError(null);
    setSubmitting(false);
  }, [open, initial]);

  const update = (patch: Partial<LlmProviderConfig>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setError('请填写配置名称');
      return;
    }
    if (!form.baseUrl.trim()) {
      setError('请填写 Base URL');
      return;
    }
    if (isNew && !form.apiKey.trim()) {
      setError('请填写 API Key');
      return;
    }
    if (!form.model.trim()) {
      setError('请填写模型型号');
      return;
    }
    const trimmedWindow = contextWindowInput.trim();
    let contextWindowTokens: number | null = null;
    if (trimmedWindow) {
      const parsed = Number(trimmedWindow);
      if (!Number.isInteger(parsed) || parsed < 1024) {
        setError('上下文窗口需为不小于 1024 的整数（tokens）');
        return;
      }
      contextWindowTokens = parsed;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSave({
        ...form,
        name: form.name.trim(),
        baseUrl: normalizeBaseUrl(form.baseUrl),
        model: form.model.trim(),
        contextWindowTokens,
        contextWindowSource:
          contextWindowTokens != null
            ? 'manual'
            : form.contextWindowSource === 'manual'
              ? ''
              : form.contextWindowSource,
        updatedAt: Date.now(),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalMotion
      open={open}
      onClose={onClose}
      closeOnBackdropClick={false}
      dialogClassName="llm-provider-form-dialog"
      labelledBy="llm-provider-form-title"
      dialogRole="form"
      onSubmit={handleSubmit}
    >
      <h3 id="llm-provider-form-title">
        {isNew ? '添加大模型配置' : '编辑大模型配置'}
      </h3>

      <label className="llm-provider-field">
        <span>名称</span>
        <input
          value={form.name}
          onChange={(event) => update({ name: event.target.value })}
          placeholder="例如 通义千问"
        />
      </label>

      <label className="llm-provider-field">
        <span>Base URL</span>
        <input
          value={form.baseUrl}
          onChange={(event) => update({ baseUrl: event.target.value })}
          placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
        />
      </label>

      <label className="llm-provider-field">
        <span>API Key</span>
        <input
          type="password"
          value={form.apiKey}
          onChange={(event) => update({ apiKey: event.target.value })}
          placeholder={
            isNew ? 'sk-...' : `留空则保持 ${maskApiKey(initial.apiKey)}`
          }
        />
      </label>

      <label className="llm-provider-field">
        <span>模型型号</span>
        <input
          value={form.model}
          onChange={(event) => update({ model: event.target.value })}
          placeholder="Qwen3.6-Plus"
        />
      </label>

      <label className="llm-provider-field">
        <span>上下文窗口 (tokens，可选)</span>
        <input
          value={contextWindowInput}
          onChange={(event) => setContextWindowInput(event.target.value)}
          placeholder={
            form.contextWindowTokens != null &&
            form.contextWindowSource !== 'manual'
              ? `${form.contextWindowTokens}（自动检测，可覆盖）`
              : '例如 128000，留空则未检测'
          }
          inputMode="numeric"
        />
      </label>

      <label className="llm-provider-checkbox">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        启用
      </label>

      <label className="llm-provider-checkbox">
        <input
          type="checkbox"
          checked={form.isDefault}
          onChange={(event) => update({ isDefault: event.target.checked })}
        />
        设为默认
      </label>

      {error && <div className="llm-provider-error">{error}</div>}

      <div className="llm-provider-form-actions">
        <VscodeButton secondary icon="close" type="button" onClick={onClose}>
          取消
        </VscodeButton>
        <VscodeButton icon="save" type="submit" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </VscodeButton>
      </div>
    </ModalMotion>
  );
}
