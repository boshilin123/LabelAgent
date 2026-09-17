import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  assertAgentWritableTopic,
  createMemoryTopic,
  listMemoryEntries,
  readMemoryIndex,
  resolveOpenableMemoryFile,
  syncWorkspaceFactTopics,
  SYSTEM_FACT_TOPIC_READONLY,
} from './memoryStore';

let userDataDir: string;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
  },
}));

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('listMemoryEntries', () => {
  it('includes MEMORY.md and topic cards with excerpts', async () => {
    const scopeKey = 'projects/demo-task';
    await createMemoryTopic({
      scopeKey,
      topicFile: 'annotated-files.md',
      content: '# 已标文件\n',
      indexLine: '- [已标文件](topics/annotated-files.md)：已标 3 张',
    });

    const entries = await listMemoryEntries(scopeKey);
    expect(entries.map((item) => item.relativePath)).toEqual([
      'MEMORY.md',
      'topics/annotated-files.md',
    ]);
    expect(entries[1]?.excerpt).toContain('已标 3 张');
    expect(entries[0]?.absolutePath).toContain(
      path.join('agent-memory', 'projects', 'demo-task'),
    );
  });
});

describe('resolveOpenableMemoryFile', () => {
  const scopeKey = 'projects/demo-task';

  it('resolves MEMORY.md and topic files inside the scope', async () => {
    await createMemoryTopic({
      scopeKey,
      topicFile: 'annotated-files.md',
      content: '# 已标文件\n',
      indexLine: '- [已标文件](topics/annotated-files.md)',
    });
    const indexPath = await resolveOpenableMemoryFile(scopeKey, 'MEMORY.md');
    const topicPath = await resolveOpenableMemoryFile(
      scopeKey,
      'topics/annotated-files.md',
    );
    expect(indexPath.endsWith('MEMORY.md')).toBe(true);
    expect(topicPath.endsWith('annotated-files.md')).toBe(true);
  });

  it('rejects traversal and other scopes', async () => {
    await expect(
      resolveOpenableMemoryFile(scopeKey, '../other.md'),
    ).rejects.toThrow('invalid_memory_path');
    await expect(
      resolveOpenableMemoryFile(scopeKey, 'topics/../MEMORY.md'),
    ).rejects.toThrow('invalid_memory_path');
    await expect(
      resolveOpenableMemoryFile(scopeKey, 'notes.txt'),
    ).rejects.toThrow('invalid_memory_path');
  });

  it('rejects missing files', async () => {
    await expect(
      resolveOpenableMemoryFile(scopeKey, 'MEMORY.md'),
    ).rejects.toThrow('memory_file_not_found');
  });
});

describe('assertAgentWritableTopic', () => {
  it('rejects system fact topics', () => {
    expect(() => assertAgentWritableTopic('progress.md')).toThrow(
      SYSTEM_FACT_TOPIC_READONLY,
    );
    expect(() => assertAgentWritableTopic('annotated-files.md')).toThrow(
      SYSTEM_FACT_TOPIC_READONLY,
    );
    expect(() => assertAgentWritableTopic('conventions.md')).not.toThrow();
  });
});

describe('syncWorkspaceFactTopics', () => {
  const scopeKey = 'projects/demo-task';

  async function writeIndex(
    projectDir: string,
    files: Record<string, { annotationCount: number }>,
  ) {
    const indexPath = path.join(
      projectDir,
      '.lr-agent',
      'annotations',
      'index.json',
    );
    await fs.ensureDir(path.dirname(indexPath));
    const payload = {
      schemaVersion: 1,
      projectId: 'demo-task',
      files: Object.fromEntries(
        Object.entries(files).map(([relativePath, meta]) => [
          relativePath,
          {
            fileKey: 'k',
            relativePath,
            annotationCount: meta.annotationCount,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ),
    };
    await fs.writeJson(indexPath, payload);
  }

  it('writes fact topics from the annotation index', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-index-'));
    try {
      await writeIndex(projectDir, {
        'img/a.jpg': { annotationCount: 2 },
        'img/b.jpg': { annotationCount: 0 },
      });
      const result = await syncWorkspaceFactTopics({ scopeKey, projectDir });
      expect(result.annotatedFiles).toBe(1);
      expect(result.annotationCount).toBe(2);
      const index = await readMemoryIndex(scopeKey);
      expect(index).toContain('已标 1 个文件，共 2 条');
      const annotated = await fs.readFile(
        path.join(
          userDataDir,
          'agent-memory',
          'projects',
          'demo-task',
          'topics',
          'annotated-files.md',
        ),
        'utf8',
      );
      expect(annotated).toContain('img/a.jpg (2)');
      expect(annotated).toContain('img/b.jpg (0)');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('writes empty facts when the index is missing', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-empty-'));
    try {
      await syncWorkspaceFactTopics({ scopeKey, projectDir });
      const index = await readMemoryIndex(scopeKey);
      expect(index).toContain('尚无已落盘标注');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('overwrites previous hallucinated counts', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-overwrite-'));
    try {
      await createMemoryTopic({
        scopeKey,
        topicFile: 'progress.md',
        content: '# 进度\n已标 99/99\n',
        indexLine: '- [进度](topics/progress.md)：已标 99/99',
      });
      await writeIndex(projectDir, { 'only.jpg': { annotationCount: 1 } });
      await syncWorkspaceFactTopics({ scopeKey, projectDir });
      const index = await readMemoryIndex(scopeKey);
      expect(index).toContain('已标 1 个文件，共 1 条');
      expect(index).not.toContain('99/99');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
