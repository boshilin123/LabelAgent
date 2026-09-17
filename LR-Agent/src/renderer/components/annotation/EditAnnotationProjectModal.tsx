import { FormEvent, useEffect, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import {
  AnnotationProject,
  LabelDefinition,
  UpdateAnnotationProjectInput,
  getAnnotationTypeLabel,
  TASK_TYPE_CONFIG,
} from '../../types/annotation';
import { useAnnotation } from '../../context/AnnotationContext';
import LabelEditor, { normalizeLabels } from './LabelEditor';
import { buildDefaultKeypointLabels } from '../../types/keypointTemplate';
import './EditAnnotationProjectModal.css';

interface EditAnnotationProjectModalProps {
  project: AnnotationProject;
  onClose: () => void;
}

export default function EditAnnotationProjectModal({
  project,
  onClose,
}: EditAnnotationProjectModalProps) {
  const { updateProject, openWorkspaceMemory, closeEditProject } =
    useAnnotation();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [labels, setLabels] = useState<LabelDefinition[]>(project.labels);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? '');
    setLabels(project.labels);
    setError(null);
    setSubmitting(false);
  }, [project]);

  const isKeypointProject = project.annotationType === 'keypoint';

  const handleGenerateTemplateLabels = () => {
    setLabels(buildDefaultKeypointLabels());
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('任务名称不能为空');
      return;
    }

    setSubmitting(true);
    setError(null);

    const input: UpdateAnnotationProjectInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      labels: normalizeLabels(labels),
    };

    try {
      await updateProject(project.id, input);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalMotion
      open
      onClose={onClose}
      closeOnBackdropClick={false}
      dialogClassName="edit-annotation-project-dialog"
      dialogRole="form"
      labelledBy="edit-annotation-project-title"
      onSubmit={handleSubmit}
    >
      <div className="edit-annotation-project-header">
        <h3 id="edit-annotation-project-title">编辑项目设置</h3>
        <button
          type="button"
          className="edit-annotation-project-close"
          aria-label="关闭"
          onClick={onClose}
        >
          <VscodeIcon name="close" size={16} />
        </button>
      </div>

      {error && <div className="edit-annotation-project-error">{error}</div>}

      <div className="edit-annotation-project-readonly">
        <div className="edit-annotation-project-readonly-row">
          <span className="edit-annotation-project-readonly-label">
            项目目录
          </span>
          <span
            className="edit-annotation-project-readonly-value"
            title={project.directoryPath}
          >
            {project.directoryPath}
          </span>
        </div>
        <div className="edit-annotation-project-readonly-row">
          <span className="edit-annotation-project-readonly-label">
            任务类型
          </span>
          <span className="edit-annotation-project-readonly-value">
            {TASK_TYPE_CONFIG[project.modality].label} ·{' '}
            {getAnnotationTypeLabel(project.modality, project.annotationType)}
          </span>
        </div>
      </div>

      <div className="edit-annotation-project-body">
        <div className="edit-annotation-project-field">
          <label
            className="edit-annotation-project-label"
            htmlFor="edit-project-name"
          >
            <span>
              任务名称 <span className="required">*</span>
            </span>
            <input
              id="edit-project-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
        </div>

        <div className="edit-annotation-project-field">
          <label
            className="edit-annotation-project-label"
            htmlFor="edit-project-description"
          >
            <span>任务概述</span>
            <textarea
              id="edit-project-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="可选，描述任务目标或注意事项"
            />
          </label>
        </div>

        <button
          type="button"
          className="edit-annotation-project-memory-link"
          onClick={() => {
            closeEditProject();
            openWorkspaceMemory(project);
          }}
        >
          <VscodeIcon name="thinking" size={14} />
          <span>
            管理工作区记忆
            {project.workspaceMemoryEnabled ? '（已开启）' : '（未开启）'}
          </span>
        </button>

        <LabelEditor
          labels={labels}
          onChange={setLabels}
          keypointMode={isKeypointProject}
        />
        {isKeypointProject && labels.length === 0 ? (
          <VscodeButton
            secondary
            icon="symbol-ruler"
            type="button"
            className="edit-annotation-project-generate-labels"
            onClick={handleGenerateTemplateLabels}
          >
            从骨架模板生成默认标签
          </VscodeButton>
        ) : null}
      </div>

      <div className="edit-annotation-project-actions">
        <VscodeButton secondary icon="close" type="button" onClick={onClose}>
          取消
        </VscodeButton>
        <VscodeButton icon="save" type="submit" disabled={submitting}>
          {submitting ? '保存中…' : '保存设置'}
        </VscodeButton>
      </div>
    </ModalMotion>
  );
}
