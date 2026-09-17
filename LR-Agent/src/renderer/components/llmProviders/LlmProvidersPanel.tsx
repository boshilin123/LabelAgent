import { useState } from 'react';
import {
  VscodeButton,
  VscodeIcon,
  VscodeOption,
  VscodeSingleSelect,
  VscodeToolbarContainer,
} from '@vscode-elements/react-elements';
import VscodeClickableToolbarButton from '../VscodeClickableButton';
import VscodeScrollHost from '../VscodeScrollHost';
import ModalMotion from '../../motion/ModalMotion';
import {
  buildEmptyProvider,
  useLlmProviders,
} from '../../context/LlmProvidersContext';
import type { LlmProviderConfig } from '../../types/agent';
import LlmProviderFormModal from './LlmProviderFormModal';
import LlmProviderList from './LlmProviderList';
import './LlmProvidersPanel.css';

export default function LlmProvidersPanel() {
  const {
    providers,
    loading,
    auxiliaryProvider,
    auxiliaryProviderId,
    setAuxiliaryProvider,
    refreshProviders,
    upsertProvider,
    deleteProvider,
    setDefaultProvider,
    probeProviderVision,
    probeProviderContext,
  } = useLlmProviders();

  const [formOpen, setFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] =
    useState<LlmProviderConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LlmProviderConfig | null>(
    null,
  );

  const openCreate = () => {
    setEditingProvider(buildEmptyProvider());
    setFormOpen(true);
  };

  const openEdit = (provider: LlmProviderConfig) => {
    setEditingProvider({ ...provider, apiKey: '' });
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingProvider(null);
  };

  const handleSave = async (provider: LlmProviderConfig) => {
    const existing = providers.find((item) => item.id === provider.id);
    const isNew = !existing;
    await upsertProvider(provider, isNew);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteProvider(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <div className="llm-providers-panel">
      <VscodeToolbarContainer className="llm-providers-toolbar">
        <VscodeClickableToolbarButton
          icon="add"
          label="添加大模型配置"
          onClick={openCreate}
        />
        <VscodeClickableToolbarButton
          icon="refresh"
          label="刷新"
          onClick={() => refreshProviders()}
        />
      </VscodeToolbarContainer>

      <VscodeScrollHost
        className="llm-providers-scroll-host"
        scrollableClassName="llm-providers-scrollable"
      >
        <section className="llm-section">
          <h4 className="llm-section-title">子代理配置</h4>
          <div className="llm-aux-card">
            <span className="llm-aux-icon" aria-hidden>
              <VscodeIcon name="type-hierarchy-sub" size={16} />
            </span>
            <div className="llm-aux-main">
              <div className="llm-aux-head">
                <span className="llm-aux-name">辅助模型</span>
                <span
                  className={`llm-provider-badge ${
                    auxiliaryProvider
                      ? 'llm-provider-badge-default'
                      : 'llm-provider-badge-disabled'
                  }`}
                >
                  {auxiliaryProvider
                    ? auxiliaryProvider.name || auxiliaryProvider.model
                    : '跟随会话'}
                </span>
              </div>
              <p className="llm-aux-desc">
                用于子代理查阅、上下文摘要等轻量调用。不指定则跟随当前会话模型。
              </p>
              <VscodeSingleSelect
                id="llm-providers-aux-select"
                className="llm-aux-select"
                value={auxiliaryProviderId ?? ''}
                aria-label="选择辅助模型"
                onChange={(event) => {
                  const target = event.target as HTMLElement & {
                    value?: string;
                  };
                  if (typeof target.value === 'string') {
                    setAuxiliaryProvider(target.value || null);
                  }
                }}
              >
                <VscodeOption value="">不使用（跟随会话模型）</VscodeOption>
                {providers
                  .filter((item) => item.enabled)
                  .map((item) => (
                    <VscodeOption key={item.id} value={item.id}>
                      {item.name || item.model}
                    </VscodeOption>
                  ))}
              </VscodeSingleSelect>
            </div>
          </div>
        </section>

        <section className="llm-section">
          <h4 className="llm-section-title">
            已配置 {loading ? '…' : providers.length}
          </h4>
          <LlmProviderList
            providers={providers}
            loading={loading}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
            onSetDefault={(provider) => setDefaultProvider(provider.id)}
            onProbeVision={(provider) => probeProviderVision(provider.id)}
            onProbeContext={(provider) => probeProviderContext(provider.id)}
          />
        </section>
      </VscodeScrollHost>

      {formOpen && editingProvider && (
        <LlmProviderFormModal
          open
          initial={editingProvider}
          isNew={!providers.some((item) => item.id === editingProvider.id)}
          onClose={closeForm}
          onSave={handleSave}
        />
      )}

      {deleteTarget && (
        <ModalMotion
          open
          onClose={() => setDeleteTarget(null)}
          closeOnBackdropClick={false}
          dialogClassName="llm-provider-delete-dialog"
          labelledBy="llm-provider-delete-title"
        >
          <h3 id="llm-provider-delete-title">删除大模型配置？</h3>
          <p>将删除配置「{deleteTarget.name || deleteTarget.model}」。</p>
          <div className="llm-provider-delete-actions">
            <VscodeButton
              secondary
              icon="close"
              type="button"
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </VscodeButton>
            <VscodeButton
              secondary
              icon="trash"
              type="button"
              className="vscode-btn-danger"
              onClick={handleDelete}
            >
              删除
            </VscodeButton>
          </div>
        </ModalMotion>
      )}
    </div>
  );
}
