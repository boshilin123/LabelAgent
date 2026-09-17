/** Text classification generation pipeline. */

import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../../../shared/annotationAgentTypes';
import { ANNOTATION_GENERATE_CONCURRENCY } from '../../../../shared/annotationAgentTypes';
import type { TextClassificationAnnotation } from '../../../types/annotationDocument';
import { callLlmApi } from './llmUtil';
import { resolveUniqueLabelIds, resolveLabelId } from './labelResolve';
import { readSourceTextForProject } from './sourceTextUtil';
import { mapWithConcurrency } from '../runWithConcurrency';

function buildSystemPrompt(project: AnnotationProjectSnapshot): string {
  const labelList = project.labels
    .map((l) => `- id: "${l.id}", name: "${l.name}"`)
    .join('\n');

  return `你是一个文本分类专家。根据用户提供的文本内容和需求，从给定的标签列表中选择所有适用的分类标签（支持多标签）。

可用标签列表：
${labelList || '（无预定义标签）'}

请严格按照以下 JSON 格式输出（不要输出其他内容）：
{
  "labels": [
    { "labelId": "标签 id", "labelName": "标签名称", "reason": "选择理由" }
  ]
}

若文本不匹配任何标签，返回空数组 labels: []。`;
}

export interface TextClassificationPipelineOptions {
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

export async function runTextClassificationPipeline(
  options: TextClassificationPipelineOptions,
): Promise<{
  annotations: TextClassificationAnnotation[];
  changes: AnnotationBatchChange[];
}> {
  const changes = await mapWithConcurrency(
    options.inputPaths,
    ANNOTATION_GENERATE_CONCURRENCY,
    async (input) => {
      if (options.isCancelled?.()) return undefined;
      options.onProgress?.(`正在为 ${input.relativePath} 分类…`);

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
        userPrompt: `${options.userRequest || '请为以下文本选择所有适用的分类标签。'}\n\n---\n${sourceText.slice(0, 8000)}\n---`,
        temperature: 0.2,
      });

      if (!result.ok) return undefined;

      const labelIds = parseTextClassificationLabels(
        result.content,
        options.project,
      );
      if (labelIds.length === 0) return undefined;

      const now = new Date().toISOString();
      const annotations: TextClassificationAnnotation[] = labelIds.map(
        (labelId) => ({
          id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'text_classification',
          labelId,
          createdAt: now,
          updatedAt: now,
        }),
      );

      return {
        relativePath: input.relativePath,
        absolutePath: input.absolutePath,
        operation: 'append' as const,
        annotations,
      };
    },
    options.isCancelled,
  );

  const annotations = changes.flatMap(
    (c) => (c.annotations as TextClassificationAnnotation[]) ?? [],
  );
  return { annotations, changes };
}

function parseTextClassificationLabels(
  content: string,
  project: AnnotationProjectSnapshot,
): string[] {
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    const rows = Array.isArray(parsed.labels) ? parsed.labels : [];
    if (rows.length > 0) {
      return resolveUniqueLabelIds(rows, project.labels);
    }
    const singleId = resolveLabelId(
      parsed.labelId,
      parsed.labelName,
      project.labels,
    );
    return singleId ? [singleId] : [];
  } catch {
    return [];
  }
}
