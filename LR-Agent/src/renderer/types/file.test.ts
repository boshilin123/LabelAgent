import { describe, expect, it } from '@jest/globals';
import { getExtension } from './file';

describe('getExtension', () => {
  it('handles dotfiles as pseudo extensions', () => {
    expect(getExtension('/ws/.env')).toBe('env');
    expect(getExtension('/ws/.gitignore')).toBe('gitignore');
  });

  it('handles regular files', () => {
    expect(getExtension('/ws/data.jsonl')).toBe('jsonl');
    expect(getExtension('/ws/LICENSE')).toBe('');
  });
});
