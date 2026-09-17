import fs from 'fs-extra';
import path from 'path';
import { isBlockedTextExtension } from '../../shared/workspaceTextExtensions';

function isLrAgentRelativePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.includes('.lr-agent');
}

function resolveScopedTextPath(
  rootDir: string,
  relativePath: string,
): { absolutePath: string; relativePath: string } | { error: string } {
  const root = path.resolve(rootDir);
  const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.includes('..')) {
    return { error: 'path_traversal_forbidden' };
  }
  if (isLrAgentRelativePath(rel)) {
    return { error: 'lr_agent_dir_forbidden' };
  }
  const ext = path.extname(rel).toLowerCase();
  if (ext && isBlockedTextExtension(ext)) {
    return { error: 'extension_blocked' };
  }
  const absolutePath = path.resolve(root, rel);
  const relToRoot = path.relative(root, absolutePath);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    return { error: 'path_outside_root' };
  }
  return { absolutePath, relativePath: rel.replace(/\\/g, '/') };
}

function normalizeForCompare(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

/**
 * 用 realpath 校验目标（或其最近的已存在祖先）真实落在授权根内，
 * 防止工作区内的符号链接把读写重定向到根目录之外。
 */
async function isRealPathWithinRoot(
  rootDir: string,
  absolutePath: string,
): Promise<boolean> {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(path.resolve(rootDir));
  } catch {
    return false;
  }
  const rootRealNorm = normalizeForCompare(rootReal);
  let probe = path.resolve(absolutePath);
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const relToRoot = path.relative(rootRealNorm, normalizeForCompare(real));
      return (
        relToRoot === '' ||
        (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot))
      );
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

export async function writeScopedTextFile(
  rootDir: string,
  relativePath: string,
  content: string,
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const resolved = resolveScopedTextPath(rootDir, relativePath);
  if ('error' in resolved) {
    return { success: false, error: resolved.error };
  }
  if (!(await isRealPathWithinRoot(rootDir, resolved.absolutePath))) {
    return { success: false, error: 'path_outside_root' };
  }
  await fs.ensureDir(path.dirname(resolved.absolutePath));
  await fs.writeFile(resolved.absolutePath, content, 'utf8');
  return { success: true, filePath: resolved.absolutePath };
}

export async function readScopedTextFile(
  rootDir: string,
  relativePath: string,
): Promise<{
  success: boolean;
  content?: string;
  exists?: boolean;
  filePath?: string;
  error?: string;
}> {
  const resolved = resolveScopedTextPath(rootDir, relativePath);
  if ('error' in resolved) {
    return { success: false, error: resolved.error };
  }
  if (!(await isRealPathWithinRoot(rootDir, resolved.absolutePath))) {
    return { success: false, error: 'path_outside_root' };
  }
  try {
    const exists = await fs.pathExists(resolved.absolutePath);
    if (!exists) {
      return {
        success: true,
        exists: false,
        content: '',
        filePath: resolved.absolutePath,
      };
    }
    const content = await fs.readFile(resolved.absolutePath, 'utf8');
    return {
      success: true,
      exists: true,
      content,
      filePath: resolved.absolutePath,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'read_failed',
    };
  }
}

export async function deleteScopedTextFile(
  rootDir: string,
  relativePath: string,
): Promise<{ success: boolean; error?: string }> {
  const resolved = resolveScopedTextPath(rootDir, relativePath);
  if ('error' in resolved) {
    return { success: false, error: resolved.error };
  }
  if (!(await isRealPathWithinRoot(rootDir, resolved.absolutePath))) {
    return { success: false, error: 'path_outside_root' };
  }
  try {
    await fs.remove(resolved.absolutePath);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'delete_failed',
    };
  }
}

export async function moveScopedTextFile(
  rootDir: string,
  relativePath: string,
  newRelativePath: string,
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const src = resolveScopedTextPath(rootDir, relativePath);
  if ('error' in src) {
    return { success: false, error: src.error };
  }
  const dst = resolveScopedTextPath(rootDir, newRelativePath);
  if ('error' in dst) {
    return { success: false, error: dst.error };
  }
  if (
    !(await isRealPathWithinRoot(rootDir, src.absolutePath)) ||
    !(await isRealPathWithinRoot(rootDir, dst.absolutePath))
  ) {
    return { success: false, error: 'path_outside_root' };
  }
  try {
    if (await fs.pathExists(dst.absolutePath)) {
      return { success: false, error: 'target_exists' };
    }
    await fs.ensureDir(path.dirname(dst.absolutePath));
    await fs.move(src.absolutePath, dst.absolutePath);
    return { success: true, filePath: dst.absolutePath };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'move_failed',
    };
  }
}
