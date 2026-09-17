import { ipcMain, shell } from 'electron';
import { readProjectInstructions } from './instructionsReader';
import {
  ensureMemoryDir,
  listMemoryEntries,
  readMemoryIndex,
  resolveOpenableMemoryFile,
  setWorkspaceMemoryActive,
  syncWorkspaceFactTopics,
} from './memoryStore';
import {
  isMemoryOpenTarget,
  openMemoryFileWithTarget,
} from './openMemoryTarget';

export function registerMemoryHandlers(): void {
  ipcMain.handle(
    'agent:memory:readInstructions',
    (_event, directoryPath: string) => {
      return readProjectInstructions(directoryPath);
    },
  );

  // 读取索引时同步激活工作区记忆（MCP memory 工具使用同一作用域）
  ipcMain.handle('agent:memory:readIndex', (_event, scopeKey: string) => {
    setWorkspaceMemoryActive(true, scopeKey);
    return readMemoryIndex(scopeKey);
  });

  ipcMain.handle(
    'agent:memory:setActive',
    (_event, enabled: boolean, scopeKey?: string) => {
      setWorkspaceMemoryActive(Boolean(enabled), scopeKey);
    },
  );

  ipcMain.handle('agent:memory:listEntries', (_event, scopeKey: string) => {
    return listMemoryEntries(scopeKey);
  });

  ipcMain.handle(
    'agent:memory:syncFacts',
    (
      _event,
      options: {
        scopeKey: string;
        projectDir: string;
      },
    ) => {
      return syncWorkspaceFactTopics(options);
    },
  );

  ipcMain.handle('agent:memory:openDir', async (_event, scopeKey: string) => {
    const dir = await ensureMemoryDir(scopeKey);
    return shell.openPath(dir);
  });

  ipcMain.handle(
    'agent:memory:openFile',
    async (_event, scopeKey: string, relativePath: string, target?: string) => {
      const filePath = await resolveOpenableMemoryFile(scopeKey, relativePath);
      await openMemoryFileWithTarget(
        filePath,
        isMemoryOpenTarget(target) ? target : 'explorer',
      );
      return '';
    },
  );
}
