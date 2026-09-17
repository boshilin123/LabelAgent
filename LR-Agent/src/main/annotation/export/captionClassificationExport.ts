import path from 'path';
import type { LabelResolver } from './labelUtil';
import { exportedMediaPath, type CopyMediaResult } from './copySourceMedia';
import { writeText } from './fsUtil';
import type { LoadedImageDoc } from './types';

export async function exportCaptionJsonl(
  docs: LoadedImageDoc[],
  labels: LabelResolver,
  outputDir: string,
  pathMap: Map<string, string>,
): Promise<number> {
  const lines: string[] = [];
  for (const doc of docs) {
    const image = exportedMediaPath(pathMap, doc.relativePath, 'images');
    for (const ann of doc.annotations) {
      if (ann.kind !== 'caption') continue;
      lines.push(
        JSON.stringify({
          image,
          text: ann.text,
          granularity: ann.granularity,
          language: ann.language,
          source_path: doc.filePath.replace(/\\/g, '/'),
          label: ann.labelId ? labels.name(String(ann.labelId)) : undefined,
        }),
      );
    }
  }
  await writeText(path.join(outputDir, 'captions.jsonl'), lines.join('\n'));
  return 1;
}

export async function exportClassificationCsv(
  docs: LoadedImageDoc[],
  labels: LabelResolver,
  outputDir: string,
  pathMap: Map<string, string>,
): Promise<number> {
  const rows = ['image,label,label_name,source_path'];
  for (const doc of docs) {
    const image = exportedMediaPath(pathMap, doc.relativePath, 'images');
    for (const ann of doc.annotations) {
      if (ann.kind !== 'classification') continue;
      const labelId = String(ann.labelId ?? '');
      rows.push(
        `${JSON.stringify(image)},${JSON.stringify(labelId)},${JSON.stringify(labels.name(labelId))},${JSON.stringify(doc.filePath.replace(/\\/g, '/'))}`,
      );
    }
  }
  await writeText(path.join(outputDir, 'classifications.csv'), rows.join('\n'));
  return 1;
}

export type { CopyMediaResult };
