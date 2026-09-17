import { ipcMain } from 'electron';
import {
  clearSessionCache,
  getSessionCache,
  setSessionCache,
  type LocalSessionCache,
} from './sessionCacheStore';
import { takePendingResetToken } from './resetDeepLink';
import {
  clearRefreshToken,
  getRefreshToken,
  setRefreshToken,
} from './tokenStore';

export default function registerAuthHandlers(): void {
  ipcMain.handle('auth:getRefreshToken', async () => getRefreshToken());
  ipcMain.handle('auth:setRefreshToken', async (_event, token: string) => {
    await setRefreshToken(token);
  });
  ipcMain.handle('auth:clearRefreshToken', async () => {
    await clearRefreshToken();
  });
  ipcMain.handle('auth:getSessionCache', async () => getSessionCache());
  ipcMain.handle(
    'auth:setSessionCache',
    async (_event, cache: LocalSessionCache) => {
      await setSessionCache(cache);
    },
  );
  ipcMain.handle('auth:clearSessionCache', async () => {
    await clearSessionCache();
  });
  ipcMain.handle('auth:getPendingResetToken', () => takePendingResetToken());
}
