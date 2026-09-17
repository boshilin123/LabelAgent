/** Span NER generation pipeline. */

import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../../../shared/annotationAgentTypes';
import { ANNOTATION_GENERATE_CONCURRENCY } from '../../../../shared/annotationAgentTypes';
import type { SpanAnnotation } from '../../../types/annotationDocument';
import { callLlmApi } from './llmUtil';
import { readSourceTextForProject } from './sourceTextUtil';
import { mapWithConcurrency } from '../runWithConcurrency';
import {
  type RawSpanRow,
  validateSpanRows,
  validatedSpansToAnnotations,
} from './spanValidation';

function buildSystemPrompt(project: AnnotationProjectSnapshot): string {
  const labelList = project.labels
    .map((l) => `- id: "${l.id}", name: "${l.name}"`)
    .join('\n');

  return `你是一个命名实体识别（NER）专家。根据用户提供的文本，识别所有实体片段并分配标签。

可用实体标签：
${labelList || '（无预定义标签）'}

请严格按照以下 JSON 格式输出（不要输出其他内容）：
{
  "spans": [
    { "text": "实体在原文中的精确文本", "labelName": "标签名称", "labelId": "可选标签 id" }
  ]
}

要求：
- text 必须与原文中的片段完全一致（含标点）
- 不要输出不在标签列表中的标签
- 若无实体，返回 spans: []`;
}

export interface SpanNerPipelineOptions {
  inputPaths: { relativePath: string; absolutePath: string }[];
  userRequest: string;
  providerId: string;
  providerApiKey: string;
  providerBaseUrl: string;
  providerModel: string;
  project: AnnotationProjectSnapshot;
  isCancelled?: () => boolean;
  onProgress?: (message: string) => void;
}

export async function runSpanNerPipeline(
  options: SpanNerPipelineOptions,
): Promise<{
  annotations: SpanAnnotation[];
  changes: AnnotationBatchChange[];
}> {
  const changes = await mapWithConcurrency(
    options.inputPaths,
    ANNOTATION_GENERATE_CONCURRENCY,
    async (input) => {
      if (options.isCancelled?.()) return undefined;
      options.onProgress?.(`正在为 ${input.relativePath} 识别实体…`);

      const sourceText = await readSourceTextForProject(
        options.project.directoryPath,
        input.relativePath,
      );
      if (!sourceText.trim()) return undefined;

      const result = await callLlmApi({
        providerId: options.providerId,
        apiKey: options.providerApiKey,
        baseUrl: options.providerBaseUrl,
        model: options.providerModel,
        systemPrompt: buildSystemPrompt(options.project),
        userPrompt: `${options.userRequest || '请识别以下文本中的所有命名实体。'}\n\n---\n${sourceText.slice(0, 8000)}\n---`,
        temperature: 0.2,
      });

      if (!result.ok) return undefined;

      const rows = parseSpanRows(result.content);
      const { spans, skipped } = validateSpanRows(
        sourceText,
        rows,
        options.project.labels,
      );
      if (spans.length === 0) {
        if (skipped > 0) {
          options.onProgress?.(
            `${input.relativePath}：跳过 ${skipped} 条无效 span`,
          );
        }
        return undefined;
      }

      return {
        relativePath: input.relativePath,
        absolutePath: input.absolutePath,
        operation: 'append' as const,
        annotations: validatedSpansToAnnotations(spans),
      };
    },
    options.isCancelled,
  );

  const annotations = changes.flatMap(
    (c) => (c.annotations as SpanAnnotation[]) ?? [],
  );
  return { annotations, changes };
}

function parseSpanRows(content: string): RawSpanRow[] {
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed.spans) ? parsed.spans : [];
  } catch {
    return [];
  }
}
