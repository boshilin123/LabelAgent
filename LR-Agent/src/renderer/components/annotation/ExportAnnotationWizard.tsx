import { FormEvent, useEffect, useMemo, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import {
  AnnotationProject,
  getAnnotationTypeLabel,
  TASK_TYPE_CONFIG,
} from '../../types/annotation';
import {
  defaultExportFormat,
  DEFAULT_EXPORT_OPTIONS,
  getExportFormatsForType,
  type ExportCoordinateMode,
  type ExportFormatId,
  isImageAnnotationType,
} from '../../../shared/annotationExportTypes';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { exportAnnotationProject } from '../../services/annotationExportService';
import './ExportAnnotationWizard.css';

interface ExportAnnotationWizardProps {
  project: AnnotationProject | null;
  onClose: () => void;
  onExported?: (outputDir: string) => void;
}

function defaultOutputDir(project: AnnotationProject): string {
  const base = project.directoryPath.replace(/[/\\]+$/, '');
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}/exports/${stamp}`;
}

export default function ExportAnnotationWizard({
  project,
  onClose,
  onExported,
}: ExportAnnotationWizardProps) {
  const open = Boolean(project);
  const { activeProject } = useAnnotation();
  const { dirty, saveNow } = useAnnotationWorkspace();

  const formatOptions = useMemo(
    () => (project ? getExportFormatsForType(project.annotationType) : []),
    [project],
  );

  const [format, setFormat] = useState<ExportFormatId>('yolo');
  const [outputDir, setOutputDir] = useState('');
  const [coordinateMode, setCoordinateMode] =
    useState<ExportCoordinateMode>('pixel');
  const [includeEmptyImages, setIncludeEmptyImages] = useState(false);
  const [includeSourceMedia, setIncludeSourceMedia] = useState(
    DEFAULT_EXPORT_OPTIONS.includeSourceMedia,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);
  const [skippedFiles, setSkippedFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!project) return;
    setFormat(defaultExportFormat(project.annotationType));
    setOutputDir(defaultOutputDir(project));
    setCoordinateMode('pixel');
    setIncludeEmptyImages(false);
    setIncludeSourceMedia(DEFAULT_EXPORT_OPTIONS.includeSourceMedia);
    setSubmitting(false);
    setError(null);
    setSuccessMessage(null);
    setExportWarnings([]);
    setSkippedFiles([]);
  }, [project]);

  const showCoordinateMode =
    format === 'csv' &&
    project &&
    isImageAnnotationType(project.annotationType);
  const showIncludeEmptyImages =
    project?.modality === 'image' && format !== 'lr_agent';
  const showIncludeSourceMedia = format !== 'lr_agent';
  const canExport =
    project && outputDir.trim().length > 0 && formatOptions.length > 0;

  const handlePickDirectory = async () => {
    const picked = await window.electron.fileSystem.openDirectory();
    if (picked) setOutputDir(picked);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || !canExport) return;

    setSubmitting(true);
    setError(null);
    setSuccessMessage(null);
    setExportWarnings([]);
    setSkippedFiles([]);

    try {
      if (activeProject?.id === project.id && dirty) {
        await saveNow();
      }

      const result = await exportAnnotationProject(project, {
        format,
        outputDir: outputDir.trim(),
        coordinateMode,
        includeEmptyImages,
        includeSourceMedia,
        includeLrAgentAnnotations:
          DEFAULT_EXPORT_OPTIONS.includeLrAgentAnnotations,
      });

      if (!result.success) {
        setError(result.error ?? result.message);
        if (result.warnings?.length) setExportWarnings(result.warnings);
        if (result.skippedFiles?.length) setSkippedFiles(result.skippedFiles);
        return;
      }

      setSuccessMessage(result.message);
      if (result.warnings?.length) setExportWarnings(result.warnings);
      if (result.skippedFiles?.length) setSkippedFiles(result.skippedFiles);
      onExported?.(result.outputDir);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenOutputFolder = () => {
    if (!outputDir.trim()) return;
    window.electron.fileSystem.openPath(outputDir.trim());
  };

  if (!project) return null;

  const modalityLabel = TASK_TYPE_CONFIG[project.modality].label;
  const typeLabel = getAnnotationTypeLabel(
    project.modality,
    project.annotationType,
  );
  const sourceMediaLabel =
    project.modality === 'text' ? '包含源文本文件' : '包含源图片文件';

  return (
    <ModalMotion
      open={open}
      onClose={onClose}
      closeOnBackdropClick={false}
      dialogClassName="export-annotation-wizard"
      dialogRole="form"
      labelledBy="export-annotation-title"
      onSubmit={handleSubmit}
    >
      <div className="export-annotation-header">
        <h3 id="export-annotation-title">导出标注</h3>
        <button
          type="button"
          className="export-annotation-close"
          aria-label="关闭"
          onClick={onClose}
        >
          <VscodeIcon name="close" size={16} />
        </button>
      </div>

      <div className="export-annotation-meta">
        任务：<strong>{project.name}</strong>
        <br />
        类型：{modalityLabel} · {typeLabel}
        <br />
        标签数：{project.labels.length}
      </div>

      {error && <div className="export-annotation-error">{error}</div>}
      {successMessage && (
        <div className="export-annotation-success">{successMessage}</div>
      )}
      {(exportWarnings.length > 0 || skippedFiles.length > 0) && (
        <div className="export-annotation-warnings">
          {exportWarnings.length > 0 && (
            <>
              <strong>告警</strong>
              <ul>
                {exportWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          )}
          {skippedFiles.length > 0 && (
            <>
              <strong>跳过的文件</strong>
              <ul>
                {skippedFiles.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="export-annotation-body">
        <div className="export-annotation-field">
          <span className="export-annotation-label">导出格式</span>
          <div className="export-annotation-format-list" role="radiogroup">
            {formatOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={format === option.id}
                className={`export-annotation-format-option${
                  format === option.id ? ' selected' : ''
                }`}
                onClick={() => setFormat(option.id)}
              >
                <span className="export-annotation-format-name">
                  {option.label}
                </span>
                <span className="export-annotation-format-desc">
                  {option.description}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="export-annotation-field">
          <label
            className="export-annotation-label"
            htmlFor="export-output-dir"
          >
            输出目录
          </label>
          <div className="export-annotation-directory-row">
            <input
              id="export-output-dir"
              type="text"
              value={outputDir}
              onChange={(event) => setOutputDir(event.target.value)}
              placeholder="选择导出目标文件夹"
              required
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

        {showCoordinateMode && (
          <div className="export-annotation-field">
            <label
              className="export-annotation-label"
              htmlFor="export-coord-mode"
            >
              CSV 坐标单位
            </label>
            <select
              id="export-coord-mode"
              className="export-annotation-select"
              value={coordinateMode}
              onChange={(event) =>
                setCoordinateMode(event.target.value as ExportCoordinateMode)
              }
            >
              <option value="pixel">像素</option>
              <option value="normalized">归一化 (0–1)</option>
            </select>
          </div>
        )}

        {showIncludeEmptyImages && (
          <label className="export-annotation-checkbox-row">
            <input
              type="checkbox"
              checked={includeEmptyImages}
              onChange={(event) => setIncludeEmptyImages(event.target.checked)}
            />
            包含 index 中无标注的已索引文件
          </label>
        )}

        {showIncludeSourceMedia && (
          <label className="export-annotation-checkbox-row">
            <input
              type="checkbox"
              checked={includeSourceMedia}
              onChange={(event) => setIncludeSourceMedia(event.target.checked)}
            />
            {sourceMediaLabel}
          </label>
        )}
      </div>

      <div className="export-annotation-actions">
        {successMessage && (
          <VscodeButton
            secondary
            icon="folder"
            type="button"
            onClick={handleOpenOutputFolder}
          >
            打开输出文件夹
          </VscodeButton>
        )}
        <VscodeButton secondary icon="close" type="button" onClick={onClose}>
          {successMessage ? '关闭' : '取消'}
        </VscodeButton>
        {!successMessage && (
          <VscodeButton
            icon="export"
            type="submit"
            disabled={!canExport || submitting}
          >
            {submitting ? '导出中…' : '开始导出'}
          </VscodeButton>
        )}
      </div>
    </ModalMotion>
  );
}
