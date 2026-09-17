import { describe, expect, it } from '@jest/globals';
import {
  resolveWorkspaceAbsolutePath,
  resolveWorkspaceRoot,
} from './workspacePaths';

describe('workspacePaths', () => {
  it('prefers annotation project directory over workspace root', () => {
    expect(
      resolveWorkspaceRoot({ directoryPath: '/proj' } as never, '/ws'),
    ).toBe('/proj');
    expect(resolveWorkspaceRoot(null, '/ws')).toBe('/ws');
    expect(resolveWorkspaceRoot(null, null)).toBeNull();
  });

  it('joins relative path under resolved root', () => {
    expect(resolveWorkspaceAbsolutePath('src/main.ts', null, '/ws')).toBe(
      '/ws/src/main.ts',
    );
    expect(resolveWorkspaceAbsolutePath('/src/main.ts', null, '/ws')).toBe(
      '/ws/src/main.ts',
    );
    expect(resolveWorkspaceAbsolutePath('a.ts', null, null)).toBeNull();
  });

  it('normalizes backslashes and ./ prefixes like the backend', () => {
    expect(resolveWorkspaceAbsolutePath('.\\docs\\a.md', null, 'C:\\ws')).toBe(
      'C:/ws/docs/a.md',
    );
    expect(resolveWorkspaceAbsolutePath('./docs/a.md', null, 'C:\\ws')).toBe(
      'C:/ws/docs/a.md',
    );
  });

  it('accepts an in-root drive-letter absolute path and rejects outside ones', () => {
    expect(resolveWorkspaceAbsolutePath('C:\\ws\\a.md', null, 'C:\\ws')).toBe(
      'C:/ws/a.md',
    );
    expect(
      resolveWorkspaceAbsolutePath('C:\\other\\a.md', null, 'C:\\ws'),
    ).toBeNull();
  });

  it('rejects the root directory itself and traversal', () => {
    expect(resolveWorkspaceAbsolutePath('C:\\ws', null, 'C:\\ws')).toBeNull();
    expect(resolveWorkspaceAbsolutePath('C:\\ws\\', null, 'C:\\ws')).toBeNull();
    expect(resolveWorkspaceAbsolutePath('.', null, 'C:\\ws')).toBeNull();
    expect(resolveWorkspaceAbsolutePath('../a.md', null, 'C:\\ws')).toBeNull();
    expect(
      resolveWorkspaceAbsolutePath('a/../..//b.md', null, 'C:\\ws'),
    ).toBeNull();
  });
});
