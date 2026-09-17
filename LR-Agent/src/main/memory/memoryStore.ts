/**
 * 工作区记忆存储（标注任务级，多 Markdown topic）。
 *
 * 目录结构（Electron userData 下，机器本地）：
 *   {userData}/agent-memory/
 *   └── projects/{annotationProjectId}/
 *       ├── MEMORY.md                        # 索引，注入前 200 行 / 25KB
 *       └── topics/*.md                      # 细节文件，按需读取
 *
 * 仅当 workspaceMemoryActive 为真时 MCP 工具可用。
 * 磁盘上旧的 user/、ws-* 目录不迁不删，Agent 不再读写。
 */

import { app } from 'electron';
import fs from 'fs-extra';
import path from 'path';
import { readAnnotationIndex } from '../annotation/annotationDataStore';

/** 索引注入上限：前 200 行 / 25KB */
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25 * 1024;
/** 单个 topic 文件读取上限（约 64KB 字符） */
const TOPIC_MAX_CHARS = 64_000;

const SCOPE_KEY_PATTERN = /^projects\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOPIC_FILE_PATTERN =
  /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5._-]*\.md$/;

export const SYSTEM_FACT_TOPIC_FILES = [
  'progress.md',
  'annotated-files.md',
] as const;

export const SYSTEM_FACT_TOPIC_READONLY = 'system_fact_topic_readonly';

export function isSystemFactTopic(topicFile: string): boolean {
  return (SYSTEM_FACT_TOPIC_FILES as readonly string[]).includes(topicFile);
}

export function assertAgentWritableTopic(topicFile: string): void {
  if (isSystemFactTopic(topicFile)) {
    throw new Error(SYSTEM_FACT_TOPIC_READONLY);
  }
}

/** 当前活动记忆作用域（renderer 发消息时设置，MCP 工具使用） */
let activeScopeKey = '';
/** 当前会话是否允许 Agent 调用 memory_* */
let workspaceMemoryActive = false;

export function getActiveMemoryScope(): string {
  return activeScopeKey;
}

export function setWorkspaceMemoryActive(
  enabled: boolean,
  scopeKey?: string,
): void {
  if (enabled) {
    if (!scopeKey || !SCOPE_KEY_PATTERN.test(scopeKey)) {
      workspaceMemoryActive = false;
      activeScopeKey = '';
      return;
    }
    activeScopeKey = scopeKey;
    workspaceMemoryActive = true;
    return;
  }
  workspaceMemoryActive = false;
  activeScopeKey = '';
}

export function isWorkspaceMemoryActive(): boolean {
  return workspaceMemoryActive && Boolean(activeScopeKey);
}

export function getMemoryRootDir(): string {
  return path.join(app.getPath('userData'), 'agent-memory');
}

function resolveScopeDir(scopeKey: string): string {
  if (!SCOPE_KEY_PATTERN.test(scopeKey)) {
    throw new Error(`invalid_memory_scope: ${scopeKey}`);
  }
  return path.join(getMemoryRootDir(), ...scopeKey.split('/'));
}

function resolveTopicPath(scopeKey: string, topicFile: string): string {
  if (!TOPIC_FILE_PATTERN.test(topicFile)) {
    throw new Error(`invalid_topic_file: ${topicFile}`);
  }
  return path.join(resolveScopeDir(scopeKey), 'topics', topicFile);
}

async function topicExists(topicPath: string): Promise<boolean> {
  try {
    await fs.access(topicPath);
    return true;
  } catch {
    return false;
  }
}

/** 读取 MEMORY.md 索引，按 200 行 / 25KB 截断；不存在或为空时返回 null */
export async function readMemoryIndex(
  scopeKey: string,
): Promise<string | null> {
  const indexPath = path.join(resolveScopeDir(scopeKey), 'MEMORY.md');
  let content: string;
  try {
    content = await fs.readFile(indexPath, 'utf-8');
  } catch {
    return null;
  }
  const trimmed = content.trim();
  if (!trimmed) return null;

  let lines = trimmed.split('\n');
  let truncated = false;
  if (lines.length > INDEX_MAX_LINES) {
    lines = lines.slice(0, INDEX_MAX_LINES);
    truncated = true;
  }
  let result = lines.join('\n');
  while (Buffer.byteLength(result, 'utf-8') > INDEX_MAX_BYTES) {
    lines.pop();
    result = lines.join('\n');
    truncated = true;
  }
  return truncated ? `${result}\n…（索引过长已截断）` : result;
}

/** 读取某 topic 文件全文；不存在时返回 null */
export async function readMemoryTopic(
  scopeKey: string,
  topicFile: string,
): Promise<string | null> {
  const topicPath = resolveTopicPath(scopeKey, topicFile);
  try {
    const content = await fs.readFile(topicPath, 'utf-8');
    return content.length > TOPIC_MAX_CHARS
      ? `${content.slice(0, TOPIC_MAX_CHARS)}\n…（内容过长已截断）`
      : content;
  } catch {
    return null;
  }
}

/** 列出 scope 下的 topic 文件名 */
export async function listMemoryTopics(scopeKey: string): Promise<string[]> {
  const topicsDir = path.join(resolveScopeDir(scopeKey), 'topics');
  try {
    const entries = await fs.readdir(topicsDir);
    return entries.filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

export type MemoryEntry = {
  id: string;
  title: string;
  topicFile: string | null;
  relativePath: string;
  absolutePath: string;
  excerpt: string;
};

function firstMeaningfulLine(content: string): string {
  for (const raw of content.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line.slice(0, 160);
  }
  return '';
}

function excerptFromIndex(indexContent: string, topicFile: string): string {
  const marker = `topics/${topicFile}`;
  const line = indexContent.split('\n').find((item) => item.includes(marker));
  if (!line) return '';
  return line
    .replace(/^[-*]\s+/, '')
    .trim()
    .slice(0, 160);
}

/** 列出索引与 topic，供工作区记忆面板展示 */
export async function listMemoryEntries(
  scopeKey: string,
): Promise<MemoryEntry[]> {
  const scopeDir = resolveScopeDir(scopeKey);
  const indexPath = path.join(scopeDir, 'MEMORY.md');
  let indexContent = '';
  try {
    indexContent = await fs.readFile(indexPath, 'utf-8');
  } catch {
    indexContent = '';
  }

  const entries: MemoryEntry[] = [];
  if (indexContent.trim()) {
    entries.push({
      id: 'index',
      title: 'MEMORY.md',
      topicFile: null,
      relativePath: 'MEMORY.md',
      absolutePath: indexPath,
      excerpt: firstMeaningfulLine(indexContent) || '工作区记忆索引',
    });
  }

  const topics = await listMemoryTopics(scopeKey);
  for (const topicFile of topics) {
    entries.push({
      id: topicFile,
      title: topicFile,
      topicFile,
      relativePath: `topics/${topicFile}`,
      absolutePath: resolveTopicPath(scopeKey, topicFile),
      excerpt: excerptFromIndex(indexContent, topicFile),
    });
  }
  return entries;
}

function isInsideDir(dir: string, filePath: string): boolean {
  const root = path.resolve(dir);
  const resolved = path.resolve(filePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return resolved === root || resolved.startsWith(prefix);
}

/** 仅允许打开当前任务 scope 下的 MEMORY.md / topics/*.md */
export async function resolveOpenableMemoryFile(
  scopeKey: string,
  relativePath: string,
): Promise<string> {
  if (typeof relativePath !== 'string') {
    throw new Error('invalid_memory_path');
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const scopeDir = resolveScopeDir(scopeKey);
  let filePath: string;
  if (normalized === 'MEMORY.md') {
    filePath = path.join(scopeDir, 'MEMORY.md');
  } else {
    const match = /^topics\/(.+)$/.exec(normalized);
    if (!match || !TOPIC_FILE_PATTERN.test(match[1])) {
      throw new Error('invalid_memory_path');
    }
    filePath = resolveTopicPath(scopeKey, match[1]);
  }
  if (!isInsideDir(scopeDir, filePath)) {
    throw new Error('invalid_memory_path');
  }

  let realFile: string;
  let realScope: string;
  try {
    realFile = await fs.realpath(filePath);
    realScope = await fs.realpath(scopeDir);
  } catch {
    throw new Error('memory_file_not_found');
  }
  if (!isInsideDir(realScope, realFile)) {
    throw new Error('invalid_memory_path');
  }
  const stat = await fs.stat(realFile);
  if (!stat.isFile() || path.extname(realFile).toLowerCase() !== '.md') {
    throw new Error('invalid_memory_path');
  }
  return realFile;
}

async function updateMemoryIndex(
  scopeKey: string,
  topicFile: string,
  indexLine?: string,
): Promise<void> {
  const trimmed = indexLine?.trim();
  if (!trimmed) return;

  const scopeDir = resolveScopeDir(scopeKey);
  const indexPath = path.join(scopeDir, 'MEMORY.md');
  let existing = '';
  try {
    existing = await fs.readFile(indexPath, 'utf-8');
  } catch {
    existing = '# 工作区记忆索引\n';
  }
  const marker = `topics/${topicFile}`;
  const lines = existing.split('\n');
  const lineIndex = lines.findIndex((line) => line.includes(marker));
  if (lineIndex >= 0) {
    lines[lineIndex] = trimmed;
  } else {
    if (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
    lines.push(trimmed);
  }
  await fs.ensureDir(scopeDir);
  await fs.writeFile(indexPath, `${lines.join('\n')}\n`, 'utf-8');
}

/**
 * 覆盖已有 topic。文件不存在则失败，请用 createMemoryTopic。
 */
export async function writeMemoryTopic(options: {
  scopeKey: string;
  topicFile: string;
  content: string;
  indexLine?: string;
}): Promise<{ topicPath: string }> {
  const topicPath = resolveTopicPath(options.scopeKey, options.topicFile);
  if (!(await topicExists(topicPath))) {
    throw new Error(`topic_not_found: ${options.topicFile}; use memory_create`);
  }
  await fs.writeFile(topicPath, options.content, 'utf-8');
  await updateMemoryIndex(
    options.scopeKey,
    options.topicFile,
    options.indexLine,
  );
  return { topicPath };
}

/**
 * 新建 topic。文件已存在则失败，请用 writeMemoryTopic。
 */
export async function createMemoryTopic(options: {
  scopeKey: string;
  topicFile: string;
  content: string;
  indexLine?: string;
}): Promise<{ topicPath: string }> {
  const topicPath = resolveTopicPath(options.scopeKey, options.topicFile);
  if (await topicExists(topicPath)) {
    throw new Error(`topic_already_exists: ${options.topicFile}`);
  }
  await fs.ensureDir(path.dirname(topicPath));
  await fs.writeFile(topicPath, options.content, 'utf-8');
  await updateMemoryIndex(
    options.scopeKey,
    options.topicFile,
    options.indexLine,
  );
  return { topicPath };
}

/** 覆盖或新建 topic（系统事实同步使用）。 */
export async function upsertMemoryTopic(options: {
  scopeKey: string;
  topicFile: string;
  content: string;
  indexLine?: string;
}): Promise<{ topicPath: string }> {
  const topicPath = resolveTopicPath(options.scopeKey, options.topicFile);
  await fs.ensureDir(path.dirname(topicPath));
  await fs.writeFile(topicPath, options.content, 'utf-8');
  await updateMemoryIndex(
    options.scopeKey,
    options.topicFile,
    options.indexLine,
  );
  return { topicPath };
}

function formatFactSyncTime(now: Date): string {
  return now.toISOString();
}

export function buildWorkspaceFactMarkdown(options: {
  annotated: Array<{ relativePath: string; annotationCount: number }>;
  emptied: Array<{ relativePath: string; annotationCount: number }>;
  syncedAt: Date;
}): {
  progressContent: string;
  progressIndexLine: string;
  filesContent: string;
  filesIndexLine: string;
} {
  const annotatedCount = options.annotated.length;
  const annotationTotal =
    options.annotated.reduce((sum, item) => sum + item.annotationCount, 0) +
    options.emptied.reduce((sum, item) => sum + item.annotationCount, 0);
  const synced = formatFactSyncTime(options.syncedAt);
  const banner = `> 由系统根据标注索引生成，请勿手改计数。上次同步：${synced}`;

  const hasAny = annotatedCount > 0 || options.emptied.length > 0;
  const progressBody = hasAny
    ? `- 已标文件：${annotatedCount}\n- 标注条数：${annotationTotal}`
    : '尚无已落盘标注。';
  const progressContent = `# 进度\n${banner}\n\n${progressBody}\n`;
  const progressIndexLine = hasAny
    ? `- [进度](topics/progress.md)：已标 ${annotatedCount} 个文件，共 ${annotationTotal} 条`
    : '- [进度](topics/progress.md)：尚无已落盘标注';

  const annotatedLines =
    options.annotated.length > 0
      ? options.annotated
          .map((item) => `- ${item.relativePath} (${item.annotationCount})`)
          .join('\n')
      : '- （无）';
  const emptiedSection =
    options.emptied.length > 0
      ? `\n## 已清空\n${options.emptied
          .map((item) => `- ${item.relativePath} (${item.annotationCount})`)
          .join('\n')}\n`
      : '';
  const filesContent = `# 已标文件\n${banner}\n\n## 已标\n${annotatedLines}\n${emptiedSection}`;
  const filesIndexLine = hasAny
    ? `- [已标文件](topics/annotated-files.md)：${annotatedCount} 个文件`
    : '- [已标文件](topics/annotated-files.md)：尚无已落盘标注';

  return {
    progressContent,
    progressIndexLine,
    filesContent,
    filesIndexLine,
  };
}

/**
 * 根据项目 annotations/index.json 重写系统事实 topic。
 * 不要求 MCP 记忆已激活。
 */
export async function syncWorkspaceFactTopics(options: {
  scopeKey: string;
  projectDir: string;
}): Promise<{ annotatedFiles: number; annotationCount: number }> {
  if (!SCOPE_KEY_PATTERN.test(options.scopeKey)) {
    throw new Error(`invalid_memory_scope: ${options.scopeKey}`);
  }

  const index = await readAnnotationIndex(options.projectDir);
  const annotated: Array<{ relativePath: string; annotationCount: number }> =
    [];
  const emptied: Array<{ relativePath: string; annotationCount: number }> = [];
  if (index) {
    const entries = Object.values(index.files).sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );
    for (const entry of entries) {
      const item = {
        relativePath: entry.relativePath,
        annotationCount: entry.annotationCount,
      };
      if (entry.annotationCount > 0) annotated.push(item);
      else emptied.push(item);
    }
  }

  const markdown = buildWorkspaceFactMarkdown({
    annotated,
    emptied,
    syncedAt: new Date(),
  });
  await upsertMemoryTopic({
    scopeKey: options.scopeKey,
    topicFile: 'progress.md',
    content: markdown.progressContent,
    indexLine: markdown.progressIndexLine,
  });
  await upsertMemoryTopic({
    scopeKey: options.scopeKey,
    topicFile: 'annotated-files.md',
    content: markdown.filesContent,
    indexLine: markdown.filesIndexLine,
  });
  return {
    annotatedFiles: annotated.length,
    annotationCount:
      annotated.reduce((sum, item) => sum + item.annotationCount, 0) +
      emptied.reduce((sum, item) => sum + item.annotationCount, 0),
  };
}

/** 确保 scope 目录存在并返回绝对路径（供 UI 打开目录） */
export async function ensureMemoryDir(scopeKey: string): Promise<string> {
  const dir = resolveScopeDir(scopeKey);
  await fs.ensureDir(path.join(dir, 'topics'));
  return dir;
}
