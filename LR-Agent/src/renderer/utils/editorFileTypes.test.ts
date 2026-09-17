import { describe, expect, it } from '@jest/globals';
import { isMonacoEditableFile } from './editorFileTypes';

describe('isMonacoEditableFile', () => {
  it('accepts common text/code extensions and extensionless files', () => {
    expect(isMonacoEditableFile('/ws/src/main.py')).toBe(true);
    expect(isMonacoEditableFile('/ws/readme.md')).toBe(true);
    expect(isMonacoEditableFile('/ws/app.ts')).toBe(true);
    expect(isMonacoEditableFile('/ws/data/train.jsonl')).toBe(true);
    expect(isMonacoEditableFile('/ws/LICENSE')).toBe(true);
    expect(isMonacoEditableFile('/ws/.env')).toBe(true);
    expect(isMonacoEditableFile('/ws/.gitignore')).toBe(true);
  });

  it('rejects binary-like extensions', () => {
    expect(isMonacoEditableFile('/ws/image.png')).toBe(false);
    expect(isMonacoEditableFile('/ws/doc.pdf')).toBe(false);
    expect(isMonacoEditableFile('/ws/archive.zip')).toBe(false);
  });
});
