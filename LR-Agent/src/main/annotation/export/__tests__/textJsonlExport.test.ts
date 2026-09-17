import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import { exportTextJsonl } from '../textJsonlExport';
import { LabelResolver } from '../labelUtil';
import type { LoadedTextDoc } from '../types';

describe('exportTextJsonl', () => {
  let tmpDir: string;
  let projectDir: string;
  let outputDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-jsonl-'));
    projectDir = path.join(tmpDir, 'project');
    outputDir = path.join(tmpDir, 'out');
    await fs.ensureDir(projectDir);
    await fs.writeFile(
      path.join(projectDir, 'sample.txt'),
      'Hello world',
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('exports instruction schema lines', async () => {
    const docs: LoadedTextDoc[] = [
      {
        kind: 'text',
        relativePath: 'sample.txt',
        filePath: 'sample.txt',
        annotations: [
          {
            kind: 'instruction',
            instruction: 'Translate',
            input: 'Hi',
            output: '你好',
            labelId: 'l1',
          },
        ],
      },
    ];
    const resolver = new LabelResolver([{ id: 'l1', name: 'zh' }]);
    await exportTextJsonl(projectDir, outputDir, 'instruction', docs, resolver);
    const content = await fs.readFile(
      path.join(outputDir, 'instruction.jsonl'),
      'utf8',
    );
    const row = JSON.parse(content.trim());
    expect(row).toMatchObject({
      instruction: 'Translate',
      input: 'Hi',
      output: '你好',
      label: 'zh',
      source_file: 'sample.txt',
    });
  });

  it('aggregates span_ner per document with source text', async () => {
    const docs: LoadedTextDoc[] = [
      {
        kind: 'text',
        relativePath: 'sample.txt',
        filePath: 'sample.txt',
        annotations: [{ kind: 'span_ner', start: 0, end: 5, labelId: 'l1' }],
      },
    ];
    const resolver = new LabelResolver([{ id: 'l1', name: 'ORG' }]);
    await exportTextJsonl(projectDir, outputDir, 'span_ner', docs, resolver);
    const row = JSON.parse(
      await fs.readFile(path.join(outputDir, 'span_ner.jsonl'), 'utf8'),
    );
    expect(row.text).toBe('Hello world');
    expect(row.spans).toEqual([
      { start: 0, end: 5, label: 'l1', label_name: 'ORG' },
    ]);
  });
});
