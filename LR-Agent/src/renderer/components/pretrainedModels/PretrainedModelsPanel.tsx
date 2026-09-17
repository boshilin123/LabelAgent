import { useState } from 'react';
import {
  VscodeButton,
  VscodeToolbarContainer,
} from '@vscode-elements/react-elements';

import VscodeClickableToolbarButton from '../VscodeClickableButton';
import VscodeScrollHost from '../VscodeScrollHost';
import ModalMotion from '../../motion/ModalMotion';
import {
  buildEmptyModel,
  usePretrainedModels,
} from '../../context/PretrainedModelsContext';
import {
  PretrainedModelConfig,
  PretrainedModelType,
  getModelDisplayName,
} from '../../types/pretrainedModel';
import PretrainedModelFormModal from './PretrainedModelFormModal';
import PretrainedModelList from './PretrainedModelList';
import './PretrainedModelsPanel.css';

type FilterType = PretrainedModelType | 'all';

export default function PretrainedModelsPanel() {
  const { models, loading, refreshModels, upsertModel, deleteModel } =
    usePretrainedModels();

  const [filterType, setFilterType] = useState<FilterType>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editingModel, setEditingModel] =
    useState<PretrainedModelConfig | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<PretrainedModelConfig | null>(null);

  const openCreate = () => {
    const modelType: PretrainedModelType =
      filterType === 'all' ? 'object_detection' : filterType;
    setEditingModel(buildEmptyModel(modelType));
    setFormOpen(true);
  };

  const openEdit = (model: PretrainedModelConfig) => {
    setEditingModel({ ...model });
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingModel(null);
  };

  const handleSave = async (model: PretrainedModelConfig) => {
    await upsertModel(model);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteModel(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <div className="pretrained-models-panel">
      <VscodeToolbarContainer className="pretrained-models-toolbar">
        <VscodeClickableToolbarButton
          icon="add"
          label="添加预训练模型"
          onClick={openCreate}
        />
        <VscodeClickableToolbarButton
          icon="refresh"
          label="刷新"
          onClick={() => refreshModels()}
        />
      </VscodeToolbarContainer>

      <div
        className="pretrained-models-filter"
        role="tablist"
        aria-label="模型类型筛选"
      >
        {(
          [
            ['all', '全部'],
            ['object_detection', 'YOLO'],
            ['image_segmentation', 'SAM2'],
            ['keypoint_estimation', '关键点'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filterType === value}
            className={`pretrained-models-filter-btn${
              filterType === value
                ? ' pretrained-models-filter-btn--active'
                : ''
            }`}
            onClick={() => setFilterType(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <VscodeScrollHost
        className="pretrained-models-scroll-host"
        scrollableClassName="pretrained-models-scrollable"
      >
        <PretrainedModelList
          models={models}
          loading={loading}
          filterType={filterType}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
          onSetDefault={(model) => upsertModel({ ...model, isDefault: true })}
        />
      </VscodeScrollHost>

      {formOpen && editingModel && (
        <PretrainedModelFormModal
          open
          initial={editingModel}
          isNew={!models.some((m) => m.id === editingModel.id)}
          onClose={closeForm}
          onSave={handleSave}
        />
      )}

      {deleteTarget && (
        <ModalMotion
          open
          onClose={() => setDeleteTarget(null)}
          closeOnBackdropClick={false}
          dialogClassName="pretrained-model-delete-dialog"
          labelledBy="pretrained-model-delete-title"
        >
          <h3 id="pretrained-model-delete-title">删除模型配置？</h3>
          <p>
            将删除本地配置「{getModelDisplayName(deleteTarget)}
            」，不会删除磁盘上的权重文件。
          </p>
          <div className="pretrained-model-delete-actions">
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
