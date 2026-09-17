import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import { copySourceMediaForDocs } from '../copySourceMedia';

describe('copySourceMediaForDocs', () => {
  let tmpDir: string;
  let projectDir: string;
  let outputDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-export-'));
    projectDir = path.join(tmpDir, 'project');
    outputDir = path.join(tmpDir, 'out');
    await fs.ensureDir(projectDir);
    await fs.writeFile(path.join(projectDir, 'a.jpg'), 'img-a');
    await fs.mkdirp(path.join(projectDir, 'subdir'));
    await fs.writeFile(path.join(projectDir, 'subdir', 'b.jpg'), 'img-b');
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('copies files into images/ with pathMap', async () => {
    const result = await copySourceMediaForDocs(
      projectDir,
      outputDir,
      ['a.jpg', 'subdir/b.jpg'],
      'images',
    );
    expect(result.copiedCount).toBe(2);
    expect(result.pathMap.get('a.jpg')).toBe('images/a.jpg');
    expect(await fs.pathExists(path.join(outputDir, 'images/a.jpg'))).toBe(
      true,
    );
  });

  it('deduplicates basename conflicts with hash suffix', async () => {
    await fs.mkdirp(path.join(projectDir, 'other'));
    await fs.writeFile(path.join(projectDir, 'other', 'a.jpg'), 'img-other');

    const result = await copySourceMediaForDocs(
      projectDir,
      outputDir,
      ['a.jpg', 'other/a.jpg'],
      'images',
    );
    expect(result.copiedCount).toBe(2);
    const mapped = [...result.pathMap.values()];
    expect(mapped[0]).not.toBe(mapped[1]);
    expect(mapped.every((p) => p.startsWith('images/'))).toBe(true);
  });

  it('records missing files', async () => {
    const result = await copySourceMediaForDocs(
      projectDir,
      outputDir,
      ['missing.jpg'],
      'images',
    );
    expect(result.copiedCount).toBe(0);
    expect(result.missing).toEqual(['missing.jpg']);
  });
});
