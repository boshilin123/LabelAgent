import path from 'path';
import fs from 'fs-extra';
import type { AnnotationExportRequest } from '../../../shared/annotationExportTypes';
import { annotationsRoot } from '../annotationDataStore';
import {
  copySourceMediaForDocs,
  type CopyMediaResult,
} from './copySourceMedia';
import { isSyntheticPath, writeJson } from './fsUtil';
import type { LoadedDoc } from './types';

export interface NativeExportResult {
  filesWritten: number;
  media?: CopyMediaResult;
}

export async function exportNativeBundle(
  request: AnnotationExportRequest,
  docs: LoadedDoc[],
  warnings: string[],
): Promise<NativeExportResult> {
  const { project, options } = request;
  const projectDir = project.directoryPath;
  const { outputDir } = options;
  let filesWritten = 0;

  if (options.includeLrAgentAnnotations) {
    const destRoot = path.join(outputDir, 'lr-agent-export');
    const srcRoot = annotationsRoot(projectDir);
    if (await fs.pathExists(srcRoot)) {
      await fs.copy(srcRoot, destRoot, { overwrite: true });
      filesWritten += 1;
    }
  }

  let media: CopyMediaResult | undefined;
  if (options.includeSourceMedia) {
    const folder = project.modality === 'text' ? 'sources' : 'images';
    const paths = docs
      .map((d) => d.relativePath)
      .filter((p) => !isSyntheticPath(p));
    media = await copySourceMediaForDocs(projectDir, outputDir, paths, folder);
    filesWritten += media.copiedCount;
    if (media.missing.length > 0) {
      warnings.push(`有 ${media.missing.length} 个源文件未找到，未拷贝`);
    }
  }

  const manifest = {
    exportedAt: new Date().toISOString(),
    modality: project.modality,
    annotationType: project.annotationType,
    fileCount: docs.length,
    annotationCount: docs.reduce((n, d) => n + d.annotations.length, 0),
    files: docs.map((d) => d.relativePath),
    warnings,
  };
  await writeJson(path.join(outputDir, 'export-manifest.json'), manifest);
  filesWritten += 1;

  return { filesWritten, media };
}
