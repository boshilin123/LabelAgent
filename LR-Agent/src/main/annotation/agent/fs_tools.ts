import fs from 'fs-extra';
import path from 'path';

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[/\\]/).filter(Boolean).join('/');
}

export async function resolveProjectRelativeFile(
  projectDir: string,
  relativePath: string,
): Promise<{ relativePath: string; absolutePath: string } | null> {
  const root = path.resolve(projectDir);
  const norm = normalizeRelativePath(relativePath);
  if (!norm || norm.includes('..')) return null;
  const abs = path.resolve(root, norm);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  if (!(await fs.pathExists(abs))) return null;
  const stat = await fs.stat(abs);
  if (!stat.isFile()) return null;
  return { relativePath: norm, absolutePath: abs };
}
