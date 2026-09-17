/** Multi-turn conversation generation pipeline. */

import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../../../shared/annotationAgentTypes';
import type { ConversationAnnotation } from '../../../types/annotationDocument';
import { callLlmApi } from './llmUtil';
import { readSourceTextForProject } from './sourceTextUtil';

const SYSTEM_PROMPT = `你是一个高质量的多轮对话数据生成专家。根据用户需求，生成自然的多轮对话数据。

请严格按照以下 JSON 格式输出（不要输出其他内容）：
{
  "turns": [
    { "role": "user", "content": "用户的第一句话" },
    { "role": "assistant", "content": "助手的回复" },
    { "role": "user", "content": "用户的第二句话" },
    { "role": "assistant", "content": "助手的回复" }
  ]
}

注意：
- turns 交替使用 "user" 和 "assistant" 角色
- 至少包含 2 轮对话（即 4 条消息）
- 对话内容应自然流畅，有明确的话题脉络
- assistant 的回复应有帮助性、准确`;

export interface ConversationPipelineOptions {
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

export async function runConversationPipeline(
  options: ConversationPipelineOptions,
): Promise<{
  annotations: ConversationAnnotation[];
  changes: AnnotationBatchChange[];
}> {
  const changes: AnnotationBatchChange[] = [];
  const inputPaths = options.inputPaths ?? [];

  if (inputPaths.length > 0) {
    for (const source of inputPaths) {
      if (options.isCancelled?.()) break;
      options.onProgress?.(`正在为 ${source.relativePath} 生成多轮对话…`);

      const sourceText = await readSourceTextForProject(
        options.project.directoryPath,
        source.relativePath,
      );
      if (!sourceText.trim()) continue;

      const userPrompt = `基于以下文本内容，生成一段相关的多轮对话：\n\n---\n${sourceText.slice(0, 8000)}\n---\n\n用户需求：${options.userRequest || '生成自然流畅的多轮对话'}`;

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

      const parsed = parseConversationJson(result.content);
      if (!parsed) continue;

      const now = new Date().toISOString();
      const annotation: ConversationAnnotation = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'conversation',
        labelId: null,
        turns: parsed.turns,
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
      options.onProgress?.(`正在生成多轮对话数据（${i + 1}/${count}）…`);

      const userPrompt =
        options.userRequest ||
        `请生成一段自然的多轮对话（第 ${i + 1} 条），话题尽量多样化。`;

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

      const parsed = parseConversationJson(result.content);
      if (!parsed) continue;

      const now = new Date().toISOString();
      const annotation: ConversationAnnotation = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'conversation',
        labelId: null,
        turns: parsed.turns,
        createdAt: now,
        updatedAt: now,
      };

      changes.push({
        relativePath: `_synthetic_/${Date.now()}_${i}_conv.json`,
        absolutePath: `_synthetic_/${Date.now()}_${i}_conv.json`,
        operation: 'append',
        annotations: [annotation],
      });
    }
  }

  const annotations = changes.flatMap(
    (c) => (c.annotations as ConversationAnnotation[]) ?? [],
  );
  return { annotations, changes };
}

interface ConversationOutput {
  turns: { role: 'user' | 'assistant'; content: string }[];
}

function parseConversationJson(content: string): ConversationOutput | null {
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed.turns) && parsed.turns.length >= 2) {
      const turns = parsed.turns
        .filter(
          (t: unknown) =>
            ((t as Record<string, unknown>).role === 'user' ||
              (t as Record<string, unknown>).role === 'assistant') &&
            typeof (t as Record<string, unknown>).content === 'string',
        )
        .map((t: Record<string, unknown>) => ({
          role: t.role as 'user' | 'assistant',
          content: String(t.content).trim(),
        }));
      if (turns.length >= 2) {
        return { turns };
      }
    }
  } catch {
    // ignore
  }
  return null;
}
