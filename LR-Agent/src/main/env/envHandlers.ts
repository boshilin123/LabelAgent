/**
 * 环境模块 IPC 注册：状态检测、设置持久化、一键安装控制、首启引导标记。
 */
import { ipcMain, shell } from 'electron';
import type {
  EnvSettings,
  InstallTarget,
  PythonValidationResult,
} from '../../shared/envTypes';
import { getEnvironmentStatus } from './envStatus';
import { getEnvironmentConfig, updateEnvironmentConfig } from './envStore';
import {
  cancelInstall,
  getInstallProgress,
  startInstall,
} from './envInstaller';
import { validatePythonInterpreter } from './pythonDiscovery';

function registerEnvHandlers(): void {
  ipcMain.handle('env:getStatus', () => getEnvironmentStatus());

  ipcMain.handle('env:getSettings', () => getEnvironmentConfig());

  ipcMain.handle(
    'env:setSettings',
    async (_event, patch: Partial<EnvSettings>) => {
      const safePatch: Partial<EnvSettings> = {};
      if (typeof patch?.backendBaseUrl === 'string') {
        safePatch.backendBaseUrl = patch.backendBaseUrl;
      }
      if (typeof patch?.pipIndexUrl === 'string') {
        safePatch.pipIndexUrl = patch.pipIndexUrl;
      }
      if (typeof patch?.localAgentPythonOverride === 'string') {
        safePatch.localAgentPythonOverride = patch.localAgentPythonOverride;
      }
      if (typeof patch?.inferencePythonOverride === 'string') {
        safePatch.inferencePythonOverride = patch.inferencePythonOverride;
      }
      return updateEnvironmentConfig(safePatch);
    },
  );

  ipcMain.handle('env:install:start', async (_event, target: InstallTarget) => {
    if (target !== 'local-agent' && target !== 'inference') {
      return { ok: false, error: `未知安装目标: ${String(target)}` };
    }
    try {
      return await startInstall(target);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('env:install:cancel', () => cancelInstall());
  ipcMain.handle('env:install:getProgress', () => getInstallProgress());

  ipcMain.handle('env:completeFirstRun', () =>
    updateEnvironmentConfig({ firstRunCompleted: true }),
  );
  ipcMain.handle('env:dismissFirstRun', () =>
    updateEnvironmentConfig({ firstRunDismissedAt: new Date().toISOString() }),
  );
  ipcMain.handle('env:markFirstRunSeen', () =>
    updateEnvironmentConfig({ firstRunSeenAt: new Date().toISOString() }),
  );

  ipcMain.handle('env:showItemInFolder', async (_event, itemPath: string) => {
    if (typeof itemPath !== 'string' || !itemPath.trim()) return false;
    shell.showItemInFolder(itemPath.trim());
    return true;
  });

  ipcMain.handle(
    'env:validatePython',
    async (_event, pythonPath: string): Promise<PythonValidationResult> => {
      if (typeof pythonPath !== 'string') return { state: 'empty' };
      return validatePythonInterpreter(pythonPath);
    },
  );
}

export default registerEnvHandlers;
