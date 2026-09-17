/**
 * 全局 Agent Skills 的应用内停用清单（持久化于 <userData>/skills.json）。
 *
 * 只存「在本应用内停用」的 skill 目录名，不改 ~/.agents/skills 里的任何文件，
 * 因此与其它读取同一目录的工具（如 ZCode）互不影响。
 * 停用语义是硬禁用：既不注入 system prompt 的可用 Skills 清单，也拒绝
 * read_agent_skill / list_agent_skill_files 读取。
 */
import path from 'path';
import fs from 'fs-extra';
import { app } from 'electron';

export interface SkillsConfig {
  /** 在本应用内停用的 skill 目录名 */
  hiddenSkills: string[];
}

export function getSkillsStorePath(): string {
  return path.join(app.getPath('userData'), 'skills.json');
}

export function defaultSkillsConfig(): SkillsConfig {
  return { hiddenSkills: [] };
}

/** 目录名白名单：与 skillScanner 的 SKILL_NAME_PATTERN 一致 */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sanitizeHiddenSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || !SKILL_NAME_PATTERN.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 200) break;
  }
  return out;
}

function sanitizeConfig(raw: unknown): SkillsConfig {
  if (!raw || typeof raw !== 'object') return defaultSkillsConfig();
  return {
    hiddenSkills: sanitizeHiddenSkills(
      (raw as Record<string, unknown>).hiddenSkills,
    ),
  };
}

let cached: SkillsConfig | null = null;

/** 同步读取（内存缓存优先），供 prompt 注入路径等同步调用点使用 */
export function getSkillsConfig(): SkillsConfig {
  if (cached) return cached;
  try {
    cached = sanitizeConfig(
      fs.readJsonSync(getSkillsStorePath(), { throws: false }),
    );
  } catch {
    cached = defaultSkillsConfig();
  }
  return cached;
}

/** 停用清单（数组形式，调用方按需转 Set 判定） */
export function getHiddenSkills(): string[] {
  return getSkillsConfig().hiddenSkills;
}

export function isSkillHidden(dirName: string): boolean {
  return getSkillsConfig().hiddenSkills.includes(dirName);
}

async function writeSkillsConfig(config: SkillsConfig): Promise<SkillsConfig> {
  cached = config;
  const storePath = getSkillsStorePath();
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, config, { spaces: 2 });
  return config;
}

/** 设置单个 skill 的停用状态，返回写入后的清单 */
export async function setSkillHidden(
  dirName: string,
  hidden: boolean,
): Promise<SkillsConfig> {
  if (!dirName || !SKILL_NAME_PATTERN.test(dirName)) return getSkillsConfig();
  const current = getSkillsConfig().hiddenSkills;
  const next = hidden
    ? [...current, dirName]
    : current.filter((name) => name !== dirName);
  return writeSkillsConfig({ hiddenSkills: sanitizeHiddenSkills(next) });
}

/** 仅测试用 */
export function resetSkillsStoreCache(): void {
  cached = null;
}
