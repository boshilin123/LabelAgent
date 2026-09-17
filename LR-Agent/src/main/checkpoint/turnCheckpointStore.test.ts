import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { writeAnnotationDocJson } from '../annotation/annotationDataStore';
import { writeScopedTextFile } from '../workspace/workspaceWrite';
import {
  captureCheckpoint,
  hashContent,
  recordCheckpointAfter,
  restoreCheckpoint,
} from './turnCheckpointStore';

let userDataDir: string;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
  },
}));

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-store-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

const ref = {
  sessionId: 'sess-1',
  messageId: 'msg-1',
  blockIndex: 0,
};

describe('turnCheckpointStore', () => {
  it('restores a file to its pre-apply content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-ws-'));
    try {
      await writeScopedTextFile(root, 'notes.md', 'before');
      await captureCheckpoint(
        ref,
        'file',
        { workspaceRoot: root },
        {
          filePaths: ['notes.md'],
        },
      );
      await writeScopedTextFile(root, 'notes.md', 'after');
      await recordCheckpointAfter(ref, { workspaceRoot: root });

      const restored = await restoreCheckpoint(ref, { workspaceRoot: root });
      expect(restored.ok).toBe(true);
      const text = await fs.readFile(path.join(root, 'notes.md'), 'utf8');
      expect(text).toBe('before');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses restore when the file is dirty', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-dirty-'));
    try {
      await writeScopedTextFile(root, 'notes.md', 'before');
      await captureCheckpoint(
        ref,
        'file',
        { workspaceRoot: root },
        {
          filePaths: ['notes.md'],
        },
      );
      await writeScopedTextFile(root, 'notes.md', 'after');
      await recordCheckpointAfter(ref, { workspaceRoot: root });
      await writeScopedTextFile(root, 'notes.md', 'hand-edit');

      const restored = await restoreCheckpoint(ref, { workspaceRoot: root });
      expect(restored).toEqual({
        ok: false,
        error: 'checkpoint_dirty',
        dirtyPaths: ['notes.md'],
      });
      const text = await fs.readFile(path.join(root, 'notes.md'), 'utf8');
      expect(text).toBe('hand-edit');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores annotation docs and rejects dirty annotation hashes', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-ann-'));
    try {
      await writeAnnotationDocJson(projectDir, 'img/a.jpg', {
        projectId: 'p1',
        annotations: [{ id: '1' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await captureCheckpoint(
        ref,
        'annotation',
        { projectDir },
        { annotationPaths: ['img/a.jpg'] },
      );
      await writeAnnotationDocJson(projectDir, 'img/a.jpg', {
        projectId: 'p1',
        annotations: [{ id: '1' }, { id: '2' }],
        updatedAt: '2026-01-01T00:00:01.000Z',
      });
      await recordCheckpointAfter(ref, { projectDir });

      const dirty = await restoreCheckpoint(
        { ...ref, blockIndex: 0 },
        { projectDir },
      );
      expect(dirty.ok).toBe(true);

      await writeAnnotationDocJson(projectDir, 'img/a.jpg', {
        projectId: 'p1',
        annotations: [{ id: '1' }, { id: '2' }],
        updatedAt: '2026-01-01T00:00:01.000Z',
      });
      await recordCheckpointAfter(ref, { projectDir });
      await writeAnnotationDocJson(projectDir, 'img/a.jpg', {
        projectId: 'p1',
        annotations: [{ id: 'x' }],
        updatedAt: '2026-01-01T00:00:02.000Z',
      });
      const refused = await restoreCheckpoint(ref, { projectDir });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error).toBe('checkpoint_dirty');
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('hashes content stably', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });
});
