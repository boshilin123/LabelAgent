import { ipcMain } from 'electron';
import {
  createQualityReportRun,
  createRunId,
  listQualityReports,
  readQualityReport,
  writeQualityChart,
  writeQualityFindings,
  writeQualityReportMarkdown,
  writeQualitySnapshot,
  getQualityReportRunPath,
} from './qualityReportStore';

export default function registerQualityReportHandlers(): void {
  ipcMain.handle('quality:createRun', async (_event, projectDir: string) => {
    const runId = createRunId();
    return createQualityReportRun(projectDir, runId);
  });

  ipcMain.handle(
    'quality:writeChart',
    async (
      _event,
      projectDir: string,
      runId: string,
      fileName: string,
      base64Png: string,
    ) => {
      return writeQualityChart(projectDir, runId, fileName, base64Png);
    },
  );

  ipcMain.handle(
    'quality:writeSnapshot',
    async (_event, projectDir: string, runId: string, payload: unknown) => {
      await writeQualitySnapshot(projectDir, runId, payload);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'quality:writeFindings',
    async (_event, projectDir: string, runId: string, payload: unknown) => {
      await writeQualityFindings(projectDir, runId, payload);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'quality:writeReport',
    async (
      _event,
      projectDir: string,
      runId: string,
      markdown: string,
      indexEntry: unknown,
    ) => {
      return writeQualityReportMarkdown(
        projectDir,
        runId,
        markdown,
        indexEntry as Parameters<typeof writeQualityReportMarkdown>[3],
      );
    },
  );

  ipcMain.handle('quality:listReports', async (_event, projectDir: string) => {
    return listQualityReports(projectDir);
  });

  ipcMain.handle(
    'quality:readReport',
    async (_event, projectDir: string, runId: string) => {
      return readQualityReport(projectDir, runId);
    },
  );

  ipcMain.handle(
    'quality:getRunPath',
    async (_event, projectDir: string, runId: string) => {
      return getQualityReportRunPath(projectDir, runId);
    },
  );
}
