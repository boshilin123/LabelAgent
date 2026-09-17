import path from 'path';
import fs from 'fs-extra';

export async function ensureDir(dir: string): Promise<void> {
  await fs.ensureDir(dir);
}

export async function writeText(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

export async function writeJson(
  filePath: string,
  data: unknown,
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, data, { spaces: 2 });
}

export function stemFromRelative(relativePath: string): string {
  const base = path.posix.basename(relativePath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function isSyntheticPath(relativePath: string): boolean {
  return relativePath.replace(/^[/\\]+/, '').startsWith('_synthetic_/');
}
