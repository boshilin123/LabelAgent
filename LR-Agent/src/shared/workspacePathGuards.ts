export function isLrAgentRelativePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.includes('.lr-agent');
}
