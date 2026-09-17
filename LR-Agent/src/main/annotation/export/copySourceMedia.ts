import path from 'path';
import crypto from 'crypto';
import fs from 'fs-extra';
import { ensureDir, isSyntheticPath } from './fsUtil';

export type MediaFolder = 'images' | 'sources';

export interface CopyMediaResult {
  /** project relativePath -> export-relative path e.g. images/foo.jpg */
  pathMap: Map<string, string>;
  copiedCount: number;
  missing: string[];
}

function uniqueDestName(
  destDir: string,
  basename: string,
  usedNames: Set<string>,
  relativePath: string,
): string {
  if (!usedNames.has(basename)) {
    usedNames.add(basename);
    return basename;
  }
  const hash = crypto
    .createHash('sha256')
    .update(relativePath, 'utf8')
    .digest('hex')
    .slice(0, 8);
  const ext = path.extname(basename);
  const stem = ext ? basename.slice(0, -ext.length) : basename;
  const candidate = `${stem}_${hash}${ext}`;
  usedNames.add(candidate);
  return candidate;
}

export async function copySourceMediaForDocs(
  projectDir: string,
  outputDir: string,
  relativePaths: string[],
  folder: MediaFolder,
): Promise<CopyMediaResult> {
  const pathMap = new Map<string, string>();
  const missing: string[] = [];
  let copiedCount = 0;
  const destRoot = path.join(outputDir, folder);
  await ensureDir(destRoot);
  const usedNames = new Set<string>();

  for (const relativePath of relativePaths) {
    if (isSyntheticPath(relativePath)) continue;
    const abs = path.join(projectDir, relativePath);
    if (!(await fs.pathExists(abs))) {
      missing.push(relativePath);
      continue;
    }
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      missing.push(relativePath);
      continue;
    }
    const base = path.basename(relativePath);
    const destName = uniqueDestName(destRoot, base, usedNames, relativePath);
    const destAbs = path.join(destRoot, destName);
    await fs.copy(abs, destAbs, { overwrite: true });
    const exportRel = `${folder}/${destName}`.replace(/\\/g, '/');
    pathMap.set(relativePath, exportRel);
    copiedCount += 1;
  }

  return { pathMap, copiedCount, missing };
}

export function exportedMediaPath(
  pathMap: Map<string, string>,
  relativePath: string,
  fallbackFolder: MediaFolder,
): string {
  const mapped = pathMap.get(relativePath);
  if (mapped) return mapped;
  const base = path.basename(relativePath);
  return `${fallbackFolder}/${base}`.replace(/\\/g, '/');
}
