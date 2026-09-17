import fs from 'fs-extra';
import path from 'path';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);

export interface ImageCatalogEntry {
  relativePath: string;
  name: string;
  parent: string;
  absolutePath: string;
  index: number;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[/\\]/).filter(Boolean).join('/');
}

function isImageFile(filePath: string): boolean {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return IMAGE_EXT.has(base.slice(dot + 1).toLowerCase());
}

export async function listProjectImages(
  projectDir: string,
  maxFiles = 400,
): Promise<ImageCatalogEntry[]> {
  const root = path.resolve(projectDir);
  if (!(await fs.pathExists(root))) return [];

  const out: Array<Omit<ImageCatalogEntry, 'index'>> = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile() || !isImageFile(abs)) continue;
      const rel = normalizeRelativePath(path.relative(root, abs));
      const parent = normalizeRelativePath(path.dirname(rel));
      out.push({
        relativePath: rel,
        name: entry.name,
        parent: parent === '.' ? '' : parent,
        absolutePath: abs,
      });
    }
  }

  await walk(root);
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out.map((item, index) => ({ ...item, index }));
}
