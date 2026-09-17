import { useRef, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import { maskApiKey, type LlmProviderConfig } from '../../types/agent';
import LlmProviderMenuPortal from './LlmProviderMenuPortal';
import './LlmProviderList.css';

interface LlmProviderListProps {
  providers: LlmProviderConfig[];
  loading: boolean;
  onEdit: (provider: LlmProviderConfig) => void;
  onDelete: (provider: LlmProviderConfig) => void;
  onSetDefault: (provider: LlmProviderConfig) => void;
  onProbeVision: (provider: LlmProviderConfig) => void;
  onProbeContext: (provider: LlmProviderConfig) => void;
}

function visionBadgeLabel(provider: LlmProviderConfig): string {
  if (provider.visionProbedAt == null) return '视觉未检测';
  return provider.supportsVision ? '多模态' : '仅文本';
}

function contextBadgeLabel(provider: LlmProviderConfig): string {
  const tokens = provider.contextWindowTokens;
  if (tokens == null) return '窗口未检测';
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export default function LlmProviderList({
  providers,
  loading,
  onEdit,
  onDelete,
  onSetDefault,
  onProbeVision,
  onProbeContext,
}: LlmProviderListProps) {
  const [menuProviderId, setMenuProviderId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLElement | null>(null);

  const menuProvider = menuProviderId
    ? (providers.find((provider) => provider.id === menuProviderId) ?? null)
    : null;

  const closeMenu = () => {
    setMenuOpen(false);
  };

  const finalizeMenuClose = () => {
    setMenuOpen(false);
    setMenuProviderId(null);
    menuAnchorRef.current = null;
  };

  const openMenu = (providerId: string, anchor: HTMLButtonElement) => {
    setMenuProviderId(providerId);
    menuAnchorRef.current = anchor;
    setMenuOpen(true);
  };

  const toggleMenu = (providerId: string, anchor: HTMLButtonElement) => {
    if (menuProviderId === providerId && menuOpen) {
      closeMenu();
      return;
    }
    openMenu(providerId, anchor);
  };

  if (loading) {
    return <div className="llm-provider-list-empty">加载大模型配置…</div>;
  }

  if (providers.length === 0) {
    return (
      <div className="llm-provider-list-empty">
        尚未配置在线大模型。点击上方 + 添加 API Key、Base URL 与模型型号。
      </div>
    );
  }

  return (
    <>
      <ul className="llm-provider-list">
        {providers.map((provider) => {
          const menuOpenForItem = menuProviderId === provider.id && menuOpen;

          return (
            <li
              key={provider.id}
              className={`llm-provider-item${
                menuOpenForItem ? ' llm-provider-item-menu-open' : ''
              }`}
            >
              <div className="llm-provider-item-body">
                <div className="llm-provider-item-head">
                  <span className="llm-provider-item-name">
                    {provider.name || provider.model}
                  </span>
                  <div className="llm-provider-item-badges">
                    {provider.isDefault && (
                      <span className="llm-provider-badge llm-provider-badge-default">
                        默认
                      </span>
                    )}
                    {!provider.enabled && (
                      <span className="llm-provider-badge llm-provider-badge-disabled">
                        已停用
                      </span>
                    )}
                    <span
                      className={`llm-provider-badge ${
                        provider.supportsVision
                          ? 'llm-provider-badge-vision'
                          : 'llm-provider-badge-text-only'
                      }`}
                      title={
                        provider.visionProbeDetail
                          ? `视觉探针：${provider.visionProbeDetail}`
                          : undefined
                      }
                    >
                      {visionBadgeLabel(provider)}
                    </span>
                    <span
                      className="llm-provider-badge llm-provider-badge-context"
                      title={
                        provider.contextWindowTokens == null
                          ? '尚未检测上下文窗口，可在菜单中选择「检测上下文窗口」'
                          : provider.contextWindowSource === 'manual'
                            ? '上下文窗口（手动填写）'
                            : provider.contextWindowSource === 'probe'
                              ? '上下文窗口（API 探测）'
                              : '上下文窗口（按模型名推断）'
                      }
                    >
                      {contextBadgeLabel(provider)}
                    </span>
                  </div>
                </div>
                <div className="llm-provider-item-meta">
                  <div>{provider.model}</div>
                  <div>{provider.baseUrl}</div>
                  <div>Key: {maskApiKey(provider.apiKey)}</div>
                </div>
              </div>

              <div className="llm-provider-item-actions">
                <button
                  type="button"
                  className="llm-provider-menu-trigger"
                  aria-label="更多操作"
                  aria-expanded={menuOpenForItem}
                  onClick={(event) => {
                    toggleMenu(provider.id, event.currentTarget);
                  }}
                >
                  <VscodeIcon name="kebab-vertical" size={16} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {menuProvider && menuAnchorRef.current && (
        <LlmProviderMenuPortal
          key={menuProvider.id}
          open={menuOpen}
          anchorEl={menuAnchorRef.current}
          canSetDefault={!menuProvider.isDefault && menuProvider.enabled}
          onClose={closeMenu}
          onExitComplete={finalizeMenuClose}
          onSetDefault={() => {
            closeMenu();
            onSetDefault(menuProvider);
          }}
          onEdit={() => {
            closeMenu();
            onEdit(menuProvider);
          }}
          onDelete={() => {
            closeMenu();
            onDelete(menuProvider);
          }}
          onProbeVision={() => {
            closeMenu();
            onProbeVision(menuProvider);
          }}
          onProbeContext={() => {
            closeMenu();
            onProbeContext(menuProvider);
          }}
        />
      )}
    </>
  );
}
