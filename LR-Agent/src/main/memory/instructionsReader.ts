/**
 * 项目级指令文件读取（对标 Claude Code 的 CLAUDE.md）。
 *
 * 约定位置：{目录}/.lragent/INSTRUCTIONS.md
 * - 标注项目：项目目录下
 * - 工作区（编辑器模式）：工作区根目录下
 */

import fs from 'fs-extra';
import path from 'path';

/** 指令文件最大注入长度（约 16KB），超出截断 */
const MAX_INSTRUCTIONS_CHARS = 16_000;

export const INSTRUCTIONS_RELATIVE_PATH = path.join(
  '.lragent',
  'INSTRUCTIONS.md',
);

/**
 * 读取目录下的 .lragent/INSTRUCTIONS.md。
 * 文件不存在或读取失败时返回 null。
 */
export async function readProjectInstructions(
  directoryPath: string,
): Promise<string | null> {
  if (!directoryPath?.trim()) return null;
  const filePath = path.join(directoryPath, INSTRUCTIONS_RELATIVE_PATH);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const content = await fs.readFile(filePath, 'utf-8');
    const trimmed = content.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_INSTRUCTIONS_CHARS) {
      return `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n…（指令文件过长已截断）`;
    }
    return trimmed;
  } catch {
    return null;
  }
}
