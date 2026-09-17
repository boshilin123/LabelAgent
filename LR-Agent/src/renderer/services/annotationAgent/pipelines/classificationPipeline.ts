/** Image classification generation pipeline. */

import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../../../shared/annotationAgentTypes';
import { ANNOTATION_GENERATE_CONCURRENCY } from '../../../../shared/annotationAgentTypes';
import type { ClassificationAnnotation } from '../../../types/annotationDocument';
import { callLlmApi } from './llmUtil';
import { readImageBase64 } from '../fusionSubImageTools';
import { mapWithConcurrency } from '../runWithConcurrency';

function buildSystemPrompt(project: AnnotationProjectSnapshot): string {
  const labelList = project.labels
    .map((l) => `- id: "${l.id}", name: "${l.name}"`)
    .join('\n');

  return `你是一个图片分类专家。根据用户提供的图片和需求，从给定的标签列表中选择最匹配的分类标签。

可用标签列表：
${labelList || '（无预定义标签）'}

请严格按照以下 JSON 格式输出（不要输出其他内容）：
{
  "labelId": "选择的标签 id",
  "labelName": "选择的标签名称",
  "reason": "选择理由（一句话）"
}

如果图片不匹配任何标签，选择最接近的标签并在 reason 中说明。`;
}

export interface ClassificationPipelineOptions {
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

export async function runClassificationPipeline(
  options: ClassificationPipelineOptions,
): Promise<{
  annotations: ClassificationAnnotation[];
  changes: AnnotationBatchChange[];
}> {
  const changes = await mapWithConcurrency(
    options.inputPaths,
    ANNOTATION_GENERATE_CONCURRENCY,
    async (input) => {
      if (options.isCancelled?.()) return undefined;
      options.onProgress?.(`正在为 ${input.relativePath} 分类…`);
      const startedAt = Date.now();

      // 路径优先：后端同机读盘并压缩；仅缺路径时回退前端整图 base64
      let imageBase64 = '';
      if (!input.absolutePath) {
        try {
          imageBase64 = await readImageBase64(input.absolutePath);
        } catch {
          return undefined;
        }
        if (!imageBase64) return undefined;
      }

      const result = await callLlmApi({
        providerId: options.providerId,
        apiKey: options.providerApiKey,
        baseUrl: options.providerBaseUrl,
        model: options.providerModel,
        systemPrompt: buildSystemPrompt(options.project),
        userPrompt: options.userRequest || '请为这张图片选择最合适的分类标签。',
        imageAbsolutePath: input.absolutePath,
        imageBase64,
        imageMimeType: 'image/jpeg',
        temperature: 0.2,
      });

      if (!result.ok) return undefined;

      const parsed = parseClassificationJson(result.content, options.project);
      if (!parsed) return undefined;
      options.onProgress?.(
        `已为 ${input.relativePath} 完成分类（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
      );

      const now = new Date().toISOString();
      const annotation: ClassificationAnnotation = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'classification',
        labelId: parsed.labelId,
        createdAt: now,
        updatedAt: now,
      };

      return {
        relativePath: input.relativePath,
        absolutePath: input.absolutePath,
        operation: 'append' as const,
        annotations: [annotation],
      };
    },
    options.isCancelled,
  );

  const annotations = changes.flatMap(
    (c) => (c.annotations as ClassificationAnnotation[]) ?? [],
  );
  return { annotations, changes };
}

function parseClassificationJson(
  content: string,
  project: AnnotationProjectSnapshot,
): { labelId: string } | null {
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    const labelId = parsed.labelId || parsed.label_id;
    const labelName = parsed.labelName || parsed.label_name;

    // Try to match by id first, then by name
    if (typeof labelId === 'string' && labelId.trim()) {
      const found = project.labels.find((l) => l.id === labelId.trim());
      if (found) return { labelId: labelId.trim() };
    }

    if (typeof labelName === 'string' && labelName.trim()) {
      const found = project.labels.find(
        (l) => l.name.toLowerCase() === labelName.trim().toLowerCase(),
      );
      if (found) return { labelId: found.id };
    }

    // Fallback to first matching label by fuzzy match
    if (typeof labelName === 'string' && labelName.trim()) {
      const name = labelName.trim().toLowerCase();
      const found = project.labels.find(
        (l) =>
          l.name.toLowerCase().includes(name) ||
          name.includes(l.name.toLowerCase()),
      );
      if (found) return { labelId: found.id };
    }
  } catch {
    // ignore
  }
  return null;
}
