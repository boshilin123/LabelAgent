import { FormEvent, useEffect, useMemo, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import { basename } from '../../types/file';
import {
  AnnotationType,
  CreateAnnotationProjectInput,
  LabelDefinition,
  Modality,
  TASK_TYPE_CONFIG,
  annotationTypeRequiresLabels,
  getDefaultAnnotationType,
} from '../../types/annotation';
import { findProjectByDirectory } from '../../services/annotationProjectStore';
import { useAnnotation } from '../../context/AnnotationContext';
import LabelEditor, { normalizeLabels } from './LabelEditor';
import WorkspaceMemoryToggle from './WorkspaceMemoryToggle';
import { buildDefaultKeypointLabels } from '../../types/keypointTemplate';
import './CreateAnnotationProjectWizard.css';

interface CreateAnnotationProjectWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (projectId: string) => void;
}

type WizardStep = 1 | 2 | 3;

const STEP_TITLES: Record<WizardStep, string> = {
  1: '基本信息',
  2: '任务类型',
  3: '标签定义',
};

export default function CreateAnnotationProjectWizard({
  open,
  onClose,
  onCreated,
}: CreateAnnotationProjectWizardProps) {
  const { projects, createProject, openProject } = useAnnotation();

  const [step, setStep] = useState<WizardStep>(1);
  const [directoryPath, setDirectoryPath] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [modality, setModality] = useState<Modality>('image');
  const [annotationType, setAnnotationType] = useState<AnnotationType>(
    getDefaultAnnotationType('image'),
  );
  const [labels, setLabels] = useState<LabelDefinition[]>([]);
  const [workspaceMemoryEnabled, setWorkspaceMemoryEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const annotationOptions = useMemo(
    () => TASK_TYPE_CONFIG[modality].types,
    [modality],
  );
  const requiresLabels = annotationTypeRequiresLabels(annotationType);
  const maxStep: WizardStep = requiresLabels ? 3 : 2;
  const visibleSteps = useMemo(
    () => (requiresLabels ? [1, 2, 3] : [1, 2]) as WizardStep[],
    [requiresLabels],
  );

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setDirectoryPath('');
    setName('');
    setDescription('');
    setModality('image');
    setAnnotationType(getDefaultAnnotationType('image'));
    setLabels([]);
    setWorkspaceMemoryEnabled(false);
    setError(null);
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (annotationType !== 'keypoint') return;
    setLabels((prev) =>
      prev.length === 0 ? buildDefaultKeypointLabels() : prev,
    );
  }, [annotationType]);

  useEffect(() => {
    if (!requiresLabels && step === 3) {
      setStep(2);
    }
  }, [requiresLabels, step]);

  const handlePickDirectory = async () => {
    setError(null);
    const path = await window.electron.fileSystem.openDirectory();
    if (!path) return;

    setDirectoryPath(path);
    if (!name.trim()) {
      setName(basename(path));
    }

    const existing = findProjectByDirectory(projects, path);
    if (existing) {
      setError(`该目录已有标注任务「${existing.name}」，仍可继续创建。`);
    }
  };

  const handleModalityChange = (next: Modality) => {
    setModality(next);
    setAnnotationType(getDefaultAnnotationType(next));
  };

  const validateStep1 = (): boolean => {
    if (!directoryPath.trim()) {
      setError('请选择项目目录');
      return false;
    }
    if (!name.trim()) {
      setError('请输入任务名称');
      return false;
    }
    setError(null);
    return true;
  };

  const goNext = () => {
    if (step === 1 && !validateStep1()) return;
    setError(null);
    setStep((current) => Math.min(maxStep, current + 1) as WizardStep);
  };

  const goBack = () => {
    setError(null);
    setStep((current) => Math.max(1, current - 1) as WizardStep);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validateStep1()) {
      setStep(1);
      return;
    }

    setSubmitting(true);
    setError(null);

    const input: CreateAnnotationProjectInput = {
      directoryPath,
      name: name.trim(),
      modality,
      annotationType,
      labels: requiresLabels ? normalizeLabels(labels) : [],
      description: description.trim() || undefined,
      workspaceMemoryEnabled,
    };

    try {
      const project = await createProject(input);
      onClose();
      onCreated?.(project.id);
      await openProject(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalMotion
      open={open}
      onClose={onClose}
      closeOnBackdropClick={false}
      dialogClassName="create-annotation-wizard"
      dialogRole="form"
      labelledBy="create-annotation-title"
      onSubmit={step === maxStep ? handleSubmit : undefined}
    >
      <div className="create-annotation-header">
        <h3 id="create-annotation-title">新建标注任务</h3>
        <button
          type="button"
          className="create-annotation-close"
          aria-label="关闭"
          onClick={onClose}
        >
          <VscodeIcon name="close" size={16} />
        </button>
      </div>

      <div className="create-annotation-steps" aria-label="创建步骤">
        {visibleSteps.map((item) => (
          <span
            key={item}
            className={`create-annotation-step${
              step === item ? ' create-annotation-step-active' : ''
            }${step > item ? ' create-annotation-step-done' : ''}`}
          >
            {item}. {STEP_TITLES[item]}
          </span>
        ))}
      </div>

      {error && <div className="create-annotation-error">{error}</div>}

      {step === 1 && (
        <div className="create-annotation-body">
          <div className="create-annotation-field">
            <label
              className="create-annotation-label"
              htmlFor="project-directory"
            >
              项目目录 <span className="required">*</span>
            </label>
            <div className="create-annotation-directory-row">
              <input
                id="project-directory"
                type="text"
                readOnly
                placeholder="选择本地文件夹"
                value={directoryPath}
              />
              <VscodeButton
                secondary
                icon="folder-opened"
                type="button"
                onClick={handlePickDirectory}
              >
                浏览…
              </VscodeButton>
            </div>
          </div>

          <div className="create-annotation-field">
            <label className="create-annotation-label" htmlFor="project-name">
              任务名称 <span className="required">*</span>
            </label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="默认使用目录名称"
              required
            />
          </div>

          <div className="create-annotation-field">
            <label
              className="create-annotation-label"
              htmlFor="project-description"
            >
              任务概述
            </label>
            <textarea
              id="project-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="可选，描述任务目标或注意事项"
            />
          </div>

          <WorkspaceMemoryToggle
            id="project-workspace-memory"
            checked={workspaceMemoryEnabled}
            onChange={setWorkspaceMemoryEnabled}
          />
        </div>
      )}

      {step === 2 && (
        <div className="create-annotation-body">
          <fieldset className="create-annotation-fieldset">
            <legend className="create-annotation-label">
              模态类型 <span className="required">*</span>
            </legend>
            <div className="create-annotation-modality-grid">
              {(Object.keys(TASK_TYPE_CONFIG) as Modality[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`create-annotation-modality-card${
                    modality === key ? ' selected' : ''
                  }`}
                  onClick={() => handleModalityChange(key)}
                >
                  <VscodeIcon
                    name={key === 'image' ? 'file-media' : 'file-text'}
                    size={24}
                  />
                  <span>{TASK_TYPE_CONFIG[key].label}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="create-annotation-field">
            <label
              className="create-annotation-label"
              htmlFor="annotation-type"
            >
              标注类型 <span className="required">*</span>
            </label>
            <select
              id="annotation-type"
              value={annotationType}
              onChange={(event) =>
                setAnnotationType(event.target.value as AnnotationType)
              }
            >
              {annotationOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {requiresLabels && step === 3 && (
        <div className="create-annotation-body">
          <LabelEditor
            labels={labels}
            onChange={setLabels}
            keypointMode={annotationType === 'keypoint'}
          />
        </div>
      )}

      <div className="create-annotation-actions">
        <div className="create-annotation-actions-right">
          {step > 1 && (
            <VscodeButton
              secondary
              icon="chevron-left"
              type="button"
              onClick={goBack}
            >
              上一步
            </VscodeButton>
          )}
          {step < maxStep ? (
            <VscodeButton
              iconAfter="chevron-right"
              type="button"
              onClick={goNext}
            >
              下一步
            </VscodeButton>
          ) : (
            <VscodeButton icon="check" type="submit" disabled={submitting}>
              {submitting ? '创建中…' : '创建并打开'}
            </VscodeButton>
          )}
        </div>
      </div>
    </ModalMotion>
  );
}
