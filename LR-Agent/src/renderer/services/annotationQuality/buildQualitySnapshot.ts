import type { AnnotationProjectSnapshot } from '../../../shared/annotationAgentTypes';
import { parseFileAnnotationDocument } from '../../types/annotationDocument';
import type { AnnotationQualitySnapshot, QualityScope } from './types';

const DEFAULT_MAX_FILES = 5000;

function sanitizeUnicodeText(text: string): string {
  return text.replace(/\uFFFD/g, '').replace(/[\uD800-\uDFFF]/g, '');
}

function normalizeFolderPath(folderPath: string): string {
  return folderPath.split(/[/\\]/).filter(Boolean).join('/');
}

function isInFolder(relativePath: string, folderPath: string): boolean {
  const normalizedFolder = normalizeFolderPath(folderPath);
  if (!normalizedFolder) return true;
  const normalizedPath = normalizeFolderPath(relativePath);
  const parent = normalizeFolderPath(
    normalizedPath.split('/').slice(0, -1).join('/'),
  );
  return (
    parent === normalizedFolder ||
    parent.startsWith(`${normalizedFolder}/`) ||
    normalizedPath.startsWith(`${normalizedFolder}/`)
  );
}

export interface BuildQualitySnapshotOptions {
  project: AnnotationProjectSnapshot;
  scope: QualityScope;
  scopePath?: string;
  maxFiles?: number;
  onProgress?: (processed: number, total: number) => void;
}

export async function buildQualitySnapshot(
  options: BuildQualitySnapshotOptions,
): Promise<AnnotationQualitySnapshot> {
  const {
    project,
    scope,
    scopePath,
    maxFiles = DEFAULT_MAX_FILES,
    onProgress,
  } = options;

  const catalog = await window.electron?.annotationAgent?.listImages(
    project.directoryPath,
    maxFiles,
  );

  const labelNameById = new Map(
    project.labels.map((l) => [l.id, l.name] as const),
  );

  let filesCatalog = catalog ?? [];
  if (scope === 'current_folder' && scopePath) {
    const folder = normalizeFolderPath(scopePath);
    filesCatalog = filesCatalog.filter(
      (item) =>
        isInFolder(item.relativePath, folder) ||
        normalizeFolderPath(item.parent) === folder,
    );
  }

  const files: AnnotationQualitySnapshot['files'] = [];
  let annotatedFiles = 0;
  let totalBoxes = 0;
  const total = filesCatalog.length;

  for (let i = 0; i < filesCatalog.length; i += 1) {
    const item = filesCatalog[i];
    onProgress?.(i + 1, total);

    const raw = await window.electron?.annotation?.readFileAnnotationDoc(
      project.directoryPath,
      item.relativePath,
    );
    const parsed = raw ? parseFileAnnotationDocument(raw) : null;
    const bboxes = (parsed?.annotations ?? []).filter((a) => a.kind === 'bbox');

    if (bboxes.length > 0) {
      annotatedFiles += 1;
    }
    totalBoxes += bboxes.length;

    const boxes = bboxes.map((box) => {
      const rawName = box.labelId
        ? (labelNameById.get(box.labelId) ?? box.labelId)
        : '(unlabeled)';
      const labelName = sanitizeUnicodeText(rawName);
      const area = box.width * box.height;
      return {
        id: box.id,
        labelId: box.labelId,
        labelName,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        area,
      };
    });

    files.push({
      relativePath: sanitizeUnicodeText(item.relativePath),
      imageWidth: parsed?.source?.width,
      imageHeight: parsed?.source?.height,
      boxes,
    });
  }

  return {
    schemaVersion: 1,
    scope,
    scopePath: scopePath ? normalizeFolderPath(scopePath) : undefined,
    projectId: sanitizeUnicodeText(project.projectId),
    projectName: sanitizeUnicodeText(project.name),
    annotationType: 'bbox',
    labels: project.labels.map((l) => ({
      id: l.id,
      name: sanitizeUnicodeText(l.name),
    })),
    totalFiles: filesCatalog.length,
    annotatedFiles,
    totalBoxes,
    files,
  };
}

export function deriveCurrentFolderPath(
  relativeFilePath: string | null,
): string {
  if (!relativeFilePath) return '';
  const parts = normalizeFolderPath(relativeFilePath).split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}
