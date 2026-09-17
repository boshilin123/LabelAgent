export function normalizeFsPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Build a POSIX-style relative path from project root when `absolutePath` is under root.
 */
export function getRelativeProjectPath(
  projectRootAbsolute: string,
  fileAbsolutePath: string,
): string | null {
  const root = normalizeFsPath(projectRootAbsolute).replace(/\/$/, '');
  const file = normalizeFsPath(fileAbsolutePath);
  const lowerRoot = root.toLowerCase();
  const lowerFile = file.toLowerCase();

  if (lowerFile === lowerRoot) return '';
  const prefix = `${lowerRoot}/`;
  if (!lowerFile.startsWith(prefix)) return null;

  const rel = file.slice(root.length).replace(/^[/\\]/, '');
  return rel.split(/[/\\]/).join('/');
}
