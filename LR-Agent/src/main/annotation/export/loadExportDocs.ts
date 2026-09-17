import type { AnnotationType } from '../../../renderer/types/annotation';
import { loadAllAnnotationDocs } from '../annotationDataStore';
import { isSyntheticPath } from './fsUtil';
import type {
  LoadedDoc,
  LoadedImageDoc,
  LoadedTextDoc,
  LoadDocsResult,
} from './types';

function normalizeRecord(doc: unknown): Record<string, unknown> | null {
  if (!doc || typeof doc !== 'object') return null;
  return doc as Record<string, unknown>;
}

function parseImageDoc(
  relativePath: string,
  record: Record<string, unknown>,
  includeEmpty: boolean,
): { doc: LoadedImageDoc | null; skipReason?: string } {
  const sourceRaw = record.source;
  if (
    !sourceRaw ||
    typeof sourceRaw !== 'object' ||
    typeof (sourceRaw as { width?: unknown }).width !== 'number' ||
    typeof (sourceRaw as { height?: unknown }).height !== 'number'
  ) {
    return {
      doc: null,
      skipReason: `${relativePath}: 缺少有效的 source.width/height`,
    };
  }
  const annotations = Array.isArray(record.annotations)
    ? (record.annotations as Record<string, unknown>[])
    : [];
  if (!includeEmpty && annotations.length === 0) {
    return { doc: null };
  }
  return {
    doc: {
      kind: 'image',
      relativePath,
      filePath:
        typeof record.filePath === 'string' ? record.filePath : relativePath,
      source: sourceRaw as { width: number; height: number },
      annotations,
      modality:
        typeof record.modality === 'string' ? record.modality : undefined,
      annotationType:
        typeof record.annotationType === 'string'
          ? record.annotationType
          : undefined,
    },
  };
}

function parseTextDoc(
  relativePath: string,
  record: Record<string, unknown>,
  includeEmpty: boolean,
): LoadedTextDoc | null {
  const annotations = Array.isArray(record.annotations)
    ? (record.annotations as Record<string, unknown>[])
    : [];
  if (!includeEmpty && annotations.length === 0) {
    return null;
  }
  return {
    kind: 'text',
    relativePath,
    filePath:
      typeof record.filePath === 'string' ? record.filePath : relativePath,
    annotations,
    modality: typeof record.modality === 'string' ? record.modality : undefined,
    annotationType:
      typeof record.annotationType === 'string'
        ? record.annotationType
        : undefined,
  };
}

export async function loadExportDocs(
  projectDir: string,
  modality: 'text' | 'image',
  annotationType: AnnotationType,
  includeEmpty: boolean,
): Promise<LoadDocsResult> {
  const rawDocs = await loadAllAnnotationDocs(projectDir);
  const docs: LoadedDoc[] = [];
  const skippedFiles: string[] = [];
  const warnings: string[] = [];

  for (const { relativePath, doc } of rawDocs) {
    const record = normalizeRecord(doc);
    if (!record) {
      skippedFiles.push(`${relativePath}: 文档无效`);
      continue;
    }

    const docModality =
      typeof record.modality === 'string' ? record.modality : modality;
    const docAnnType =
      typeof record.annotationType === 'string'
        ? record.annotationType
        : annotationType;

    if (docAnnType !== annotationType) {
      warnings.push(
        `${relativePath}: annotationType 为 ${docAnnType}，与项目 ${annotationType} 不一致，已跳过`,
      );
      continue;
    }

    if (modality === 'text' || docModality === 'text') {
      const parsed = parseTextDoc(relativePath, record, includeEmpty);
      if (parsed) {
        docs.push(parsed);
        if (isSyntheticPath(relativePath)) {
          warnings.push(
            `${relativePath}: 合成路径条目已导出（无 source_file）`,
          );
        }
      }
      continue;
    }

    const { doc: imageDoc, skipReason } = parseImageDoc(
      relativePath,
      record,
      includeEmpty,
    );
    if (imageDoc) {
      docs.push(imageDoc);
    } else if (skipReason) {
      skippedFiles.push(skipReason);
    }
  }

  return { docs, skippedFiles, warnings };
}

export function filterImageDocs(docs: LoadedDoc[]): LoadedImageDoc[] {
  return docs.filter((d): d is LoadedImageDoc => d.kind === 'image');
}

export function filterTextDocs(docs: LoadedDoc[]): LoadedTextDoc[] {
  return docs.filter((d): d is LoadedTextDoc => d.kind === 'text');
}
