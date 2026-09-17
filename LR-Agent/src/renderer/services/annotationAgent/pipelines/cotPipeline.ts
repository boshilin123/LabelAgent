/** COT (Chain of Thought) generation pipeline. */

import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../../../shared/annotationAgentTypes';
import { ANNOTATION_GENERATE_CONCURRENCY } from '../../../../shared/annotationAgentTypes';
import type { CotAnnotation } from '../../../types/annotationDocument';
import { callLlmApi } from './llmUtil';
import { readSourceTextForProject } from './sourceTextUtil';
import { mapWithConcurrency } from '../runWithConcurrency';

const SYSTEM_PROMPT = `你是一个高质量的思维链（Chain of Thought）数据生成专家。根据用户需求，生成包含逐步推理过程和最终答案的结构化数据。

请严格按照以下 JSON 格式输出（不要输出其他内容）：
{
  "instruction": "问题或任务指令（可选）",
  "input": "输入上下文（可选）",
  "steps": [
    { "description": "第一步的推理描述", "conclusion": "第一步的结论" },
    { "description": "第二步的推理描述", "conclusion": "第二步的结论" }
  ],
  "answer": "最终答案"
}

注意：
- "steps" 至少包含 2 个推理步骤
- 每个步骤需要 "description"（推理过程描述）和 "conclusion"（该步骤的结论）
- "answer" 是最终的完整答案或结论`;

export interface CotPipelineOptions {
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

export async function runCotPipeline(
  options: CotPipelineOptions,
): Promise<{ annotations: CotAnnotation[]; changes: AnnotationBatchChange[] }> {
  const sources =
    options.inputPaths.length > 0
      ? options.inputPaths
      : [{ relativePath: '_synthetic_', absolutePath: '' }];

  const changes = await mapWithConcurrency(
    sources,
    ANNOTATION_GENERATE_CONCURRENCY,
    async (source) => {
      if (options.isCancelled?.()) return undefined;
      options.onProgress?.(
        source.relativePath !== '_synthetic_'
          ? `正在为 ${source.relativePath} 生成思维链…`
          : '正在生成思维链数据…',
      );

      let sourceText = '';
      if (source.relativePath !== '_synthetic_') {
        sourceText = await readSourceTextForProject(
          options.project.directoryPath,
          source.relativePath,
        );
        if (!sourceText.trim()) return undefined;
      }

      const userPrompt = sourceText
        ? `基于以下文本内容，生成一个包含逐步推理过程的思维链问答：\n\n---\n${sourceText.slice(0, 8000)}\n---\n\n用户需求：${options.userRequest || '生成具有推理深度的思维链数据'}`
        : options.userRequest ||
          '请随机生成一个需要多步推理的问题及其思维链解答。';

      const result = await callLlmApi({
        providerId: options.providerId,
        apiKey: options.providerApiKey,
        baseUrl: options.providerBaseUrl,
        model: options.providerModel,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        temperature: 0.7,
      });

      if (!result.ok) return undefined;

      const parsed = parseCotJson(result.content);
      if (!parsed) return undefined;

      const now = new Date().toISOString();
      const annotation: CotAnnotation = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'cot',
        labelId: null,
        instruction: parsed.instruction || undefined,
        input: parsed.input || undefined,
        steps: parsed.steps,
        answer: parsed.answer,
        createdAt: now,
        updatedAt: now,
      };

      return {
        relativePath:
          source.relativePath !== '_synthetic_'
            ? source.relativePath
            : `_synthetic_/${Date.now()}_cot.json`,
        absolutePath:
          source.absolutePath || `_synthetic_/${Date.now()}_cot.json`,
        operation: 'append' as const,
        annotations: [annotation],
      };
    },
    options.isCancelled,
  );

  const annotations = changes.flatMap(
    (c) => (c.annotations as CotAnnotation[]) ?? [],
  );
  return { annotations, changes };
}

interface CotOutput {
  instruction?: string;
  input?: string;
  steps: { description: string; conclusion: string }[];
  answer: string;
}

function parseCotJson(content: string): CotOutput | null {
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (
      Array.isArray(parsed.steps) &&
      parsed.steps.length >= 2 &&
      typeof parsed.answer === 'string' &&
      parsed.answer.trim()
    ) {
      const steps = parsed.steps
        .filter(
          (s: unknown) =>
            typeof (s as Record<string, unknown>)?.description === 'string' &&
            typeof (s as Record<string, unknown>)?.conclusion === 'string',
        )
        .map((s: Record<string, unknown>) => ({
          description: String(s.description).trim(),
          conclusion: String(s.conclusion).trim(),
        }));
      if (steps.length >= 2) {
        return {
          instruction:
            typeof parsed.instruction === 'string'
              ? parsed.instruction.trim()
              : undefined,
          input:
            typeof parsed.input === 'string' ? parsed.input.trim() : undefined,
          steps,
          answer: parsed.answer.trim(),
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}
