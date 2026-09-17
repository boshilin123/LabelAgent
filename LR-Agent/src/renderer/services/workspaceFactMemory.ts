import type { AnnotationProject } from '../types/annotation';
import { computeMemoryScopeKey } from './agentMemory';

type MemorySyncBridge = {
  electron?: {
    memory?: {
      syncFacts?: (options: {
        scopeKey: string;
        projectDir: string;
      }) => Promise<{ annotatedFiles: number; annotationCount: number }>;
    };
  };
};

/**
 * 按标注索引重写进度 / 已标文件。开关关闭时 no-op。
 * 失败只打日志，不抛给调用方。
 */
export async function syncWorkspaceFactMemory(
  project: AnnotationProject | null | undefined,
): Promise<void> {
  if (!project?.workspaceMemoryEnabled) return;
  const scopeKey = computeMemoryScopeKey(project.id);
  const projectDir = project.directoryPath?.trim();
  if (!scopeKey || !projectDir) return;
  const syncFacts = (window as Window & typeof globalThis & MemorySyncBridge)
    .electron?.memory?.syncFacts;
  if (!syncFacts) return;
  try {
    await syncFacts({ scopeKey, projectDir });
  } catch (err) {
    console.warn('[workspaceFactMemory] sync failed', err);
  }
}
