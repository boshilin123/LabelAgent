import path from 'path';
import crypto from 'crypto';
import fs from 'fs-extra';

const PROJECT_HIDDEN = '.lr-agent';
const ANNOTATIONS_DIR = 'annotations';
const FILES_DIR = 'files';
const INDEX_FILE = 'index.json';

/** Schema for annotations/index.json */
export interface AnnotationIndexFilePayload {
  schemaVersion: number;
  projectId: string;
  files: Record<
    string,
    {
      fileKey: string;
      relativePath: string;
      annotationCount: number;
      updatedAt: string;
      sourceMtimeMs?: number;
      sourceSize?: number;
    }
  >;
}

function annotationsRoot(projectDir: string): string {
  return path.join(projectDir, PROJECT_HIDDEN, ANNOTATIONS_DIR);
}

export { annotationsRoot };

function filesDir(projectDir: string): string {
  return path.join(annotationsRoot(projectDir), FILES_DIR);
}

function indexPath(projectDir: string): string {
  return path.join(annotationsRoot(projectDir), INDEX_FILE);
}

function docPath(projectDir: string, fileKey: string): string {
  return path.join(filesDir(projectDir), `${fileKey}.json`);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[/\\]/).filter(Boolean).join('/');
}

function computeFileKey(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export async function loadAllAnnotationDocs(
  projectDir: string,
): Promise<Array<{ relativePath: string; doc: unknown }>> {
  const index = await readIndex(projectDir);
  if (!index) return [];

  const results: Array<{ relativePath: string; doc: unknown }> = [];
  for (const entry of Object.values(index.files)) {
    const dp = docPath(projectDir, entry.fileKey);
    if (!(await fs.pathExists(dp))) continue;
    try {
      const doc = await fs.readJson(dp);
      results.push({ relativePath: entry.relativePath, doc });
    } catch {
      // skip corrupt docs
    }
  }
  return results;
}

export async function readAnnotationIndex(
  projectDir: string,
): Promise<AnnotationIndexFilePayload | null> {
  return readIndex(projectDir);
}

async function readIndex(
  projectDir: string,
): Promise<AnnotationIndexFilePayload | null> {
  const ip = indexPath(projectDir);
  try {
    if (!(await fs.pathExists(ip))) return null;
    const data = await fs.readJson(ip);
    if (
      !data ||
      typeof data !== 'object' ||
      typeof data.schemaVersion !== 'number' ||
      typeof data.projectId !== 'string' ||
      !data.files ||
      typeof data.files !== 'object'
    ) {
      return null;
    }
    return data as AnnotationIndexFilePayload;
  } catch {
    return null;
  }
}

async function writeIndex(
  projectDir: string,
  index: AnnotationIndexFilePayload,
): Promise<void> {
  const dir = annotationsRoot(projectDir);
  await fs.ensureDir(dir);
  await fs.writeJson(indexPath(projectDir), index, { spaces: 2 });
}

/** Raw UTF-8 of the per-file annotation JSON; null if missing. */
export async function readAnnotationDocRaw(
  projectDir: string,
  relativePath: string,
): Promise<string | null> {
  const norm = normalizeRelativePath(relativePath);
  const fileKey = computeFileKey(norm);
  const dp = docPath(projectDir, fileKey);
  try {
    if (!(await fs.pathExists(dp))) return null;
    return await fs.readFile(dp, 'utf8');
  } catch {
    return null;
  }
}

/** Remove a per-file annotation JSON and drop it from the index. */
export async function deleteAnnotationDocJson(
  projectDir: string,
  relativePath: string,
): Promise<void> {
  const norm = normalizeRelativePath(relativePath);
  const fileKey = computeFileKey(norm);
  const dp = docPath(projectDir, fileKey);
  await fs.remove(dp);
  const index = await readIndex(projectDir);
  if (!index || !index.files[norm]) return;
  delete index.files[norm];
  await writeIndex(projectDir, index);
}

/** Read per-file annotation JSON; returns undefined if missing. */
export async function readAnnotationDocJson(
  projectDir: string,
  relativePath: string,
): Promise<unknown | null> {
  const norm = normalizeRelativePath(relativePath);
  const fileKey = computeFileKey(norm);
  const dp = docPath(projectDir, fileKey);
  if (!(await fs.pathExists(dp))) return null;
  try {
    return await fs.readJson(dp);
  } catch {
    return null;
  }
}

interface SaveDocMinimalMeta {
  projectId: string;
  schemaVersion?: number;
  filePath?: string;
  annotations?: unknown;
  updatedAt?: string;
}

/**
 * Persist document JSON and update index. Does not deeply validate annotations array.
 */
export async function writeAnnotationDocJson(
  projectDir: string,
  relativePath: string,
  doc: unknown,
  sourceHint?: { mtimeMs?: number; size?: number },
): Promise<void> {
  const norm = normalizeRelativePath(relativePath);
  const fileKey = computeFileKey(norm);

  await fs.ensureDir(filesDir(projectDir));

  await fs.writeJson(docPath(projectDir, fileKey), doc, { spaces: 2 });

  const parsed = doc as SaveDocMinimalMeta;
  const count = Array.isArray(parsed.annotations)
    ? parsed.annotations.length
    : 0;
  const updatedAt =
    typeof parsed.updatedAt === 'string'
      ? parsed.updatedAt
      : new Date().toISOString();
  const pid =
    typeof parsed.projectId === 'string' ? parsed.projectId : 'unknown-project';

  let index =
    (await readIndex(projectDir)) ??
    ({
      schemaVersion: 1,
      projectId: pid,
      files: {},
    } satisfies AnnotationIndexFilePayload);

  if (index.projectId !== pid) index = { ...index, projectId: pid };

  index.files[norm] = {
    fileKey,
    relativePath: norm,
    annotationCount: count,
    updatedAt,
    ...(sourceHint?.mtimeMs !== undefined && {
      sourceMtimeMs: sourceHint.mtimeMs,
    }),
    ...(sourceHint?.size !== undefined && {
      sourceSize: sourceHint.size,
    }),
  };

  await writeIndex(projectDir, index);
}
