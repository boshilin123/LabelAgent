import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { app } from 'electron';
import {
  deleteAnnotationDocJson,
  readAnnotationDocRaw,
  writeAnnotationDocJson,
} from '../annotation/annotationDataStore';
import {
  deleteScopedTextFile,
  readScopedTextFile,
  writeScopedTextFile,
} from '../workspace/workspaceWrite';

const ID_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_CHECKPOINTS_PER_SESSION = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type CheckpointKind = 'annotation' | 'file';

export type CheckpointEntry = {
  path: string;
  kind: CheckpointKind;
  beforeMissing: boolean;
  afterHash: string | null;
  blobName: string;
};

export type CheckpointManifest = {
  kind: CheckpointKind;
  createdAt: number;
  entries: CheckpointEntry[];
};

export type CheckpointRef = {
  sessionId: string;
  messageId: string;
  blockIndex: number;
};

export type CheckpointRoots = {
  projectDir?: string;
  workspaceRoot?: string;
};

export type RestoreResult =
  | { ok: true; restoredPaths: string[] }
  | { ok: false; error: string; dirtyPaths?: string[] };

function assertIdSegment(value: string, label: string): string {
  if (!ID_SEGMENT.test(value)) {
    throw new Error(`invalid_checkpoint_id: ${label}`);
  }
  return value;
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function blobNameForPath(relativePath: string): string {
  return crypto
    .createHash('sha256')
    .update(relativePath.replace(/\\/g, '/'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function getCheckpointRootDir(): string {
  return path.join(app.getPath('userData'), 'agent-checkpoints');
}

function resolveBlockDir(ref: CheckpointRef): string {
  const sessionId = assertIdSegment(ref.sessionId, 'sessionId');
  const messageId = assertIdSegment(ref.messageId, 'messageId');
  if (!Number.isInteger(ref.blockIndex) || ref.blockIndex < 0) {
    throw new Error('invalid_checkpoint_id: blockIndex');
  }
  return path.join(
    getCheckpointRootDir(),
    sessionId,
    messageId,
    String(ref.blockIndex),
  );
}

function manifestPath(dir: string): string {
  return path.join(dir, 'manifest.json');
}

async function readManifest(dir: string): Promise<CheckpointManifest | null> {
  try {
    const data = await fs.readJson(manifestPath(dir));
    if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
      return null;
    }
    return data as CheckpointManifest;
  } catch {
    return null;
  }
}

async function writeManifest(
  dir: string,
  manifest: CheckpointManifest,
): Promise<void> {
  await fs.ensureDir(dir);
  await fs.writeJson(manifestPath(dir), manifest, { spaces: 2 });
}

function blobDir(blockDir: string, kind: CheckpointKind): string {
  return path.join(blockDir, kind === 'annotation' ? 'annotations' : 'files');
}

async function pruneSession(sessionId: string): Promise<void> {
  const sessionDir = path.join(getCheckpointRootDir(), sessionId);
  let messageDirs: string[] = [];
  try {
    messageDirs = (await fs.readdir(sessionDir)).map((name) =>
      path.join(sessionDir, name),
    );
  } catch {
    return;
  }

  const blocks: Array<{ dir: string; createdAt: number }> = [];
  const now = Date.now();
  for (const messageDir of messageDirs) {
    let blockNames: string[] = [];
    try {
      blockNames = await fs.readdir(messageDir);
    } catch {
      continue;
    }
    for (const blockName of blockNames) {
      const dir = path.join(messageDir, blockName);
      const manifest = await readManifest(dir);
      if (!manifest) {
        await fs.remove(dir);
        continue;
      }
      if (now - manifest.createdAt > MAX_AGE_MS) {
        await fs.remove(dir);
        continue;
      }
      blocks.push({ dir, createdAt: manifest.createdAt });
    }
  }

  blocks.sort((a, b) => b.createdAt - a.createdAt);
  for (const extra of blocks.slice(MAX_CHECKPOINTS_PER_SESSION)) {
    await fs.remove(extra.dir);
  }
}

export async function captureCheckpoint(
  ref: CheckpointRef,
  kind: CheckpointKind,
  roots: CheckpointRoots,
  paths: { annotationPaths?: string[]; filePaths?: string[] },
): Promise<CheckpointManifest> {
  const dir = resolveBlockDir(ref);
  await fs.remove(dir);
  await fs.ensureDir(dir);

  const entries: CheckpointEntry[] = [];
  const annotationPaths = paths.annotationPaths ?? [];
  const filePaths = paths.filePaths ?? [];

  for (const relativePath of annotationPaths) {
    const blobName = blobNameForPath(relativePath);
    let beforeMissing = true;
    if (roots.projectDir) {
      const raw = await readAnnotationDocRaw(roots.projectDir, relativePath);
      if (raw !== null) {
        beforeMissing = false;
        await fs.ensureDir(blobDir(dir, 'annotation'));
        await fs.writeFile(
          path.join(blobDir(dir, 'annotation'), blobName),
          raw,
          'utf8',
        );
      }
    }
    entries.push({
      path: relativePath.replace(/\\/g, '/'),
      kind: 'annotation',
      beforeMissing,
      afterHash: null,
      blobName,
    });
  }

  for (const relativePath of filePaths) {
    const blobName = blobNameForPath(relativePath);
    let beforeMissing = true;
    const root = roots.projectDir ?? roots.workspaceRoot;
    if (root) {
      const read = await readScopedTextFile(root, relativePath);
      if (read.success && read.exists && typeof read.content === 'string') {
        beforeMissing = false;
        await fs.ensureDir(blobDir(dir, 'file'));
        await fs.writeFile(
          path.join(blobDir(dir, 'file'), blobName),
          read.content,
          'utf8',
        );
      }
    }
    entries.push({
      path: relativePath.replace(/\\/g, '/'),
      kind: 'file',
      beforeMissing,
      afterHash: null,
      blobName,
    });
  }

  const manifest: CheckpointManifest = {
    kind,
    createdAt: Date.now(),
    entries,
  };
  await writeManifest(dir, manifest);
  await pruneSession(ref.sessionId);
  return manifest;
}

export async function recordCheckpointAfter(
  ref: CheckpointRef,
  roots: CheckpointRoots,
): Promise<CheckpointManifest> {
  const dir = resolveBlockDir(ref);
  const manifest = await readManifest(dir);
  if (!manifest) {
    throw new Error('checkpoint_not_found');
  }

  for (const entry of manifest.entries) {
    if (entry.kind === 'annotation') {
      if (!roots.projectDir) {
        throw new Error('checkpoint_missing_project');
      }
      const raw = await readAnnotationDocRaw(roots.projectDir, entry.path);
      entry.afterHash = raw === null ? null : hashContent(raw);
    } else {
      const root = roots.projectDir ?? roots.workspaceRoot;
      if (!root) {
        throw new Error('checkpoint_missing_root');
      }
      const read = await readScopedTextFile(root, entry.path);
      if (!read.success || !read.exists || typeof read.content !== 'string') {
        entry.afterHash = null;
      } else {
        entry.afterHash = hashContent(read.content);
      }
    }
  }

  await writeManifest(dir, manifest);
  return manifest;
}

export async function discardCheckpoint(ref: CheckpointRef): Promise<void> {
  await fs.remove(resolveBlockDir(ref));
}

export async function hasCheckpoint(ref: CheckpointRef): Promise<boolean> {
  const manifest = await readManifest(resolveBlockDir(ref));
  return Boolean(
    manifest &&
    manifest.entries.length > 0 &&
    manifest.entries.every((entry) => Boolean(entry.afterHash)),
  );
}

async function currentHash(
  entry: CheckpointEntry,
  roots: CheckpointRoots,
): Promise<string | null> {
  if (entry.kind === 'annotation') {
    if (!roots.projectDir) return null;
    const raw = await readAnnotationDocRaw(roots.projectDir, entry.path);
    return raw === null ? null : hashContent(raw);
  }
  const root = roots.projectDir ?? roots.workspaceRoot;
  if (!root) return null;
  const read = await readScopedTextFile(root, entry.path);
  if (!read.success || !read.exists || typeof read.content !== 'string') {
    return null;
  }
  return hashContent(read.content);
}

export async function restoreCheckpoint(
  ref: CheckpointRef,
  roots: CheckpointRoots,
): Promise<RestoreResult> {
  const dir = resolveBlockDir(ref);
  const manifest = await readManifest(dir);
  if (!manifest) {
    return { ok: false, error: 'checkpoint_not_found' };
  }
  if (manifest.entries.some((entry) => !entry.afterHash)) {
    return { ok: false, error: 'checkpoint_incomplete' };
  }

  const dirtyPaths: string[] = [];
  for (const entry of manifest.entries) {
    const current = await currentHash(entry, roots);
    if (current !== entry.afterHash) {
      dirtyPaths.push(entry.path);
    }
  }
  if (dirtyPaths.length > 0) {
    return {
      ok: false,
      error: 'checkpoint_dirty',
      dirtyPaths,
    };
  }

  const restoredPaths: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.kind === 'annotation') {
      if (!roots.projectDir) {
        return { ok: false, error: 'checkpoint_missing_project' };
      }
      if (entry.beforeMissing) {
        await deleteAnnotationDocJson(roots.projectDir, entry.path);
      } else {
        const blob = await fs.readFile(
          path.join(blobDir(dir, 'annotation'), entry.blobName),
          'utf8',
        );
        await writeAnnotationDocJson(
          roots.projectDir,
          entry.path,
          JSON.parse(blob),
        );
      }
      restoredPaths.push(entry.path);
      continue;
    }

    const root = roots.projectDir ?? roots.workspaceRoot;
    if (!root) {
      return { ok: false, error: 'checkpoint_missing_root' };
    }
    if (entry.beforeMissing) {
      const deleted = await deleteScopedTextFile(root, entry.path);
      if (!deleted.success) {
        return { ok: false, error: deleted.error ?? 'restore_delete_failed' };
      }
    } else {
      const blob = await fs.readFile(
        path.join(blobDir(dir, 'file'), entry.blobName),
        'utf8',
      );
      const written = await writeScopedTextFile(root, entry.path, blob);
      if (!written.success) {
        return { ok: false, error: written.error ?? 'restore_write_failed' };
      }
    }
    restoredPaths.push(entry.path);
  }

  return { ok: true, restoredPaths };
}
