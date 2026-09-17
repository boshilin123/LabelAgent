import type {
  AnnotationExportRequest,
  AnnotationExportResult,
} from '../../shared/annotationExportTypes';
import { shouldSkipForTrainingExport } from '../../shared/annotationLabel';
import {
  exportCaptionJsonl,
  exportClassificationCsv,
} from './export/captionClassificationExport';
import { copySourceMediaForDocs } from './export/copySourceMedia';
import {
  appendWarnings,
  missingMediaWarning,
  unknownLabelWarning,
} from './export/exportValidation';
import { ensureDir } from './export/fsUtil';
import { runImageTrainingExport } from './export/imageTrainingExport';
import { LabelResolver } from './export/labelUtil';
import {
  filterImageDocs,
  filterTextDocs,
  loadExportDocs,
} from './export/loadExportDocs';
import { exportNativeBundle } from './export/nativeExport';
import { exportTextJsonl } from './export/textJsonlExport';

function countSkippedUnlabeled(
  docs: { annotations: Record<string, unknown>[] }[],
): number {
  let count = 0;
  for (const doc of docs) {
    for (const ann of doc.annotations) {
      if (shouldSkipForTrainingExport(ann.labelId)) count += 1;
    }
  }
  return count;
}

function buildSuccessMessage(
  fileCount: number,
  annotationCount: number,
  filesWritten: number,
  skippedUnlabeled: number,
  modality: 'text' | 'image',
): string {
  const unit = modality === 'text' ? '个文件' : '张图片';
  if (skippedUnlabeled > 0) {
    return `已导出 ${fileCount} ${unit}、${annotationCount} 条标注，共 ${filesWritten} 个文件（跳过 ${skippedUnlabeled} 条未标注）`;
  }
  return `已导出 ${fileCount} ${unit}、${annotationCount} 条标注，共 ${filesWritten} 个文件`;
}

export async function runAnnotationExport(
  request: AnnotationExportRequest,
): Promise<AnnotationExportResult> {
  const { project, options } = request;

  try {
    await ensureDir(options.outputDir);

    const loaded = await loadExportDocs(
      project.directoryPath,
      project.modality,
      project.annotationType,
      options.includeEmptyImages,
    );
    const warnings = [...loaded.warnings];
    const skippedFiles = [...loaded.skippedFiles];

    if (loaded.docs.length === 0) {
      return {
        success: false,
        outputDir: options.outputDir,
        filesWritten: 0,
        imageCount: 0,
        annotationCount: 0,
        warnings: warnings.length > 0 ? warnings : undefined,
        skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
        message: '没有可导出的标注数据',
        error:
          project.modality === 'text'
            ? '索引中无有效文本标注文档，请先打开并保存至少一个文件的标注'
            : '索引中无有效标注文档，请先打开并保存至少一张图片的标注',
      };
    }

    const annotationCount = loaded.docs.reduce(
      (n, d) => n + d.annotations.length,
      0,
    );
    const { format } = options;
    let filesWritten = 0;
    let unknownLabelCount = 0;
    let skippedUnlabeled = 0;

    if (format === 'lr_agent') {
      const native = await exportNativeBundle(request, loaded.docs, warnings);
      filesWritten = native.filesWritten;
    } else if (project.modality === 'text') {
      const textDocs = filterTextDocs(loaded.docs);
      if (format === 'jsonl') {
        const resolver = new LabelResolver(project.labels);
        let mediaFiles = 0;
        if (options.includeSourceMedia) {
          const media = await copySourceMediaForDocs(
            project.directoryPath,
            options.outputDir,
            textDocs.map((d) => d.relativePath),
            'sources',
          );
          mediaFiles = media.copiedCount;
          const missingWarn = missingMediaWarning(media.missing.length);
          if (missingWarn) warnings.push(missingWarn);
        }
        const jsonl = await exportTextJsonl(
          project.directoryPath,
          options.outputDir,
          project.annotationType,
          textDocs,
          resolver,
        );
        filesWritten = jsonl.filesWritten + mediaFiles;
        unknownLabelCount = resolver.unknownCount;
      } else {
        throw new Error(`文本任务不支持导出格式: ${format}`);
      }
    } else {
      const imageDocs = filterImageDocs(loaded.docs);
      skippedUnlabeled = countSkippedUnlabeled(imageDocs);

      if (format === 'caption_jsonl') {
        const resolver = new LabelResolver(project.labels);
        let pathMap = new Map<string, string>();
        let mediaFiles = 0;
        if (options.includeSourceMedia) {
          const media = await copySourceMediaForDocs(
            project.directoryPath,
            options.outputDir,
            imageDocs.map((d) => d.relativePath),
            'images',
          );
          pathMap = media.pathMap;
          mediaFiles = media.copiedCount;
          const missingWarn = missingMediaWarning(media.missing.length);
          if (missingWarn) warnings.push(missingWarn);
        }
        filesWritten =
          (await exportCaptionJsonl(
            imageDocs,
            resolver,
            options.outputDir,
            pathMap,
          )) + mediaFiles;
        unknownLabelCount = resolver.unknownCount;
      } else if (format === 'classification_csv') {
        const resolver = new LabelResolver(project.labels);
        let pathMap = new Map<string, string>();
        let mediaFiles = 0;
        if (options.includeSourceMedia) {
          const media = await copySourceMediaForDocs(
            project.directoryPath,
            options.outputDir,
            imageDocs.map((d) => d.relativePath),
            'images',
          );
          pathMap = media.pathMap;
          mediaFiles = media.copiedCount;
          const missingWarn = missingMediaWarning(media.missing.length);
          if (missingWarn) warnings.push(missingWarn);
        }
        filesWritten =
          (await exportClassificationCsv(
            imageDocs,
            resolver,
            options.outputDir,
            pathMap,
          )) + mediaFiles;
        unknownLabelCount = resolver.unknownCount;
      } else {
        const result = await runImageTrainingExport(
          request,
          imageDocs,
          skippedUnlabeled,
        );
        filesWritten = result.filesWritten;
        unknownLabelCount = result.unknownLabelCount;
      }
    }

    const unknownWarn = unknownLabelWarning(unknownLabelCount);
    if (unknownWarn) warnings.push(unknownWarn);

    const fileCount = loaded.docs.length;
    return {
      success: true,
      outputDir: options.outputDir,
      filesWritten,
      imageCount: project.modality === 'image' ? fileCount : 0,
      annotationCount,
      skippedUnlabeledCount:
        skippedUnlabeled > 0 ? skippedUnlabeled : undefined,
      unknownLabelCount: unknownLabelCount > 0 ? unknownLabelCount : undefined,
      warnings: warnings.length > 0 ? appendWarnings([], warnings) : undefined,
      skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
      message: buildSuccessMessage(
        fileCount,
        annotationCount,
        filesWritten,
        skippedUnlabeled,
        project.modality,
      ),
    };
  } catch (err) {
    return {
      success: false,
      outputDir: options.outputDir,
      filesWritten: 0,
      imageCount: 0,
      annotationCount: 0,
      message: '导出失败',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
