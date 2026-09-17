/**
 * 全局 Agent Skills 只读扫描（对标 Cursor / Claude Code 的 skills）。
 *
 * 约定位置（用户级）：{home}/.agents/skills/<skill-name>/SKILL.md
 *   - frontmatter 提供 name / description / disable-model-invocation
 *   - catalog（目录名 + description）注入 system prompt
 *   - 正文与附属文件由模型按需经 MCP 工具读取（不执行脚本）
 *
 * 稳定标识是目录名。frontmatter name 仅作展示；读取时若传入 frontmatter 名会反查目录。
 * 安全模型：skillName 必须匹配安全命名（防路径穿越），resolve 后校验仍在根目录内。
 */

import { app } from 'electron';
import fs from 'fs-extra';
import path from 'path';

/** catalog 注入条目数上限 */
export const MAX_CATALOG_ENTRIES = 30;
/** 单条 description 注入长度上限 */
export const MAX_DESCRIPTION_CHARS = 300;
/** 单个 skill 文件正文读取上限 */
export const MAX_SKILL_CHARS = 32_000;
/** 附属文件递归深度（相对 skill 根，SKILL.md 为 1 层） */
export const MAX_SKILL_FILE_DEPTH = 3;
/** 单个 skill 列出的文件数上限 */
export const MAX_SKILL_FILE_LIST = 80;
/** inventory 扫描的目录数上限 */
export const MAX_INVENTORY_ENTRIES = 100;
/** 扫描结果 TTL 缓存 */
const CACHE_TTL_MS = 30_000;

/** skill 目录名 / 读取参数白名单（防路径穿越，同 memory 的 topic 命名） */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELATIVE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface AgentSkillEntry {
  /** 稳定标识 = 目录名，注入 prompt / 工具参数 */
  name: string;
  description: string;
  /** 预留 scope 字段：未来支持项目级 .lragent/skills/ 时区分来源 */
  scope: 'user';
}

export type AgentSkillStatus = 'available' | 'disabled' | 'hidden' | 'invalid';

export interface AgentSkillInventoryItem {
  dirName: string;
  /** 展示名（frontmatter name，缺省回退目录名） */
  name: string;
  description: string;
  scope: 'user';
  status: AgentSkillStatus;
  reason?: string;
  files: string[];
  path: string;
}

export type SkillReadError =
  | 'invalid_name'
  | 'skill_not_found'
  | 'invalid_path'
  | 'file_not_found'
  | 'binary';

export type SkillReadResult =
  | { ok: true; content: string; relativePath: string }
  | { ok: false; error: SkillReadError };

export interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
}

/** 用户级 skills 根目录（~/.agents/skills） */
export function getUserSkillsRoot(): string {
  return path.join(app.getPath('home'), '.agents', 'skills');
}

export async function ensureUserSkillsRoot(): Promise<string> {
  const root = getUserSkillsRoot();
  await fs.ensureDir(root);
  return root;
}

/**
 * 轻量解析 SKILL.md 的 YAML frontmatter，不引入 js-yaml。
 * 仅提取 name（单行标量）、description（单行 / `>` 折叠 / `|` 字面量）、
 * disable-model-invocation（布尔）。frontmatter 缺失或结构非法时返回 null。
 */
export function parseSkillFrontmatter(
  content: string,
): ParsedSkillFrontmatter | null {
  const trimmed = content.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) return null;
  const endMarker = trimmed.indexOf('\n---', 3);
  if (endMarker < 0) return null;

  const body = trimmed.slice(3, endMarker);
  const result: ParsedSkillFrontmatter = {};
  let currentKey: string | null = null;
  let currentBlock: string[] | null = null;
  let blockStyle: 'folded' | 'literal' | null = null;

  const lines = body.split('\n');
  for (const line of lines) {
    // 缩进行：块标量（`>` / `|`）的续行
    if (currentKey && currentBlock && /^\s+\S/.test(line)) {
      const indent = line.match(/^\s*/)![0];
      const raw = line.slice(indent.length);
      if (blockStyle === 'literal') {
        currentBlock.push(raw);
      } else {
        currentBlock.push(raw.trim());
      }
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const flush = () => {
      if (currentKey === 'description' && currentBlock) {
        result.description =
          blockStyle === 'literal'
            ? currentBlock.join('\n')
            : currentBlock.join(' ');
      }
      currentKey = null;
      currentBlock = null;
      blockStyle = null;
    };
    if (!match) {
      flush();
      continue;
    }

    const key = match[1];
    const value = match[2].trim();
    if (key === 'name') {
      flush();
      result.name = value;
    } else if (key === 'description') {
      flush();
      if (value.startsWith('>')) {
        currentKey = key;
        currentBlock = [];
        blockStyle = 'folded';
      } else if (value.startsWith('|')) {
        currentKey = key;
        currentBlock = [];
        blockStyle = 'literal';
      } else {
        result.description = value;
      }
    } else if (key === 'disable-model-invocation') {
      flush();
      result.disableModelInvocation = value === 'true';
    } else {
      flush();
    }
  }
  // 收尾未闭合的 description 块
  if (currentKey === 'description' && currentBlock) {
    result.description =
      blockStyle === 'literal'
        ? currentBlock.join('\n')
        : currentBlock.join(' ');
  }
  return result;
}

function isPathWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

export function normalizeSkillRelativePath(
  raw: string | undefined,
): string | null {
  const trimmed = (raw ?? '').trim().replace(/\\/g, '/');
  if (!trimmed) return 'SKILL.md';
  const parts = trimmed.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.length > MAX_SKILL_FILE_DEPTH) return null;
  if (
    parts.some((part) => part === '..' || !RELATIVE_SEGMENT_PATTERN.test(part))
  ) {
    return null;
  }
  return parts.join('/');
}

function truncateSkillContent(content: string): string {
  return content.length > MAX_SKILL_CHARS
    ? `${content.slice(0, MAX_SKILL_CHARS)}\n…（内容过长已截断）`
    : content;
}

function compactDescription(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

// ── TTL 缓存 ────────────────────────────────────────────────────────────────
interface TimedEntry<T> {
  value: T;
  loadedAt: number;
}

const catalogCache = new Map<string, TimedEntry<AgentSkillEntry[]>>();
const inventoryCache = new Map<string, TimedEntry<AgentSkillInventoryItem[]>>();
const skillContentCache = new Map<string, TimedEntry<SkillReadResult>>();
const skillFilesCache = new Map<string, TimedEntry<string[] | null>>();

function readCache<T>(
  cache: Map<string, TimedEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.loadedAt < CACHE_TTL_MS) {
    return entry.value;
  }
  return undefined;
}

function writeCache<T>(
  cache: Map<string, TimedEntry<T>>,
  key: string,
  value: T,
): void {
  cache.set(key, { value, loadedAt: Date.now() });
}

/** 清空缓存（测试或用户编辑 skill 目录后调用） */
export function clearSkillsCache(): void {
  catalogCache.clear();
  inventoryCache.clear();
  skillContentCache.clear();
  skillFilesCache.clear();
}

async function skillMarkdownExists(skillDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(skillDir, 'SKILL.md'));
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 把工具参数解析成技能目录名：先当目录名，再按 frontmatter name 反查。
 */
export async function resolveSkillDirName(
  skillName: string,
  rootDir: string = getUserSkillsRoot(),
): Promise<string | null> {
  const name = skillName.trim();
  if (!SKILL_NAME_PATTERN.test(name)) return null;

  const root = path.resolve(rootDir);
  const direct = path.resolve(root, name);
  if (isPathWithin(direct, root) && (await skillMarkdownExists(direct))) {
    return name;
  }

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!SKILL_NAME_PATTERN.test(entry.name)) continue;
    const skillDir = path.resolve(root, entry.name);
    if (!isPathWithin(skillDir, root)) continue;
    try {
      const content = await fs.readFile(
        path.join(skillDir, 'SKILL.md'),
        'utf-8',
      );
      const parsed = parseSkillFrontmatter(content);
      if (parsed?.name?.trim() === name) return entry.name;
    } catch {
      continue;
    }
  }
  return null;
}

export async function resolveSkillDirPath(
  skillName: string,
  rootDir: string = getUserSkillsRoot(),
): Promise<string | null> {
  const dirName = await resolveSkillDirName(skillName, rootDir);
  if (!dirName) return null;
  const root = path.resolve(rootDir);
  const skillDir = path.resolve(root, dirName);
  return isPathWithin(skillDir, root) ? skillDir : null;
}

async function collectSkillFiles(
  skillDir: string,
  relativeDir: string,
  depth: number,
  acc: string[],
): Promise<void> {
  if (acc.length >= MAX_SKILL_FILE_LIST || depth > MAX_SKILL_FILE_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(skillDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (acc.length >= MAX_SKILL_FILE_LIST) return;
    if (entry.name.startsWith('.')) continue;
    if (!RELATIVE_SEGMENT_PATTERN.test(entry.name)) continue;
    const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const nextDepth = rel.split('/').length;
    if (nextDepth > MAX_SKILL_FILE_DEPTH) continue;
    const abs = path.join(skillDir, entry.name);
    if (entry.isDirectory()) {
      await collectSkillFiles(abs, rel, nextDepth, acc);
      continue;
    }
    if (entry.isFile()) acc.push(rel);
  }
}

export async function listSkillFiles(
  skillName: string,
  rootDir: string = getUserSkillsRoot(),
): Promise<string[] | null> {
  const dirName = await resolveSkillDirName(skillName, rootDir);
  if (!dirName) return null;

  const cacheKey = `${rootDir}\u0000${dirName}`;
  const cached = readCache(skillFilesCache, cacheKey);
  if (cached !== undefined) return cached;

  const root = path.resolve(rootDir);
  const skillDir = path.resolve(root, dirName);
  if (!isPathWithin(skillDir, root)) {
    writeCache(skillFilesCache, cacheKey, null);
    return null;
  }

  const files: string[] = [];
  await collectSkillFiles(skillDir, '', 0, files);
  writeCache(skillFilesCache, cacheKey, files);
  return files;
}

export async function readSkillFile(
  skillName: string,
  relativePath?: string,
  rootDir: string = getUserSkillsRoot(),
): Promise<SkillReadResult> {
  const dirName = await resolveSkillDirName(skillName, rootDir);
  if (!dirName) {
    return {
      ok: false,
      error: SKILL_NAME_PATTERN.test(skillName.trim())
        ? 'skill_not_found'
        : 'invalid_name',
    };
  }

  const rel = normalizeSkillRelativePath(relativePath);
  if (!rel) return { ok: false, error: 'invalid_path' };

  const cacheKey = `${rootDir}\u0000${dirName}\u0000${rel}`;
  const cached = readCache(skillContentCache, cacheKey);
  if (cached !== undefined) return cached;

  const root = path.resolve(rootDir);
  const skillDir = path.resolve(root, dirName);
  const filePath = path.resolve(skillDir, ...rel.split('/'));
  if (!isPathWithin(skillDir, root) || !isPathWithin(filePath, skillDir)) {
    const denied: SkillReadResult = { ok: false, error: 'invalid_path' };
    writeCache(skillContentCache, cacheKey, denied);
    return denied;
  }

  let result: SkillReadResult;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      result = { ok: false, error: 'file_not_found' };
    } else {
      const buffer = await fs.readFile(filePath);
      if (looksBinary(buffer)) {
        result = { ok: false, error: 'binary' };
      } else {
        result = {
          ok: true,
          content: truncateSkillContent(buffer.toString('utf-8')),
          relativePath: rel,
        };
      }
    }
  } catch {
    result = { ok: false, error: 'file_not_found' };
  }
  writeCache(skillContentCache, cacheKey, result);
  return result;
}

/**
 * 扫描 skills 根目录下的全部 skill 目录，返回 catalog。
 * 仅收集含 SKILL.md、frontmatter 有效、未禁用模型调用、未在应用内停用且带 description 的目录。
 * name 始终为目录名，保证与工具参数一致。
 */
export async function scanSkillsCatalog(
  rootDir: string = getUserSkillsRoot(),
  hiddenSkills: readonly string[] = [],
): Promise<AgentSkillEntry[]> {
  const cached = readCache(catalogCache, rootDir);
  if (cached) return cached;

  const inventory = await scanSkillsInventory(rootDir, hiddenSkills);
  const skills = inventory
    .filter((item) => item.status === 'available')
    .slice(0, MAX_CATALOG_ENTRIES)
    .map((item) => ({
      name: item.dirName,
      description: item.description,
      scope: 'user' as const,
    }));

  writeCache(catalogCache, rootDir, skills);
  return skills;
}

/**
 * 面板用完整清单：可用 / 已禁用 / 已停用 / 无效（缺 frontmatter 或 description）。
 * 无 SKILL.md 的目录不收录。停用清单由调用方传入（见 skillsStore），
 * 扫描层保持只读文件系统、不直接依赖 userData 存储。
 */
export async function scanSkillsInventory(
  rootDir: string = getUserSkillsRoot(),
  hiddenSkills: readonly string[] = [],
): Promise<AgentSkillInventoryItem[]> {
  const cached = readCache(inventoryCache, rootDir);
  if (cached) return cached;
  const hidden = new Set(hiddenSkills);

  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const items: AgentSkillInventoryItem[] = [];
  for (const entry of entries) {
    if (items.length >= MAX_INVENTORY_ENTRIES) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!SKILL_NAME_PATTERN.test(entry.name)) continue;

    const skillDir = path.resolve(rootDir, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    let content: string;
    try {
      const stat = await fs.stat(skillPath);
      if (!stat.isFile()) continue;
      content = await fs.readFile(skillPath, 'utf-8');
    } catch {
      continue;
    }

    const files = (await listSkillFiles(entry.name, rootDir)) ?? ['SKILL.md'];
    const parsed = parseSkillFrontmatter(content);
    const displayName = parsed?.name?.trim() || entry.name;
    const description = compactDescription(parsed?.description);

    let status: AgentSkillStatus = 'available';
    let reason: string | undefined;
    if (!parsed) {
      status = 'invalid';
      reason = '缺少 YAML frontmatter';
    } else if (hidden.has(entry.name)) {
      status = 'hidden';
      reason = '已在本应用停用';
    } else if (parsed.disableModelInvocation) {
      status = 'disabled';
      reason = '已禁用模型调用';
    } else if (!description) {
      status = 'invalid';
      reason = '缺少 description';
    }

    items.push({
      dirName: entry.name,
      name: displayName,
      description,
      scope: 'user',
      status,
      reason,
      files,
      path: skillDir,
    });
  }

  writeCache(inventoryCache, rootDir, items);
  return items;
}

/**
 * 读取指定 skill 的 SKILL.md 正文。
 * skillName 可以是目录名或 frontmatter name。
 * 内容超限截断；不存在或读取失败返回 null。
 */
export async function readSkillMarkdown(
  skillName: string,
  rootDir: string = getUserSkillsRoot(),
): Promise<string | null> {
  const result = await readSkillFile(skillName, undefined, rootDir);
  return result.ok ? result.content : null;
}
