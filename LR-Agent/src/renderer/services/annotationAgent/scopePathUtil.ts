export interface InputPathEntry {
  relativePath: string;
  absolutePath: string;
}

export type AnnotationScopeRequest = {
  paths?: string[];
  allFiles?: boolean;
  /** @deprecated comma-separated relative paths; prefer `paths` */
  scopeHint?: string;
};

export type AnnotationScopeResult = {
  paths: InputPathEntry[];
  error?: string;
  omittedCount?: number;
  omittedPaths?: string[];
};

const OMITTED_PATHS_PREVIEW = 8;

export function capAnnotationScopePaths(
  paths: InputPathEntry[],
  maxFiles: number,
): Pick<AnnotationScopeResult, 'paths' | 'omittedCount' | 'omittedPaths'> {
  if (paths.length <= maxFiles) {
    return { paths };
  }
  const omitted = paths.slice(maxFiles);
  return {
    paths: paths.slice(0, maxFiles),
    omittedCount: omitted.length,
    omittedPaths: omitted
      .slice(0, OMITTED_PATHS_PREVIEW)
      .map((item) => item.relativePath),
  };
}

export function formatScopeTruncationNote(
  omittedCount?: number,
  omittedPaths?: string[],
  maxFiles: number = 100,
): string {
  if (!omittedCount || omittedCount <= 0) return '';
  const preview = (omittedPaths ?? []).filter(Boolean);
  const previewText = preview.length
    ? `（如 ${preview.join(', ')}${omittedCount > preview.length ? '…' : ''}）`
    : '';
  return (
    `另有 ${omittedCount} 张因单次上限 ${maxFiles} 未纳入${previewText}；` +
    `可再调用 auto_annotate 并传入剩余 paths。`
  );
}

export function scopeTokens(scopeHint?: string): string[] {
  if (!scopeHint) return [];
  return scopeHint
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[/\\]/).filter(Boolean).join('/');
}

export function collectScopeTokens(request: AnnotationScopeRequest): string[] {
  const fromPaths = (request.paths ?? []).map((s) => s.trim()).filter(Boolean);
  if (fromPaths.length > 0) return fromPaths;
  return scopeTokens(request.scopeHint);
}

export function filterPathsByScopeHint(
  allPaths: InputPathEntry[],
  scopeHint?: string,
): InputPathEntry[] {
  const tokens = scopeTokens(scopeHint);
  if (tokens.length === 0) return allPaths;
  const lowered = tokens.map((t) => t.toLowerCase());
  return allPaths.filter((p) => {
    const relLower = p.relativePath.toLowerCase();
    return lowered.some((t) => {
      if (relLower.includes(t)) return true;
      if (t.endsWith('/') && relLower.startsWith(t)) return true;
      return false;
    });
  });
}

export function resolveAnnotationScope(
  allPaths: InputPathEntry[],
  request: AnnotationScopeRequest,
  maxFiles: number,
): AnnotationScopeResult {
  const tokens = collectScopeTokens(request);
  if (tokens.length > 0) {
    const filtered = filterPathsByScopeHint(allPaths, tokens.join(','));
    if (filtered.length === 0) {
      return {
        paths: [],
        error: `未命中任何文件：${tokens.join(', ')}。请用 list_workspace_directory 核对 relativePath，或将 all_files 设为 true。`,
      };
    }
    return capAnnotationScopePaths(filtered, maxFiles);
  }
  if (request.allFiles) {
    if (allPaths.length === 0) {
      return { paths: [], error: '项目内没有可标注文件。' };
    }
    return capAnnotationScopePaths(allPaths, maxFiles);
  }
  return {
    paths: [],
    error:
      '请提供 paths（相对路径或目录前缀），或将 all_files 设为 true（仅当用户明确要求全部文件）。',
  };
}

export async function resolveAnnotationScopePaths(
  allPaths: InputPathEntry[],
  request: AnnotationScopeRequest,
  maxFiles: number,
  resolveRelativeFile?: (
    relativePath: string,
  ) => Promise<InputPathEntry | null>,
): Promise<AnnotationScopeResult> {
  const tokens = collectScopeTokens(request);
  if (tokens.length === 0) {
    return resolveAnnotationScope(allPaths, request, maxFiles);
  }

  const filtered = filterPathsByScopeHint(allPaths, tokens.join(','));
  const known = new Set(filtered.map((p) => p.relativePath.toLowerCase()));

  if (resolveRelativeFile) {
    for (const token of tokens) {
      const normalized = normalizeRelativePath(token.replace(/\/+$/, ''));
      if (!normalized || known.has(normalized.toLowerCase())) continue;
      const resolved = await resolveRelativeFile(normalized);
      if (resolved) {
        filtered.push(resolved);
        known.add(resolved.relativePath.toLowerCase());
      }
    }
  }

  if (filtered.length === 0) {
    return {
      paths: [],
      error: `未命中任何文件：${tokens.join(', ')}。请用 list_workspace_directory 核对 relativePath，或将 all_files 设为 true。`,
    };
  }
  return capAnnotationScopePaths(filtered, maxFiles);
}
