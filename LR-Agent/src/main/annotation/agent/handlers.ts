import { ipcMain } from 'electron';
import { listProjectImages } from './catalog';
import { resolveProjectRelativeFile } from './fs_tools';
import { listProjectTextFiles } from './textCatalog';

export default function registerAnnotationAgentHandlers(): void {
  ipcMain.handle(
    'annotationAgent:listImages',
    async (_event, projectDir: string, maxFiles?: number) => {
      return listProjectImages(projectDir, maxFiles ?? 400);
    },
  );

  ipcMain.handle(
    'annotationAgent:listTextFiles',
    async (_event, projectDir: string, maxFiles?: number) => {
      return listProjectTextFiles(projectDir, maxFiles ?? 400);
    },
  );

  ipcMain.handle(
    'annotationAgent:resolveRelativeFile',
    async (_event, projectDir: string, relativePath: string) => {
      return resolveProjectRelativeFile(projectDir, relativePath);
    },
  );
}
