/** Instruction data generation pipeline. */

import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../../../shared/annotationAgentTypes';
import { ANNOTATION_GENERATE_CONCURRENCY } from '../../../../shared/annotationAgentTypes';
import type { InstructionAnnotation } from '../../../types/annotationDocument';
import { callLlmApi } from './llmUtil';
import { readSourceTextForProject } from './sourceTextUtil';
import { mapWithConcurrency } from '../runWithConcurrency';

const SYSTEM_PROMPT = `你是一个高质量的指令数据生成专家。根据用户需求，生成结构化的指令-输出对。

请严格按照以下 JSON 格式输出（不要输出其他内容）：
{
  "instruction": "任务指令或问题",
  "input": "可选的输入上下文",
  "output": "期望的回答或输出"
}

注意：
- "instruction" 必须填写，描述清楚任务或问题
- "input" 为可选项，如果任务需要额外的上下文则填写，否则可留空字符串
- "output" 必须填写，给出高质量的答案`;

export interface InstructionPipelineOptions {
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

export async function runInstructionPipeline(
  options: InstructionPipelineOptions,
): Promise<{
  annotations: InstructionAnnotation[];
  changes: AnnotationBatchChange[];
}> {
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
          ? `正在为 ${source.relativePath} 生成指令数据…`
          : '正在生成指令数据…',
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
        ? `基于以下文本内容，生成一个高质量的指令-输出对：\n\n---\n${sourceText.slice(0, 8000)}\n---\n\n用户需求：${options.userRequest || '生成有代表性的指令数据'}`
        : options.userRequest ||
          '请随机生成一个高质量的指令-输出对，覆盖常见的问答场景。';

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

      const parsed = parseInstructionJson(result.content);
      if (!parsed) return undefined;

      const now = new Date().toISOString();
      const annotation: InstructionAnnotation = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'instruction',
        labelId: null,
        instruction: parsed.instruction,
        input: parsed.input || undefined,
        output: parsed.output,
        createdAt: now,
        updatedAt: now,
      };

      return {
        relativePath:
          source.relativePath !== '_synthetic_'
            ? source.relativePath
            : `_synthetic_/${Date.now()}.json`,
        absolutePath: source.absolutePath || `_synthetic_/${Date.now()}.json`,
        operation: 'append' as const,
        annotations: [annotation],
      };
    },
    options.isCancelled,
  );

  const annotations = changes.flatMap(
    (c) => (c.annotations as InstructionAnnotation[]) ?? [],
  );
  return { annotations, changes };
}

function parseInstructionJson(
  content: string,
): { instruction: string; input: string; output: string } | null {
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (
      typeof parsed.instruction === 'string' &&
      parsed.instruction.trim() &&
      typeof parsed.output === 'string' &&
      parsed.output.trim()
    ) {
      return {
        instruction: parsed.instruction.trim(),
        input: typeof parsed.input === 'string' ? parsed.input.trim() : '',
        output: parsed.output.trim(),
      };
    }
  } catch {
    // ignore
  }
  return null;
}
