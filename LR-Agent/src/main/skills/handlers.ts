import { ipcMain, shell } from 'electron';
import {
  clearSkillsCache,
  ensureUserSkillsRoot,
  resolveSkillDirPath,
  scanSkillsCatalog,
  scanSkillsInventory,
} from './skillScanner';
import { getHiddenSkills, setSkillHidden } from './skillsStore';

export function registerSkillHandlers(): void {
  ipcMain.handle('agent:skills:listCatalog', () => {
    return scanSkillsCatalog(undefined, getHiddenSkills());
  });

  ipcMain.handle('agent:skills:listInventory', (_event, force?: unknown) => {
    if (force === true) clearSkillsCache();
    return scanSkillsInventory(undefined, getHiddenSkills());
  });

  ipcMain.handle(
    'agent:skills:setHidden',
    async (_event, dirName: unknown, hidden: unknown) => {
      if (typeof dirName !== 'string' || !dirName.trim()) {
        return null;
      }
      // 停用清单变化必须失效扫描缓存（缓存只按 rootDir 键控）
      clearSkillsCache();
      await setSkillHidden(dirName.trim(), hidden === true);
      return scanSkillsInventory(undefined, getHiddenSkills());
    },
  );

  ipcMain.handle('agent:skills:openRoot', async () => {
    const root = await ensureUserSkillsRoot();
    return shell.openPath(root);
  });

  ipcMain.handle('agent:skills:reveal', async (_event, dirName: unknown) => {
    if (typeof dirName !== 'string' || !dirName.trim()) {
      return '';
    }
    const skillDir = await resolveSkillDirPath(dirName);
    if (!skillDir) return '';
    return shell.openPath(skillDir);
  });
}
