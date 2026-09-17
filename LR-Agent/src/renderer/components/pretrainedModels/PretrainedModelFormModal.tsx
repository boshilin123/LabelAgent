import { FormEvent, useEffect, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import {
  PretrainedModelConfig,
  PRETRAINED_MODEL_TYPE_LABELS,
  PretrainedModelType,
  KeypointBackend,
  KEYPOINT_BACKEND_LABELS,
  KEYPOINT_BACKEND_PRESETS,
  defaultParamsForType,
  type ObjectDetectionMode,
} from '../../types/pretrainedModel';
import { KEYPOINT_TEMPLATES } from '../../types/keypointTemplate';
import {
  pickModelFile,
  pickSam2RootDirectory,
  pickKeypointRootDirectory,
  scanSam2Directory,
  scanFaceAlignmentDirectory,
  scanKeypointBundleDirectory,
  validatePretrainedModelPaths,
} from '../../services/pretrainedModelService';
import './PretrainedModelFormModal.css';

interface PretrainedModelFormModalProps {
  open: boolean;
  initial: PretrainedModelConfig;
  isNew: boolean;
  onClose: () => void;
  onSave: (model: PretrainedModelConfig) => Promise<void>;
}

const KEYPOINT_BACKENDS = Object.keys(
  KEYPOINT_BACKEND_PRESETS,
) as KeypointBackend[];

export default function PretrainedModelFormModal({
  open,
  initial,
  isNew,
  onClose,
  onSave,
}: PretrainedModelFormModalProps) {
  const [form, setForm] = useState<PretrainedModelConfig>(initial);
  const [error, setError] = useState<string | null>(null);
  const [validationMessages, setValidationMessages] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(initial);
    setError(null);
    setValidationMessages([]);
    setSubmitting(false);
    setScanning(false);
  }, [open, initial]);

  const updateForm = (patch: Partial<PretrainedModelConfig>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const updateParams = (
    patch: NonNullable<PretrainedModelConfig['params']>,
  ) => {
    setForm((prev) => ({
      ...prev,
      params: { ...prev.params, ...patch },
    }));
  };

  const handleTypeChange = (modelType: PretrainedModelType) => {
    const backend: KeypointBackend = 'yolo_pose';
    const preset = KEYPOINT_BACKEND_PRESETS[backend];

    setForm((prev) => ({
      ...prev,
      modelType,
      configPath:
        modelType === 'image_segmentation'
          ? (prev.configPath ?? '')
          : undefined,
      keypointBackend:
        modelType === 'keypoint_estimation' ? backend : undefined,
      keypointTemplateIds:
        modelType === 'keypoint_estimation'
          ? [...preset.defaultTemplateIds]
          : undefined,
      auxiliaryPaths:
        modelType === 'keypoint_estimation' ? undefined : undefined,
      detectionMode:
        modelType === 'object_detection'
          ? (prev.detectionMode ?? 'detect')
          : undefined,
      params: defaultParamsForType(modelType, backend),
    }));
  };

  const handleBackendChange = (backend: KeypointBackend) => {
    const preset = KEYPOINT_BACKEND_PRESETS[backend];
    updateForm({
      keypointBackend: backend,
      keypointTemplateIds: [...preset.defaultTemplateIds],
      auxiliaryPaths:
        backend === 'face_alignment'
          ? { detector: form.auxiliaryPaths?.detector ?? '', torchHome: '' }
          : undefined,
      params: defaultParamsForType('keypoint_estimation', backend),
    });
  };

  const checkpointExtensions = (): string[] => {
    if (form.modelType === 'keypoint_estimation' && form.keypointBackend) {
      return KEYPOINT_BACKEND_PRESETS[form.keypointBackend]
        .checkpointExtensions;
    }
    return ['pt'];
  };

  const handlePickCheckpoint = async () => {
    const exts = checkpointExtensions();
    const path = await pickModelFile(
      exts,
      `选择模型权重 (.${exts.join(', .')})`,
    );
    if (!path) return;
    updateForm({ checkpointPath: path });
  };

  const handlePickConfig = async () => {
    const path = await pickModelFile(
      ['yaml', 'yml'],
      '选择 SAM2 配置文件 (.yaml)',
    );
    if (!path) return;
    updateForm({ configPath: path });
  };

  const handlePickDetector = async () => {
    const path = await pickModelFile(['pth'], '选择人脸检测器 (.pth)');
    if (!path) return;
    updateForm({
      auxiliaryPaths: {
        ...form.auxiliaryPaths,
        detector: path,
      },
    });
  };

  const applyKeypointScan = (
    scanned: {
      backend: KeypointBackend;
      name: string;
      checkpointPath: string;
      keypointTemplateIds: string[];
      auxiliaryPaths?: PretrainedModelConfig['auxiliaryPaths'];
    },
    infoMessage?: string,
  ) => {
    const preset = KEYPOINT_BACKEND_PRESETS[scanned.backend];
    updateForm({
      modelType: 'keypoint_estimation',
      keypointBackend: scanned.backend,
      checkpointPath: scanned.checkpointPath,
      keypointTemplateIds: scanned.keypointTemplateIds,
      auxiliaryPaths: scanned.auxiliaryPaths,
      name: form.name.trim() || scanned.name,
      params: defaultParamsForType('keypoint_estimation', scanned.backend),
    });
    setValidationMessages([infoMessage ?? `已导入 ${preset.label}`]);
  };

  const handleImportSam2Directory = async () => {
    setScanning(true);
    setError(null);
    try {
      const rootDir = await pickSam2RootDirectory();
      if (!rootDir) return;

      const scanned = await scanSam2Directory(rootDir);
      if (scanned.length === 0) {
        setError(
          '未在该目录找到可用的 SAM2 配对（需包含 checkpoints/*.pt 与 configs/sam2.1/*.yaml）',
        );
        return;
      }

      const first = scanned[0];
      updateForm({
        modelType: 'image_segmentation',
        checkpointPath: first.checkpointPath,
        configPath: first.configPath,
      });

      if (scanned.length > 1) {
        setValidationMessages([
          `已从目录导入 ${first.name}；该目录另有 ${scanned.length - 1} 个变体，保存后可继续添加。`,
        ]);
      }
    } finally {
      setScanning(false);
    }
  };

  const handleImportFaceAlignmentDirectory = async () => {
    setScanning(true);
    setError(null);
    try {
      const rootDir = await pickKeypointRootDirectory();
      if (!rootDir) return;

      const scanned = await scanFaceAlignmentDirectory(rootDir);
      if (!scanned) {
        setError(
          '未找到 face-alignment 配对（需包含 2DFAN 主权重与 s3fd 检测器）',
        );
        return;
      }

      applyKeypointScan(scanned);
    } finally {
      setScanning(false);
    }
  };

  const handleImportKeypointBundleDirectory = async () => {
    setScanning(true);
    setError(null);
    try {
      const rootDir = await pickKeypointRootDirectory();
      if (!rootDir) return;

      const bundle = await scanKeypointBundleDirectory(rootDir);
      if (bundle.models.length === 0) {
        setError(
          '未找到可用的关键点模型（需包含 YOLO-Pose 的 .pt、MediaPipe Hand 的 .task 或 face-alignment 权重文件）',
        );
        return;
      }

      const preferred = form.keypointBackend
        ? bundle.models.find((m) => m.backend === form.keypointBackend)
        : undefined;
      const first = preferred ?? bundle.models[0];
      const others = bundle.models.length - 1;
      applyKeypointScan(
        first,
        others > 0
          ? `已导入 ${first.name}；该目录另有 ${others} 个模型，保存后可继续添加。`
          : undefined,
      );
    } finally {
      setScanning(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!form.checkpointPath.trim()) {
      setError('请选择权重文件');
      return;
    }
    if (form.modelType === 'image_segmentation' && !form.configPath?.trim()) {
      setError('SAM2 需要配置文件路径');
      return;
    }
    if (form.modelType === 'keypoint_estimation') {
      if (!form.keypointBackend) {
        setError('请选择关键点后端');
        return;
      }
      if (!form.keypointTemplateIds?.length) {
        setError('至少绑定一个骨架模板');
        return;
      }
      if (
        form.keypointBackend === 'face_alignment' &&
        !form.auxiliaryPaths?.detector?.trim()
      ) {
        setError('face-alignment 需要人脸检测器路径');
        return;
      }
    }

    const validation = await validatePretrainedModelPaths({
      modelType: form.modelType,
      checkpointPath: form.checkpointPath,
      configPath: form.configPath,
      keypointBackend: form.keypointBackend,
      keypointTemplateIds: form.keypointTemplateIds,
      auxiliaryPaths: form.auxiliaryPaths,
    });
    if (!validation.ok) {
      setError(validation.errors[0] ?? '路径校验未通过');
      setValidationMessages([...validation.errors, ...validation.warnings]);
      return;
    }
    if (validation.warnings.length > 0) {
      setValidationMessages(validation.warnings);
    }

    setSubmitting(true);
    try {
      await onSave({
        ...form,
        name: form.name.trim(),
        checkpointPath: form.checkpointPath.trim(),
        configPath: form.configPath?.trim() || undefined,
        keypointTemplateIds: form.keypointTemplateIds?.length
          ? form.keypointTemplateIds
          : undefined,
        auxiliaryPaths:
          form.keypointBackend === 'face_alignment'
            ? {
                detector: form.auxiliaryPaths?.detector?.trim(),
                torchHome: form.auxiliaryPaths?.torchHome?.trim() || undefined,
              }
            : undefined,
        description: form.description?.trim() || '',
        updatedAt: new Date().toISOString(),
      });
      onClose();
    } catch {
      setError('保存失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const backendHint =
    form.modelType === 'keypoint_estimation' && form.keypointBackend
      ? KEYPOINT_BACKEND_PRESETS[form.keypointBackend].hint
      : null;

  const checkpointLabel =
    form.modelType === 'keypoint_estimation' &&
    form.keypointBackend === 'mediapipe_hand'
      ? '模型文件 (.task)'
      : form.modelType === 'keypoint_estimation' &&
          form.keypointBackend === 'face_alignment'
        ? '主权重 (2DFAN)'
        : '权重路径 (.pt)';

  return (
    <ModalMotion
      open={open}
      onClose={onClose}
      closeOnBackdropClick={false}
      dialogClassName="pretrained-model-form-dialog"
      labelledBy="pretrained-model-form-title"
      dialogRole="form"
      onSubmit={handleSubmit}
    >
      <h3
        id="pretrained-model-form-title"
        className="pretrained-model-form-title"
      >
        {isNew ? '添加预训练模型' : '编辑预训练模型'}
      </h3>

      <div className="pretrained-model-form-field">
        <label htmlFor="pm-name">显示名称（可选）</label>
        <input
          id="pm-name"
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          placeholder="留空则使用权重文件名"
        />
      </div>

      <div className="pretrained-model-form-field">
        <span className="pretrained-model-form-label">模型类型</span>
        <div className="pretrained-model-type-options">
          {(
            Object.entries(PRETRAINED_MODEL_TYPE_LABELS) as [
              PretrainedModelType,
              string,
            ][]
          ).map(([value, label]) => (
            <label key={value} className="pretrained-model-type-option">
              <input
                type="radio"
                name="modelType"
                value={value}
                checked={form.modelType === value}
                onChange={() => handleTypeChange(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {form.modelType === 'keypoint_estimation' && (
        <>
          <div className="pretrained-model-form-field">
            <span className="pretrained-model-form-label">关键点后端</span>
            <div className="pretrained-model-type-options">
              {KEYPOINT_BACKENDS.map((backend) => (
                <label key={backend} className="pretrained-model-type-option">
                  <input
                    type="radio"
                    name="keypointBackend"
                    value={backend}
                    checked={form.keypointBackend === backend}
                    onChange={() => handleBackendChange(backend)}
                  />
                  {KEYPOINT_BACKEND_LABELS[backend]}
                </label>
              ))}
            </div>
            {backendHint && (
              <span className="pretrained-model-form-hint">{backendHint}</span>
            )}
          </div>

          <div className="pretrained-model-form-field">
            <span className="pretrained-model-form-label">骨架模板</span>
            <div className="pretrained-model-template-options">
              {KEYPOINT_TEMPLATES.map((template) => {
                const selected =
                  form.keypointTemplateIds?.includes(template.id) ?? false;
                const allowed =
                  form.keypointBackend &&
                  KEYPOINT_BACKEND_PRESETS[
                    form.keypointBackend
                  ].defaultTemplateIds.includes(template.id);

                return (
                  <label
                    key={template.id}
                    className={`pretrained-model-template-option${
                      !allowed ? ' pretrained-model-template-option--muted' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!allowed}
                      onChange={(e) => {
                        const ids = new Set(form.keypointTemplateIds ?? []);
                        if (e.target.checked) ids.add(template.id);
                        else ids.delete(template.id);
                        updateForm({
                          keypointTemplateIds: Array.from(ids),
                        });
                      }}
                    />
                    {template.name}
                  </label>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div className="pretrained-model-form-field">
        <label htmlFor="pm-checkpoint">{checkpointLabel}</label>
        <div className="pretrained-model-path-row">
          <input
            id="pm-checkpoint"
            value={form.checkpointPath}
            readOnly
            placeholder={`点击浏览选择 ${checkpointExtensions()
              .map((e) => `.${e}`)
              .join(' / ')}`}
            title={form.checkpointPath}
          />
          <VscodeButton
            secondary
            icon="folder-opened"
            type="button"
            onClick={handlePickCheckpoint}
          >
            浏览
          </VscodeButton>
        </div>
      </div>

      {form.modelType === 'keypoint_estimation' &&
        form.keypointBackend === 'face_alignment' && (
          <div className="pretrained-model-form-field">
            <label htmlFor="pm-detector">人脸检测器 (s3fd)</label>
            <div className="pretrained-model-path-row">
              <input
                id="pm-detector"
                value={form.auxiliaryPaths?.detector ?? ''}
                readOnly
                placeholder="选择 s3fd-*.pth"
                title={form.auxiliaryPaths?.detector ?? ''}
              />
              <VscodeButton
                secondary
                icon="folder-opened"
                type="button"
                onClick={handlePickDetector}
              >
                浏览
              </VscodeButton>
            </div>
          </div>
        )}

      {form.modelType === 'image_segmentation' && (
        <>
          <div className="pretrained-model-form-field">
            <label htmlFor="pm-config">配置文件 (.yaml)</label>
            <div className="pretrained-model-path-row">
              <input
                id="pm-config"
                value={form.configPath ?? ''}
                readOnly
                placeholder="与权重变体匹配的 sam2.1_hiera_*.yaml"
                title={form.configPath ?? ''}
              />
              <VscodeButton
                secondary
                icon="folder-opened"
                type="button"
                onClick={handlePickConfig}
              >
                浏览
              </VscodeButton>
            </div>
            <span className="pretrained-model-form-hint">
              SAM2 需要权重与 yaml 架构配置成对使用，变体必须一致（如 base_plus
              配 sam2.1_hiera_b+.yaml）。
            </span>
          </div>

          <div className="pretrained-model-form-field">
            <VscodeButton
              secondary
              icon="folder"
              type="button"
              disabled={scanning}
              onClick={handleImportSam2Directory}
            >
              {scanning ? '扫描中…' : '从 SAM2 目录导入'}
            </VscodeButton>
            <span className="pretrained-model-form-hint">
              选择含 checkpoints/ 与 configs/sam2.1/
              的根目录，自动配对第一个可用变体。
            </span>
          </div>
        </>
      )}

      {form.modelType === 'keypoint_estimation' && (
        <div className="pretrained-model-form-field pretrained-model-form-import-row">
          {form.keypointBackend === 'face_alignment' ? (
            <VscodeButton
              secondary
              icon="folder"
              type="button"
              disabled={scanning}
              onClick={handleImportFaceAlignmentDirectory}
            >
              {scanning ? '扫描中…' : '从目录导入'}
            </VscodeButton>
          ) : (
            <VscodeButton
              secondary
              icon="folder"
              type="button"
              disabled={scanning}
              onClick={handleImportKeypointBundleDirectory}
            >
              {scanning ? '扫描中…' : '从目录导入'}
            </VscodeButton>
          )}
          <span className="pretrained-model-form-hint">
            {form.keypointBackend === 'face_alignment'
              ? '选择模型根目录，自动配对 2DFAN 主权重与 s3fd 检测器。'
              : '选择模型根目录，自动扫描 YOLO-Pose（*-pose.pt）与 MediaPipe Hand（*.task）等文件。'}
          </span>
        </div>
      )}

      {form.modelType === 'object_detection' && (
        <div className="pretrained-model-form-field">
          <span className="pretrained-model-form-label">检测模式</span>
          <div className="pretrained-model-type-options">
            {(
              [
                ['detect', '普通矩形框 (Detect)'],
                ['obb', '旋转框 (OBB)'],
              ] as [ObjectDetectionMode, string][]
            ).map(([value, label]) => (
              <label key={value} className="pretrained-model-type-option">
                <input
                  type="radio"
                  name="detectionMode"
                  value={value}
                  checked={(form.detectionMode ?? 'detect') === value}
                  onChange={() => updateForm({ detectionMode: value })}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}

      {form.modelType === 'object_detection' && (
        <div className="pretrained-model-form-advanced">
          <span className="pretrained-model-form-label">推理参数</span>
          <div className="pretrained-model-form-grid">
            <label>
              置信度
              <input
                type="number"
                min={0.05}
                max={0.95}
                step={0.05}
                value={form.params?.confThreshold ?? 0.7}
                onChange={(e) =>
                  updateParams({ confThreshold: Number(e.target.value) })
                }
              />
            </label>
            <label>
              IoU
              <input
                type="number"
                min={0.1}
                max={0.9}
                step={0.05}
                value={form.params?.iouThreshold ?? 0.5}
                onChange={(e) =>
                  updateParams({ iouThreshold: Number(e.target.value) })
                }
              />
            </label>
          </div>
        </div>
      )}

      {form.modelType === 'image_segmentation' && (
        <div className="pretrained-model-form-advanced">
          <span className="pretrained-model-form-label">多边形参数</span>
          <div className="pretrained-model-form-grid">
            <label>
              最小面积
              <input
                type="number"
                min={1}
                step={10}
                value={form.params?.minArea ?? 100}
                onChange={(e) =>
                  updateParams({ minArea: Number(e.target.value) })
                }
              />
            </label>
            <label>
              简化系数
              <input
                type="number"
                min={0.001}
                max={0.05}
                step={0.001}
                value={form.params?.epsilonRatio ?? 0.006}
                onChange={(e) =>
                  updateParams({ epsilonRatio: Number(e.target.value) })
                }
              />
            </label>
          </div>
        </div>
      )}

      {form.modelType === 'keypoint_estimation' && (
        <div className="pretrained-model-form-advanced">
          <span className="pretrained-model-form-label">关键点参数</span>
          <div className="pretrained-model-form-grid">
            <label>
              关键点置信度
              <input
                type="number"
                min={0.05}
                max={0.95}
                step={0.05}
                value={form.params?.kptConfThreshold ?? 0.5}
                onChange={(e) =>
                  updateParams({ kptConfThreshold: Number(e.target.value) })
                }
              />
            </label>
            <label>
              最大实例数
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={form.params?.maxInstances ?? 20}
                onChange={(e) =>
                  updateParams({ maxInstances: Number(e.target.value) })
                }
              />
            </label>
          </div>
        </div>
      )}

      <div className="pretrained-model-form-field pretrained-model-form-switches">
        <label className="pretrained-model-switch">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => updateForm({ enabled: e.target.checked })}
          />
          启用
        </label>
        <label className="pretrained-model-switch">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => updateForm({ isDefault: e.target.checked })}
          />
          设为
          {form.modelType === 'keypoint_estimation'
            ? '该模板默认'
            : '该类型默认'}
        </label>
      </div>

      <div className="pretrained-model-form-field">
        <label htmlFor="pm-desc">描述（可选）</label>
        <textarea
          id="pm-desc"
          rows={2}
          value={form.description ?? ''}
          onChange={(e) => updateForm({ description: e.target.value })}
          placeholder="用途说明"
        />
      </div>

      {!isNew && (
        <div className="pretrained-model-form-field">
          <span className="pretrained-model-form-label">模型标识</span>
          <code className="pretrained-model-id">{form.id}</code>
        </div>
      )}

      {validationMessages.length > 0 && (
        <ul className="pretrained-model-validation-list">
          {validationMessages.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}

      {error && <p className="pretrained-model-form-error">{error}</p>}

      <div className="pretrained-model-form-actions">
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
