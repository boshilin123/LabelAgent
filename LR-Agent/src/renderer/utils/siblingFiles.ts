import { DirectoryItem } from '../../main/preload';
import { dirname } from '../types/file';

function sortSiblingFiles(items: DirectoryItem[]): string[] {
  return items
    .filter((item) => !item.isDirectory)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => item.path);
}

export async function listSiblingFiles(filePath: string): Promise<string[]> {
  const parentDir = dirname(filePath);
  if (!parentDir) return [filePath];

  const items = await window.electron.fileSystem?.readDirectory(parentDir);
  if (!items?.length) return [filePath];

  const files = sortSiblingFiles(items);
  return files.length > 0 ? files : [filePath];
}

export async function getAdjacentSiblingFile(
  filePath: string,
  direction: 'prev' | 'next',
): Promise<string | null> {
  const siblings = await listSiblingFiles(filePath);
  if (siblings.length === 0) return null;

  const currentIndex = siblings.findIndex((path) => path === filePath);
  const index = currentIndex >= 0 ? currentIndex : 0;
  const offset = direction === 'next' ? 1 : -1;
  const nextIndex = (index + offset + siblings.length) % siblings.length;
  return siblings[nextIndex] ?? null;
}
