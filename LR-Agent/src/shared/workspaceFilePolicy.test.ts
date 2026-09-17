import { describe, expect, it } from '@jest/globals';
import {
  isBlockedTextExtension,
  isSpecialPreviewFile,
  isTextEditableFile,
} from './workspaceTextExtensions';

describe('workspace file policy', () => {
  it('allows common text and code files including jsonl', () => {
    expect(isTextEditableFile('/ws/data/train.jsonl')).toBe(true);
    expect(isTextEditableFile('/ws/logs/app.log')).toBe(true);
    expect(isTextEditableFile('/ws/styles/main.css')).toBe(true);
    expect(isTextEditableFile('/ws/LICENSE')).toBe(true);
    expect(isTextEditableFile('/ws/Makefile')).toBe(true);
    expect(isTextEditableFile('/ws/.env')).toBe(true);
    expect(isTextEditableFile('/ws/.gitignore')).toBe(true);
  });

  it('blocks binary and rich media previews', () => {
    expect(isTextEditableFile('/ws/image.png')).toBe(false);
    expect(isTextEditableFile('/ws/doc.pdf')).toBe(false);
    expect(isTextEditableFile('/ws/archive.zip')).toBe(false);
    expect(isSpecialPreviewFile('/ws/image.png')).toBe(true);
    expect(isSpecialPreviewFile('/ws/readme.md')).toBe(false);
  });

  it('uses blocklist for extension checks', () => {
    expect(isBlockedTextExtension('.png')).toBe(true);
    expect(isBlockedTextExtension('png')).toBe(true);
    expect(isBlockedTextExtension('.jsonl')).toBe(false);
    expect(isBlockedTextExtension('')).toBe(false);
  });

  it('blocks script and executable extensions from being written', () => {
    for (const filePath of [
      '/ws/evil.bat',
      '/ws/evil.cmd',
      '/ws/evil.ps1',
      '/ws/evil.psm1',
      '/ws/evil.vbs',
      '/ws/evil.hta',
      '/ws/evil.scr',
      '/ws/evil.com',
      '/ws/evil.jar',
      '/ws/evil.reg',
      '/ws/evil.lnk',
    ]) {
      expect(isTextEditableFile(filePath)).toBe(false);
      expect(isBlockedTextExtension(filePath.split('.').pop() ?? '')).toBe(
        true,
      );
    }
  });
});
