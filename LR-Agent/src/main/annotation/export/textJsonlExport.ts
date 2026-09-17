import path from 'path';
import fs from 'fs-extra';
import type { AnnotationType } from '../../../renderer/types/annotation';
import type { LabelResolver } from './labelUtil';
import { isSyntheticPath, writeText } from './fsUtil';
import type { LoadedTextDoc } from './types';

async function readSourceText(
  projectDir: string,
  relativePath: string,
): Promise<string | undefined> {
  if (isSyntheticPath(relativePath)) return undefined;
  const abs = path.join(projectDir, relativePath);
  if (!(await fs.pathExists(abs))) return undefined;
  try {
    return await fs.readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
}

function sourceFileField(relativePath: string): string | null {
  return isSyntheticPath(relativePath)
    ? null
    : relativePath.replace(/\\/g, '/');
}

export async function exportTextJsonl(
  projectDir: string,
  outputDir: string,
  annotationType: AnnotationType,
  docs: LoadedTextDoc[],
  labels: LabelResolver,
): Promise<{ filesWritten: number; lineCount: number }> {
  const lines: string[] = [];

  for (const doc of docs) {
    const sourceFile = sourceFileField(doc.relativePath);
    const textContent = await readSourceText(projectDir, doc.relativePath);

    switch (annotationType) {
      case 'instruction':
        for (const ann of doc.annotations) {
          if (ann.kind !== 'instruction') continue;
          lines.push(
            JSON.stringify({
              instruction: ann.instruction,
              input: ann.input ?? '',
              output: ann.output,
              label: ann.labelId ? labels.name(String(ann.labelId)) : undefined,
              source_file: sourceFile,
            }),
          );
        }
        break;
      case 'cot':
        for (const ann of doc.annotations) {
          if (ann.kind !== 'cot') continue;
          lines.push(
            JSON.stringify({
              instruction: ann.instruction ?? '',
              input: ann.input ?? '',
              steps: ann.steps,
              answer: ann.answer,
              source_file: sourceFile,
            }),
          );
        }
        break;
      case 'conversation':
        for (const ann of doc.annotations) {
          if (ann.kind !== 'conversation') continue;
          lines.push(
            JSON.stringify({
              messages: ann.turns,
              source_file: sourceFile,
            }),
          );
        }
        break;
      case 'preference':
        for (const ann of doc.annotations) {
          if (ann.kind !== 'preference') continue;
          lines.push(
            JSON.stringify({
              prompt: ann.prompt,
              chosen: ann.chosen,
              rejected: ann.rejected,
              note: ann.preferenceNote ?? undefined,
              source_file: sourceFile,
            }),
          );
        }
        break;
      case 'span_ner': {
        const spans = doc.annotations
          .filter((a) => a.kind === 'span_ner')
          .map((ann) => {
            const labelId = String(ann.labelId ?? '');
            return {
              start: ann.start,
              end: ann.end,
              label: labelId,
              label_name: labelId ? labels.name(labelId) : 'unknown',
            };
          });
        if (spans.length > 0) {
          lines.push(
            JSON.stringify({
              source_file: sourceFile,
              text: textContent,
              spans,
            }),
          );
        }
        break;
      }
      case 'text_classification': {
        const labelRows = doc.annotations
          .filter((a) => a.kind === 'text_classification')
          .map((ann) => {
            const labelId = String(ann.labelId ?? '');
            return {
              label: labelId,
              label_name: labelId ? labels.name(labelId) : 'unknown',
              note: ann.note,
            };
          });
        if (labelRows.length > 0) {
          lines.push(
            JSON.stringify({
              source_file: sourceFile,
              text: textContent,
              labels: labelRows,
            }),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  const fileName = `${annotationType}.jsonl`;
  await writeText(path.join(outputDir, fileName), lines.join('\n'));
  return { filesWritten: 1, lineCount: lines.length };
}
