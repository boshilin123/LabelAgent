import { useRef, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import {
  PretrainedModelConfig,
  PRETRAINED_MODEL_TYPE_LABELS,
  PretrainedModelType,
  KEYPOINT_BACKEND_LABELS,
  getModelDisplayName,
} from '../../types/pretrainedModel';
import { KEYPOINT_TEMPLATES } from '../../types/keypointTemplate';
import PretrainedModelMenuPortal from './PretrainedModelMenuPortal';
import './PretrainedModelList.css';

interface PretrainedModelListProps {
  models: PretrainedModelConfig[];
  loading: boolean;
  filterType: PretrainedModelType | 'all';
  onEdit: (model: PretrainedModelConfig) => void;
  onDelete: (model: PretrainedModelConfig) => void;
  onSetDefault: (model: PretrainedModelConfig) => void;
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function templateLabel(templateId: string): string {
  const template = KEYPOINT_TEMPLATES.find((t) => t.id === templateId);
  return template?.name ?? templateId;
}

export default function PretrainedModelList({
  models,
  loading,
  filterType,
  onEdit,
  onDelete,
  onSetDefault,
}: PretrainedModelListProps) {
  const [menuModelId, setMenuModelId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLElement | null>(null);

  const filtered =
    filterType === 'all'
      ? models
      : models.filter((m) => m.modelType === filterType);

  const menuModel = menuModelId
    ? (filtered.find((model) => model.id === menuModelId) ?? null)
    : null;

  const closeMenu = () => {
    setMenuOpen(false);
  };

  const finalizeMenuClose = () => {
    setMenuOpen(false);
    setMenuModelId(null);
    menuAnchorRef.current = null;
  };

  const openMenu = (modelId: string, anchor: HTMLButtonElement) => {
    setMenuModelId(modelId);
    menuAnchorRef.current = anchor;
    setMenuOpen(true);
  };

  const toggleMenu = (modelId: string, anchor: HTMLButtonElement) => {
    if (menuModelId === modelId && menuOpen) {
      closeMenu();
      return;
    }
    openMenu(modelId, anchor);
  };

  if (loading) {
    return (
      <div className="pretrained-model-list-empty">加载预训练模型配置…</div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="pretrained-model-list-empty">
        {filterType === 'all'
          ? '尚未配置预训练模型。点击上方 + 添加。'
          : `暂无${PRETRAINED_MODEL_TYPE_LABELS[filterType as PretrainedModelType]}配置。`}
      </div>
    );
  }

  return (
    <>
      <ul className="pretrained-model-list">
        {filtered.map((model) => {
          const menuOpenForItem = menuModelId === model.id && menuOpen;

          return (
            <li
              key={model.id}
              className={`pretrained-model-item${
                menuOpenForItem ? ' pretrained-model-item-menu-open' : ''
              }`}
            >
              <div className="pretrained-model-item-body">
                <div className="pretrained-model-item-head">
                  <span
                    className="pretrained-model-item-name"
                    title={getModelDisplayName(model)}
                  >
                    {getModelDisplayName(model)}
                  </span>
                  <div className="pretrained-model-item-badges">
                    {model.isDefault && (
                      <span className="pretrained-model-badge pretrained-model-badge-default">
                        默认
                      </span>
                    )}
                    {!model.enabled && (
                      <span className="pretrained-model-badge pretrained-model-badge-disabled">
                        已停用
                      </span>
                    )}
                  </div>
                </div>

                <div className="pretrained-model-item-type">
                  {PRETRAINED_MODEL_TYPE_LABELS[model.modelType]}
                  {model.keypointBackend && (
                    <> · {KEYPOINT_BACKEND_LABELS[model.keypointBackend]}</>
                  )}
                </div>

                {model.modelType === 'keypoint_estimation' &&
                  model.keypointTemplateIds &&
                  model.keypointTemplateIds.length > 0 && (
                    <div className="pretrained-model-item-templates">
                      {model.keypointTemplateIds.map((tid) => (
                        <span
                          key={tid}
                          className="pretrained-model-badge pretrained-model-badge-template"
                        >
                          {templateLabel(tid)}
                        </span>
                      ))}
                    </div>
                  )}

                <div
                  className="pretrained-model-item-path"
                  title={model.checkpointPath}
                >
                  {basename(model.checkpointPath) || '未设置权重路径'}
                </div>

                {model.modelType === 'image_segmentation' &&
                  model.configPath && (
                    <div
                      className="pretrained-model-item-path pretrained-model-item-path-sub"
                      title={model.configPath}
                    >
                      {basename(model.configPath)}
                    </div>
                  )}

                {model.modelType === 'keypoint_estimation' &&
                  model.auxiliaryPaths?.detector && (
                    <div
                      className="pretrained-model-item-path pretrained-model-item-path-sub"
                      title={model.auxiliaryPaths.detector}
                    >
                      {basename(model.auxiliaryPaths.detector)}
                    </div>
                  )}
              </div>

              <div className="pretrained-model-item-actions">
                <button
                  type="button"
                  className="pretrained-model-menu-trigger"
                  aria-label="更多操作"
                  aria-expanded={menuOpenForItem}
                  onClick={(event) => {
                    toggleMenu(model.id, event.currentTarget);
                  }}
                >
                  <VscodeIcon name="kebab-vertical" size={16} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {menuModel && menuAnchorRef.current && (
        <PretrainedModelMenuPortal
          key={menuModel.id}
          open={menuOpen}
          anchorEl={menuAnchorRef.current}
          canSetDefault={!menuModel.isDefault && menuModel.enabled}
          onClose={closeMenu}
          onExitComplete={finalizeMenuClose}
          onSetDefault={() => {
            closeMenu();
            onSetDefault(menuModel);
          }}
          onEdit={() => {
            closeMenu();
            onEdit(menuModel);
          }}
          onDelete={() => {
            closeMenu();
            onDelete(menuModel);
          }}
        />
      )}
    </>
  );
}
