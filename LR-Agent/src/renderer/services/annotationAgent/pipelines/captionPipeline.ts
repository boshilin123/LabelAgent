/** Image caption generation pipeline. */

import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../../../shared/annotationAgentTypes';
import { ANNOTATION_GENERATE_CONCURRENCY } from '../../../../shared/annotationAgentTypes';
import type { CaptionAnnotation } from '../../../types/annotationDocument';
import { callLlmApi } from './llmUtil';
import { readImageBase64 } from '../fusionSubImageTools';
import { mapWithConcurrency } from '../runWithConcurrency';

const SYSTEM_PROMPT = `你是一个图片内容描述专家。根据用户提供的图片和需求，生成自然语言描述。

请严格按照以下 JSON 格式输出（不要输出其他内容）：
{
  "text": "图片的自然语言描述",
  "granularity": "brief",
  "language": "zh"
}

granularity 可选值：
- "brief": 简短描述（1-2句话概括）
- "detailed": 详细描述（段落级别，描述主要元素和场景）
- "dense": 密集描述（详尽描述所有可见元素、位置关系、颜色、动作等）
language: 语言代码，如 "zh"（中文）、"en"（英文），默认 "zh"。`;

export interface CaptionPipelineOptions {
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

export async function runCaptionPipeline(
  options: CaptionPipelineOptions,
): Promise<{
  annotations: CaptionAnnotation[];
  changes: AnnotationBatchChange[];
}> {
  const changes = await mapWithConcurrency(
    options.inputPaths,
    ANNOTATION_GENERATE_CONCURRENCY,
    async (input) => {
      if (options.isCancelled?.()) return undefined;
      options.onProgress?.(`正在为 ${input.relativePath} 生成描述…`);
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
        systemPrompt: SYSTEM_PROMPT,
        userPrompt:
          options.userRequest || '请为这张图片生成详细的自然语言描述。',
        imageAbsolutePath: input.absolutePath,
        imageBase64,
        imageMimeType: 'image/jpeg',
        temperature: 0.5,
      });

      if (!result.ok) return undefined;

      const parsed = parseCaptionJson(result.content);
      if (!parsed) return undefined;
      options.onProgress?.(
        `已为 ${input.relativePath} 生成描述（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
      );

      const now = new Date().toISOString();
      const annotation: CaptionAnnotation = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'caption',
        labelId: null,
        text: parsed.text,
        granularity: parsed.granularity,
        language: parsed.language || 'zh',
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
    (c) => (c.annotations as CaptionAnnotation[]) ?? [],
  );
  return { annotations, changes };
}

interface CaptionOutput {
  text: string;
  granularity: 'brief' | 'detailed' | 'dense';
  language?: string;
}

function parseCaptionJson(content: string): CaptionOutput | null {
  try {
    const json = extractJsonFromContent(content);
    const parsed = JSON.parse(json);
    if (typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
      const granularity = validateGranularity(parsed.granularity);
      return {
        text: parsed.text.trim(),
        granularity,
        language: typeof parsed.language === 'string' ? parsed.language : 'zh',
      };
    }
  } catch {
    // fallback: treat whole content as text
    const clean = content.trim().replace(/^```json\s*|\s*```$/g, '');
    if (clean.length > 0) {
      return { text: clean, granularity: 'brief', language: 'zh' };
    }
  }
  return null;
}

function validateGranularity(value: unknown): 'brief' | 'detailed' | 'dense' {
  if (value === 'detailed' || value === 'dense') return value;
  return 'brief';
}

function extractJsonFromContent(content: string): string {
  const match = content.match(/\{[\s\S]*\}/);
  return match ? match[0] : content;
}
