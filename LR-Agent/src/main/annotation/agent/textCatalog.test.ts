import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { listProjectTextFiles } from './textCatalog';

describe('listProjectTextFiles', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.remove(tmpDir);
    }
  });

  it('lists txt and md files recursively and skips hidden dirs', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-text-catalog-'));
    await fs.outputFile(path.join(tmpDir, 'a.txt'), 'a');
    await fs.outputFile(path.join(tmpDir, 'nested', 'b.md'), 'b');
    await fs.outputFile(path.join(tmpDir, 'skip.png'), 'img');
    await fs.outputFile(path.join(tmpDir, '.lr-agent', 'hidden.txt'), 'hidden');
    await fs.outputFile(path.join(tmpDir, '.hidden', 'x.txt'), 'x');

    const files = await listProjectTextFiles(tmpDir, 100);
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      'a.txt',
      'nested/b.md',
    ]);
  });
});
