/** Preference data generation pipeline. */

import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../../../shared/annotationAgentTypes';
import type { PreferenceAnnotation } from '../../../types/annotationDocument';
import { callLlmApi } from './llmUtil';
import { readSourceTextForProject } from './sourceTextUtil';

const SYSTEM_PROMPT = `你是一个高质量的偏好数据生成专家。根据用户需求，生成包含 prompt、优选回复（chosen）和劣选回复（rejected）的偏好对比数据。

请严格按照以下 JSON 格式输出（不要输出其他内容）：
{
  "prompt": "给定的问题或指令",
  "chosen": "高质量的优选回复",
  "rejected": "存在问题的劣选回复"
}

注意：
- "prompt" 是一个合理的问题或指令
- "chosen" 是高质量的回答（准确、有帮助、安全）
- "rejected" 是存在明显问题的回答（如事实错误、不完整、有有害内容、过于简短等）
- chosen 和 rejected 应该有明显的质量差距`;

export interface PreferencePipelineOptions {
  inputPaths?: { relativePath: string; absolutePath: string }[];
  userRequest: string;
  count?: number;
  providerId: string;
  providerApiKey: string;
  providerBaseUrl: string;
  providerModel: string;
  project: AnnotationProjectSnapshot;
  isCancelled?: () => boolean;
  onProgress?: (message: string) => void;
}

export async function runPreferencePipeline(
  options: PreferencePipelineOptions,
): Promise<{
  annotations: PreferenceAnnotation[];
  changes: AnnotationBatchChange[];
}> {
  const changes: AnnotationBatchChange[] = [];
  const inputPaths = options.inputPaths ?? [];

  if (inputPaths.length > 0) {
    for (const source of inputPaths) {
      if (options.isCancelled?.()) break;
      options.onProgress?.(`正在为 ${source.relativePath} 生成偏好数据…`);

      const sourceText = await readSourceTextForProject(
        options.project.directoryPath,
        source.relativePath,
      );
      if (!sourceText.trim()) continue;

      const userPrompt = `基于以下文本内容，生成一组偏好对比数据：\n\n---\n${sourceText.slice(0, 8000)}\n---\n\n用户需求：${options.userRequest || '生成有质量差距的偏好对比数据'}`;

      const result = await callLlmApi({
        providerId: options.providerId,
        apiKey: options.providerApiKey,
        baseUrl: options.providerBaseUrl,
        model: options.providerModel,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        temperature: 0.8,
      });

      if (!result.ok) continue;

      const parsed = parsePreferenceJson(result.content);
      if (!parsed) continue;

      const now = new Date().toISOString();
      const annotation: PreferenceAnnotation = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'preference',
        labelId: null,
        prompt: parsed.prompt,
        chosen: parsed.chosen,
        rejected: parsed.rejected,
        createdAt: now,
        updatedAt: now,
      };

      changes.push({
        relativePath: source.relativePath,
        absolutePath: source.absolutePath,
        operation: 'append',
        annotations: [annotation],
      });
    }
  } else {
    const count = Math.min(options.count ?? 1, 50);
    for (let i = 0; i < count; i++) {
      if (options.isCancelled?.()) break;
      options.onProgress?.(`正在生成偏好数据（${i + 1}/${count}）…`);

      const userPrompt =
        options.userRequest || `请生成一组偏好对比数据（第 ${i + 1} 条）。`;

      const result = await callLlmApi({
        providerId: options.providerId,
        apiKey: options.providerApiKey,
        baseUrl: options.providerBaseUrl,
        model: options.providerModel,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        temperature: 0.8,
      });

      if (!result.ok) continue;

      const parsed = parsePreferenceJson(result.content);
      if (!parsed) continue;

      const now = new Date().toISOString();
      const annotation: PreferenceAnnotation = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'preference',
        labelId: null,
        prompt: parsed.prompt,
        chosen: parsed.chosen,
        rejected: parsed.rejected,
        createdAt: now,
        updatedAt: now,
      };

      changes.push({
        relativePath: `_synthetic_/${Date.now()}_${i}_pref.json`,
        absolutePath: `_synthetic_/${Date.now()}_${i}_pref.json`,
        operation: 'append',
        annotations: [annotation],
      });
    }
  }

  const annotations = changes.flatMap(
    (c) => (c.annotations as PreferenceAnnotation[]) ?? [],
  );
  return { annotations, changes };
}

interface PreferenceOutput {
  prompt: string;
  chosen: string;
  rejected: string;
}

function parsePreferenceJson(content: string): PreferenceOutput | null {
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (
      typeof parsed.prompt === 'string' &&
      parsed.prompt.trim() &&
      typeof parsed.chosen === 'string' &&
      parsed.chosen.trim() &&
      typeof parsed.rejected === 'string' &&
      parsed.rejected.trim()
    ) {
      return {
        prompt: parsed.prompt.trim(),
        chosen: parsed.chosen.trim(),
        rejected: parsed.rejected.trim(),
      };
    }
  } catch {
    // ignore
  }
  return null;
}
