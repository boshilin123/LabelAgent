import { FormEvent, useEffect, useMemo, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import {
  MCP_API_KEY_PLACEHOLDER,
  MCP_TRANSPORT_LABELS,
  MCP_TRANSPORTS,
  maskHeaderValue,
  type McpPreset,
  type McpServerConfig,
  type McpServerInput,
  type McpTransport,
} from '../../../shared/mcpTypes';
import './McpServerFormModal.css';

interface McpServerFormModalProps {
  open: boolean;
  /** 编辑时为已保存配置；新建/广场添加时为 null */
  initial: McpServerConfig | null;
  /** 从广场添加时传入预设（预填 url / transport / Key header） */
  preset: McpPreset | null;
  onClose: () => void;
  onSave: (input: McpServerInput) => Promise<void>;
}

const DEFAULT_KEY_HEADER = 'Authorization';
const DEFAULT_KEY_TEMPLATE = `Bearer ${MCP_API_KEY_PLACEHOLDER}`;

function parseExtraHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function extraHeadersToText(
  headers: Record<string, string>,
  keyHeader: string,
): string {
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase() !== keyHeader.toLowerCase())
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

export default function McpServerFormModal({
  open,
  initial,
  preset,
  onClose,
  onSave,
}: McpServerFormModalProps) {
  const isNew = !initial;
  const keyHeader = preset?.apiKeyHeader ?? DEFAULT_KEY_HEADER;
  const keyTemplate = preset?.apiKeyTemplate ?? DEFAULT_KEY_TEMPLATE;
  const requiresApiKey = preset?.requiresApiKey ?? false;

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [transport, setTransport] = useState<McpTransport>('streamable_http');
  const [apiKey, setApiKey] = useState('');
  const [extraHeadersText, setExtraHeadersText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const existingKeyValue = useMemo(() => {
    if (!initial) return '';
    const entry = Object.entries(initial.headers).find(
      ([key]) => key.toLowerCase() === keyHeader.toLowerCase(),
    );
    return entry?.[1] ?? '';
  }, [initial, keyHeader]);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? preset?.name ?? '');
    setUrl(initial?.url ?? preset?.url ?? '');
    setTransport(initial?.transport ?? preset?.transport ?? 'streamable_http');
    setApiKey('');
    setExtraHeadersText(
      initial ? extraHeadersToText(initial.headers, keyHeader) : '',
    );
    setEnabled(initial?.enabled ?? true);
    setError(null);
    setSubmitting(false);
  }, [open, initial, preset, keyHeader]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) {
      setError('请填写名称');
      return;
    }
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setError('请填写合法的 http(s) URL');
      return;
    }
    const trimmedKey = apiKey.trim();
    if (isNew && requiresApiKey && !trimmedKey) {
      setError('该服务需要 API Key');
      return;
    }

    const headers = parseExtraHeaders(extraHeadersText);
    if (trimmedKey) {
      headers[keyHeader] = keyTemplate.includes(MCP_API_KEY_PLACEHOLDER)
        ? keyTemplate.replace(MCP_API_KEY_PLACEHOLDER, trimmedKey)
        : trimmedKey;
    } else if (!isNew && existingKeyValue) {
      headers[keyHeader] = existingKeyValue;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSave({
        id: initial?.id,
        name: trimmedName,
        url: trimmedUrl,
        transport,
        headers,
        enabled,
        preset: preset?.id ?? initial?.preset ?? null,
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
      dialogClassName="mcp-server-form-dialog"
      labelledBy="mcp-server-form-title"
      dialogRole="form"
      onSubmit={handleSubmit}
    >
      <h3 id="mcp-server-form-title">
        {isNew
          ? preset
            ? `添加 ${preset.name}`
            : '添加 MCP 服务'
          : '编辑 MCP 服务'}
      </h3>

      {preset?.description ? (
        <p className="mcp-server-form-preset-desc">{preset.description}</p>
      ) : null}

      <label className="mcp-server-field">
        <span>名称</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如 Tavily 搜索"
        />
      </label>

      <label className="mcp-server-field">
        <span>URL</span>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://mcp.tavily.com/mcp"
        />
      </label>

      <label className="mcp-server-field">
        <span>通信协议</span>
        <select
          value={transport}
          onChange={(event) => setTransport(event.target.value as McpTransport)}
        >
          {MCP_TRANSPORTS.map((item) => (
            <option key={item} value={item}>
              {MCP_TRANSPORT_LABELS[item]}
            </option>
          ))}
        </select>
      </label>

      <label className="mcp-server-field">
        <span>API Key{requiresApiKey ? '（必填）' : '（可选）'}</span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            isNew
              ? `写入 ${keyHeader} 请求头`
              : existingKeyValue
                ? `留空则保持 ${maskHeaderValue(existingKeyValue)}`
                : `写入 ${keyHeader} 请求头`
          }
        />
      </label>

      <label className="mcp-server-field">
        <span>额外请求头（每行一个，格式 Name: value）</span>
        <textarea
          rows={3}
          value={extraHeadersText}
          onChange={(event) => setExtraHeadersText(event.target.value)}
          placeholder="X-Custom-Header: value"
        />
      </label>

      <label className="mcp-server-field mcp-server-field--inline">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>保存后立即启用</span>
      </label>

      {error ? <p className="mcp-server-form-error">{error}</p> : null}

      <div className="mcp-server-form-actions">
        <VscodeButton type="button" secondary onClick={onClose}>
          取消
        </VscodeButton>
        <VscodeButton type="submit" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </VscodeButton>
      </div>
    </ModalMotion>
  );
}
