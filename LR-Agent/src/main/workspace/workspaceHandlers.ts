import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import {
  readScopedTextFile,
  writeScopedTextFile,
  deleteScopedTextFile,
  moveScopedTextFile,
} from './workspaceWrite';
import { isWithinAuthorizedRoot } from '../security/authorizedRoots';

const FORBIDDEN = { success: false, error: 'forbidden_root' } as const;

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(
    'workspace:writeTextFile',
    async (
      _event,
      payload: { rootDir: string; relativePath: string; content: string },
    ) => {
      if (!isWithinAuthorizedRoot(payload?.rootDir)) return FORBIDDEN;
      const result = await writeScopedTextFile(
        payload.rootDir,
        payload.relativePath,
        payload.content,
      );
      if (result.success && result.filePath) {
        const parentDir = path.dirname(result.filePath);
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('file-system:changed', parentDir);
        });
      }
      return result;
    },
  );

  ipcMain.handle(
    'workspace:readTextFile',
    async (_event, payload: { rootDir: string; relativePath: string }) => {
      if (!isWithinAuthorizedRoot(payload?.rootDir)) return FORBIDDEN;
      return readScopedTextFile(payload.rootDir, payload.relativePath);
    },
  );

  ipcMain.handle(
    'workspace:deleteTextFile',
    async (_event, payload: { rootDir: string; relativePath: string }) => {
      if (!isWithinAuthorizedRoot(payload?.rootDir)) return FORBIDDEN;
      const result = await deleteScopedTextFile(
        payload.rootDir,
        payload.relativePath,
      );
      if (result.success) {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send(
            'file-system:changed',
            path.join(payload.rootDir, path.dirname(payload.relativePath)),
          );
        });
      }
      return result;
    },
  );

  ipcMain.handle(
    'workspace:moveTextFile',
    async (
      _event,
      payload: {
        rootDir: string;
        relativePath: string;
        newRelativePath: string;
      },
    ) => {
      if (!isWithinAuthorizedRoot(payload?.rootDir)) return FORBIDDEN;
      const result = await moveScopedTextFile(
        payload.rootDir,
        payload.relativePath,
        payload.newRelativePath,
      );
      if (result.success) {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send(
            'file-system:changed',
            path.join(payload.rootDir, path.dirname(payload.relativePath)),
          );
          win.webContents.send(
            'file-system:changed',
            path.join(payload.rootDir, path.dirname(payload.newRelativePath)),
          );
        });
      }
      return result;
    },
  );
}
