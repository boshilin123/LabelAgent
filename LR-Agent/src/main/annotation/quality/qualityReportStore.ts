import path from 'path';
import fs from 'fs-extra';
import type { QualityReportIndexEntry } from '../../../shared/qualityReportTypes';

const PROJECT_HIDDEN = '.lr-agent';
const REPORTS_DIR = 'quality-reports';
const INDEX_FILE = 'index.json';

interface QualityReportIndexFile {
  schemaVersion: 1;
  entries: QualityReportIndexEntry[];
}

function reportsRoot(projectDir: string): string {
  return path.join(projectDir, PROJECT_HIDDEN, REPORTS_DIR);
}

function indexPath(projectDir: string): string {
  return path.join(reportsRoot(projectDir), INDEX_FILE);
}

function runDir(projectDir: string, runId: string): string {
  return path.join(reportsRoot(projectDir), runId);
}

function chartsDir(projectDir: string, runId: string): string {
  return path.join(runDir(projectDir, runId), 'charts');
}

async function readIndex(projectDir: string): Promise<QualityReportIndexFile> {
  const fp = indexPath(projectDir);
  if (!(await fs.pathExists(fp))) {
    return { schemaVersion: 1, entries: [] };
  }
  try {
    const data = await fs.readJson(fp);
    if (data && Array.isArray(data.entries)) {
      return { schemaVersion: 1, entries: data.entries };
    }
  } catch {
    // fall through
  }
  return { schemaVersion: 1, entries: [] };
}

async function writeIndex(
  projectDir: string,
  index: QualityReportIndexFile,
): Promise<void> {
  const root = reportsRoot(projectDir);
  await fs.ensureDir(root);
  await fs.writeJson(indexPath(projectDir), index, { spaces: 2 });
}

export function createRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function createQualityReportRun(
  projectDir: string,
  runId: string,
): Promise<{ runId: string; runAbsolutePath: string }> {
  const dir = runDir(projectDir, runId);
  await fs.ensureDir(dir);
  await fs.ensureDir(chartsDir(projectDir, runId));
  return { runId, runAbsolutePath: dir };
}

export async function writeQualityChart(
  projectDir: string,
  runId: string,
  fileName: string,
  base64Png: string,
): Promise<string> {
  const dir = chartsDir(projectDir, runId);
  await fs.ensureDir(dir);
  const safeName = path.basename(fileName);
  const fp = path.join(dir, safeName);
  await fs.writeFile(fp, Buffer.from(base64Png, 'base64'));
  return path.join('charts', safeName).replace(/\\/g, '/');
}

export async function writeQualitySnapshot(
  projectDir: string,
  runId: string,
  payload: unknown,
): Promise<void> {
  const fp = path.join(runDir(projectDir, runId), 'snapshot.json');
  await fs.writeJson(fp, payload, { spaces: 2 });
}

export async function writeQualityFindings(
  projectDir: string,
  runId: string,
  payload: unknown,
): Promise<void> {
  const fp = path.join(runDir(projectDir, runId), 'findings.json');
  await fs.writeJson(fp, payload, { spaces: 2 });
}

export async function writeQualityReportMarkdown(
  projectDir: string,
  runId: string,
  markdown: string,
  indexEntry: QualityReportIndexEntry,
): Promise<{ reportRelativePath: string; reportAbsolutePath: string }> {
  const fp = path.join(runDir(projectDir, runId), 'report.md');
  await fs.writeFile(fp, markdown, 'utf8');

  const index = await readIndex(projectDir);
  index.entries = [
    indexEntry,
    ...index.entries.filter((e) => e.runId !== runId),
  ].slice(0, 50);
  await writeIndex(projectDir, index);

  const reportRelativePath = path
    .join(PROJECT_HIDDEN, REPORTS_DIR, runId, 'report.md')
    .replace(/\\/g, '/');

  return { reportRelativePath, reportAbsolutePath: fp };
}

export async function listQualityReports(
  projectDir: string,
): Promise<QualityReportIndexEntry[]> {
  const index = await readIndex(projectDir);
  return index.entries;
}

export async function readQualityReport(
  projectDir: string,
  runId: string,
): Promise<{
  markdown: string;
  runAbsolutePath: string;
  chartsDir: string;
} | null> {
  const dir = runDir(projectDir, runId);
  const fp = path.join(dir, 'report.md');
  if (!(await fs.pathExists(fp))) return null;
  const markdown = await fs.readFile(fp, 'utf8');
  return {
    markdown,
    runAbsolutePath: dir,
    chartsDir: path.join(dir, 'charts'),
  };
}

export function getQualityReportRunPath(
  projectDir: string,
  runId: string,
): string {
  return runDir(projectDir, runId);
}
