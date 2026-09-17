import { describe, expect, it } from '@jest/globals';
import {
  consumeChangedPath,
  markWorkspaceTextFilesChanged,
  pathsEqual,
  peekChangedPath,
} from './agentFilePreviewStore';

describe('pathsEqual', () => {
  it('treats slash variants as the same path', () => {
    expect(pathsEqual('D:\\proj\\notes.md', 'D:/proj/notes.md')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(pathsEqual('D:/proj/Notes.md', 'd:/proj/notes.md')).toBe(true);
  });

  it('rejects different files', () => {
    expect(pathsEqual('D:/proj/a.md', 'D:/proj/b.md')).toBe(false);
  });
});

describe('markWorkspaceTextFilesChanged / peek / consume', () => {
  it('peeks true for the tab whose absolute path ends with the relative proposal path', () => {
    markWorkspaceTextFilesChanged(['algorithm/union_find.h']);
    expect(peekChangedPath('C:\\work\\demo\\algorithm\\union_find.h')).toBe(
      true,
    );
    expect(peekChangedPath('C:\\work\\demo\\other.md')).toBe(false);
    consumeChangedPath('C:/work/demo/algorithm/union_find.h');
    expect(peekChangedPath('C:\\work\\demo\\algorithm\\union_find.h')).toBe(
      false,
    );
  });

  it('ignores ./ prefixes and slash variants when matching', () => {
    markWorkspaceTextFilesChanged(['./docs\\a.md']);
    expect(peekChangedPath('D:/ws/docs/a.md')).toBe(true);
    consumeChangedPath('D:/ws/docs/a.md');
    expect(peekChangedPath('D:/ws/docs/a.md')).toBe(false);
  });

  it('matches absolute marked path against relative tab path', () => {
    markWorkspaceTextFilesChanged(['C:/work/demo/a.md']);
    expect(peekChangedPath('a.md')).toBe(true);
    consumeChangedPath('a.md');
  });

  it('keeps the mark when a load is abandoned before consuming', () => {
    markWorkspaceTextFilesChanged(['b.md']);
    expect(peekChangedPath('b.md')).toBe(true);
    expect(peekChangedPath('b.md')).toBe(true);
    consumeChangedPath('b.md');
    expect(peekChangedPath('b.md')).toBe(false);
  });

  it('ignores empty paths', () => {
    markWorkspaceTextFilesChanged(['', '  ']);
    expect(peekChangedPath('')).toBe(false);
  });
});
