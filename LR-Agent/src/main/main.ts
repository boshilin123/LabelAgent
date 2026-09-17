import path from 'path';
import { open } from 'fs/promises';
import fs from 'fs-extra';
import chokidar from 'chokidar';
import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  dialog,
  Menu,
  nativeTheme,
  nativeImage,
  NativeImage,
  session,
  type WebContents,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import MenuBuilder from './menu';
import { isAppOwnedNavigation, resolveHtmlPath } from './util';
import { DirectoryItem, FileStats } from './preload';
import registerAuthHandlers from './auth/authHandlers';
import { parseResetDeepLink, setPendingResetToken } from './auth/resetDeepLink';
import registerPretrainedModelHandlers from './pretrainedModels/pretrainedModelHandlers';
import registerPreAnnotHandlers from './preAnnot/preAnnotHandlers';
import { registerWorkspaceHandlers } from './workspace/workspaceHandlers';
import { setActiveWorkspaceRoot } from './workspace/activeWorkspace';
import { registerTerminalHandlers } from './terminal/terminalHandlers';
import registerAnnotationAgentHandlers from './annotation/agent/handlers';
import registerQualityReportHandlers from './annotation/quality/handlers';
import {
  startMcpServer,
  stopMcpServer,
  getMcpServerUrl,
  getMcpServerToken,
} from './mcp/server';
import {
  startLocalAgentServer,
  stopLocalAgentServer,
  getLocalAgentBaseUrl,
  getLocalAgentToken,
} from './localAgent/serverProcess';
import { initializeDatabase, closeDatabase } from './db/database';
import { migrateSecrets } from './security/migrateSecrets';
import { registerDbHandlers } from './db/handlers';
import { registerMemoryHandlers } from './memory/handlers';
import { registerCheckpointHandlers } from './checkpoint/handlers';
import { registerSkillHandlers } from './skills/handlers';
import { registerMcpHandlers } from './mcp/handlers';
import registerEnvHandlers from './env/envHandlers';
import { getEnvironmentConfig } from './env/envStore';
import { buildMainCsp, EXTRA_SECURITY_HEADERS } from './security/csp';
import {
  authorizeRoot,
  isWithinAuthorizedRoot,
} from './security/authorizedRoots';
import { isSafeExternalUrl } from './security/externalUrl';
import { isDangerousExecutable } from '../shared/dangerousExtensions';
import {
  getAnnotationProjects,
  removeProjectDirConfig,
  saveAnnotationProjects,
  writeProjectDirConfig,
} from './annotation/annotationStore';
import {
  readAnnotationDocJson,
  writeAnnotationDocJson,
} from './annotation/annotationDataStore';
import { runAnnotationExport } from './annotation/annotationExportEngine';
import type { AnnotationExportRequest } from '../shared/annotationExportTypes';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;
let themeIpcRegistered = false;

// ── 深链（lr-agent://reset-password）处理 ──

// 只在打包/生产环境启用单实例锁：开发环境 electronmon 会反复重启 Electron，
// 与 requestSingleInstanceLock“抢锁失败即退出”的语义冲突，会导致 dev 窗口反复退出。
const gotSingleInstanceLock = app.isPackaged
  ? app.requestSingleInstanceLock()
  : true;

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function handleResetDeepLink(url: string): void {
  const token = parseResetDeepLink(url);
  if (!token) return;
  setPendingResetToken(token);
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isLoading()
  ) {
    mainWindow.webContents.send('auth:resetPasswordDeepLink', token);
  }
  focusMainWindow();
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv: string[]) => {
    const deepLink = argv.find((arg) => arg.startsWith('lr-agent://'));
    if (deepLink) {
      handleResetDeepLink(deepLink);
    } else {
      focusMainWindow();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleResetDeepLink(url);
  });
}

/** Fits both sidebars expanded + main content minimum (48+240+4+480+4+240+48). */
const WINDOW_MIN_WIDTH = 1064;
const WINDOW_MIN_HEIGHT = 640;

function themeWindowBackground(isDark: boolean): string {
  return isDark ? '#1e1e1e' : '#ffffff';
}

function syncWindowBackground(window: BrowserWindow, isDark: boolean): void {
  window.setBackgroundColor(themeWindowBackground(isDark));
}

function getThemeIconPath(isDark: boolean): string {
  return isDark ? 'icon-dark.png' : 'icon-light.png';
}

/**
 * Windows 任务栏图标位是正方形。直接塞非正方形 PNG 时，Electron/Win32
 * 转 HICON 会按左上对齐裁进方槽，看起来就像图标偏左。
 * 源文件不改，只在设窗口图标时居中铺到方画布。
 */
function loadWindowIcon(filePath: string): NativeImage {
  const src = nativeImage.createFromPath(filePath);
  if (src.isEmpty()) {
    return src;
  }

  const { width, height } = src.getSize();
  const longSide = Math.max(width, height);
  const target = 256;
  const scale = target / longSide;
  const fitted =
    longSide === target
      ? src
      : src.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'best',
        });

  const { width: fw, height: fh } = fitted.getSize();
  if (fw === fh) {
    return fitted;
  }

  const srcBuf = fitted.toBitmap();
  const out = Buffer.alloc(target * target * 4, 0);
  const ox = Math.floor((target - fw) / 2);
  const oy = Math.floor((target - fh) / 2);
  const rowBytes = fw * 4;
  for (let y = 0; y < fh; y += 1) {
    srcBuf.copy(
      out,
      ((y + oy) * target + ox) * 4,
      y * rowBytes,
      y * rowBytes + rowBytes,
    );
  }
  return nativeImage.createFromBitmap(out, { width: target, height: target });
}

function syncWindowIcon(
  window: BrowserWindow,
  isDark: boolean,
  getAssetPath: (...paths: string[]) => string,
): void {
  window.setIcon(loadWindowIcon(getAssetPath(getThemeIconPath(isDark))));
}

function syncWindowTheme(
  window: BrowserWindow,
  isDark: boolean,
  getAssetPath: (...paths: string[]) => string,
): void {
  syncWindowBackground(window, isDark);
  syncWindowIcon(window, isDark, getAssetPath);
}

function registerThemeIpcHandlers(
  getAssetPath: (...paths: string[]) => string,
): void {
  if (themeIpcRegistered) return;
  themeIpcRegistered = true;

  ipcMain.handle('theme:getSystemDark', () => nativeTheme.shouldUseDarkColors);

  ipcMain.on('theme:notifyEffectiveTheme', (event, theme: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    syncWindowTheme(window, theme === 'dark', getAssetPath);
  });

  nativeTheme.on('updated', () => {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send(
        'theme:systemChanged',
        nativeTheme.shouldUseDarkColors,
      );
    });
  });
}

const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.erb',
  'dist',
  'release',
  '.cache',
]);

// ── 文件系统监听器（chokidar） ──

type WorkspaceWatcher = ReturnType<typeof chokidar.watch>;

let workspaceWatcher: WorkspaceWatcher | null = null;

function stopWatchingWorkspace(): void {
  if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = null;
  }
}

function startWatchingWorkspace(rootPath: string): void {
  stopWatchingWorkspace();

  workspaceWatcher = chokidar.watch(rootPath, {
    ignored: [
      /(^|[\/\\])\./, // 隐藏文件/目录
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/release/**',
      '**/.cache/**',
      '**/__pycache__/**',
      '**/*.pyc',
    ],
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  const notify = (filePath: string) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('file-system:changed', filePath);
    });
  };

  workspaceWatcher.on('add', notify);
  workspaceWatcher.on('change', notify);
  workspaceWatcher.on('unlink', notify);
  workspaceWatcher.on('addDir', notify);
  workspaceWatcher.on('unlinkDir', notify);
}

// ── IPC: 工作区文件监听控制 ──

ipcMain.handle('workspace:startWatch', async (_event, rootPath: unknown) => {
  if (typeof rootPath !== 'string' || !rootPath.trim()) return;
  authorizeRoot(rootPath);
  setActiveWorkspaceRoot(rootPath);
  startWatchingWorkspace(rootPath);
});

function normalizePath(filePath: string): string {
  return path.normalize(filePath);
}

function isIgnoredEntry(name: string, isDirectory: boolean): boolean {
  if (!isDirectory) return false;
  return DEFAULT_IGNORE_DIRS.has(name);
}

/** 应用自身凭据/配置文件：禁止渲染层通过通用 fs 接口读取 */
const BLOCKED_SECRET_BASENAMES = new Set([
  'lr-agent.db',
  'mcp.json',
  'session_cache.dat',
  'refresh_token.dat',
  'environment.json',
]);

function isBlockedSecretRead(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !filePath.trim()) return true;
  let resolved: string;
  try {
    resolved = path.resolve(filePath);
  } catch {
    return true;
  }
  const userData = path.resolve(app.getPath('userData'));
  if (path.resolve(path.dirname(resolved)) !== userData) return false;
  return BLOCKED_SECRET_BASENAMES.has(path.basename(resolved).toLowerCase());
}

/** 新建/重命名时的条目名必须是单一文件名，禁止路径分隔符与 .. 穿越 */
function isSafeEntryName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (trimmed.includes('\0')) return false;
  return true;
}

ipcMain.handle('fs:readFileBuffer', async (_event, filePath: unknown) => {
  if (isBlockedSecretRead(filePath)) return null;
  try {
    const buffer = await fs.readFile(filePath as string);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
  } catch (error) {
    console.error('Error reading file buffer:', error);
    return null;
  }
});

ipcMain.handle('shell:openPath', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return 'invalid_path';
  }
  if (isDangerousExecutable(filePath)) {
    return 'blocked_extension';
  }
  return shell.openPath(filePath);
});

ipcMain.handle(
  'dialog:confirm',
  async (_event, options: { title?: string; message: string }) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { confirmed: false };
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: options.title || '确认',
      message: options.message,
      buttons: ['确定', '取消'],
      defaultId: 0,
      cancelId: 1,
    });
    return { confirmed: result.response === 0 };
  },
);

// ── IPC: 文件操作（创建、删除、重命名） ──

ipcMain.handle(
  'workspace:createFile',
  async (_event, dirPath: string, fileName: string) => {
    try {
      if (!isWithinAuthorizedRoot(dirPath) || !isSafeEntryName(fileName)) {
        return { success: false, error: 'forbidden' };
      }
      const filePath = path.join(dirPath, fileName);
      // 检查同名文件是否已存在
      if (await fs.pathExists(filePath)) {
        return { success: false, error: 'file_exists' };
      }
      await fs.writeFile(filePath, '');
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('file-system:changed', dirPath);
      });
      return { success: true, filePath };
    } catch (error) {
      console.error('Error creating file:', error);
      return { success: false, error: String(error) };
    }
  },
);

ipcMain.handle(
  'workspace:createFolder',
  async (_event, dirPath: string, folderName: string) => {
    try {
      if (!isWithinAuthorizedRoot(dirPath) || !isSafeEntryName(folderName)) {
        return { success: false, error: 'forbidden' };
      }
      const folderPath = path.join(dirPath, folderName);
      if (await fs.pathExists(folderPath)) {
        return { success: false, error: 'folder_exists' };
      }
      await fs.ensureDir(folderPath);
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('file-system:changed', dirPath);
      });
      return { success: true, folderPath };
    } catch (error) {
      console.error('Error creating folder:', error);
      return { success: false, error: String(error) };
    }
  },
);

ipcMain.handle('workspace:deleteEntry', async (_event, entryPath: string) => {
  if (!isWithinAuthorizedRoot(entryPath)) {
    return { success: false, error: 'forbidden' };
  }
  try {
    await shell.trashItem(entryPath);
    const parentDir = path.dirname(entryPath);
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('file-system:changed', parentDir);
    });
    return { success: true };
  } catch (error) {
    console.error('Error deleting entry:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle(
  'workspace:renameEntry',
  async (_event, oldPath: string, newName: string) => {
    if (!isWithinAuthorizedRoot(oldPath) || !isSafeEntryName(newName)) {
      return { success: false, error: 'forbidden' };
    }
    try {
      const dir = path.dirname(oldPath);
      const newPath = path.join(dir, newName);
      if (await fs.pathExists(newPath)) {
        return { success: false, error: 'target_exists' };
      }
      await fs.move(oldPath, newPath);
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('file-system:changed', dir);
      });
      return { success: true, oldPath, newPath };
    } catch (error) {
      console.error('Error renaming entry:', error);
      return { success: false, error: String(error) };
    }
  },
);

ipcMain.handle(
  'workspace:moveEntry',
  async (_event, srcPath: string, destDir: string) => {
    if (!isWithinAuthorizedRoot(srcPath) || !isWithinAuthorizedRoot(destDir)) {
      return { success: false, error: 'forbidden' };
    }
    try {
      const name = path.basename(srcPath);
      const destPath = path.join(destDir, name);
      if (await fs.pathExists(destPath)) {
        return { success: false, error: 'target_exists' };
      }
      await fs.move(srcPath, destPath);
      const srcDir = path.dirname(srcPath);
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('file-system:changed', srcDir);
        win.webContents.send('file-system:changed', destDir);
      });
      return { success: true, oldPath: srcPath, newPath: destPath };
    } catch (error) {
      console.error('Error moving entry:', error);
      return { success: false, error: String(error) };
    }
  },
);

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  const picked = result.filePaths[0] || null;
  authorizeRoot(picked);
  return picked;
});

ipcMain.handle('annotation:getProjects', async () => {
  return getAnnotationProjects();
});

ipcMain.handle(
  'annotation:saveProjects',
  async (_event, projects: unknown[]) => {
    await saveAnnotationProjects(projects);
  },
);

ipcMain.handle(
  'annotation:writeProjectConfig',
  async (_event, directoryPath: string, project: unknown) => {
    authorizeRoot(directoryPath);
    await writeProjectDirConfig(directoryPath, project);
  },
);

ipcMain.handle(
  'annotation:removeProjectConfig',
  async (_event, directoryPath: string) => {
    await removeProjectDirConfig(directoryPath);
  },
);

ipcMain.handle(
  'annotation:showItemInFolder',
  async (_event, itemPath: unknown) => {
    if (typeof itemPath !== 'string' || !itemPath.trim()) return;
    shell.showItemInFolder(itemPath);
  },
);

ipcMain.handle(
  'annotation:readFileAnnotationDoc',
  async (_event, projectDir: string, relativePath: string) => {
    authorizeRoot(projectDir);
    try {
      return await readAnnotationDocJson(projectDir, relativePath);
    } catch {
      return null;
    }
  },
);

ipcMain.handle(
  'annotation:writeFileAnnotationDoc',
  async (
    _event,
    projectDir: string,
    relativePath: string,
    doc: unknown,
    sourceHint?: { mtimeMs?: number; size?: number },
  ) => {
    authorizeRoot(projectDir);
    await writeAnnotationDocJson(projectDir, relativePath, doc, sourceHint);
  },
);

ipcMain.handle(
  'annotation:exportAnnotations',
  async (_event, request: AnnotationExportRequest) => {
    return runAnnotationExport(request);
  },
);

ipcMain.handle(
  'fs:readDir',
  async (_event, dirPath: unknown): Promise<DirectoryItem[]> => {
    if (typeof dirPath !== 'string' || !dirPath.trim()) return [];
    try {
      const entries = await fs.readdir(dirPath as string, {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => !isIgnoredEntry(entry.name, entry.isDirectory()))
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          path: normalizePath(path.join(dirPath as string, entry.name)),
        }));
    } catch (error) {
      console.error('Error reading directory:', error);
      return [];
    }
  },
);

ipcMain.handle(
  'fs:readFile',
  async (_event, filePath: unknown): Promise<string | null> => {
    if (isBlockedSecretRead(filePath)) return null;
    const filePathStr = filePath as string;
    try {
      const stats = await fs.stat(filePathStr);
      const maxPreviewBytes = 512 * 1024;
      if (stats.size > 5 * 1024 * 1024) {
        const handle = await open(filePathStr, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(maxPreviewBytes, stats.size));
          await handle.read(buffer, 0, buffer.length, 0);
          const content = buffer.toString('utf-8');
          const lines = content.split('\n').slice(0, 2000);
          return `${lines.join('\n')}\n\n... [文件过大，仅显示部分内容]`;
        } finally {
          await handle.close();
        }
      }
      return await fs.readFile(filePathStr, 'utf-8');
    } catch (error) {
      console.error('Error reading file:', error);
      return null;
    }
  },
);

ipcMain.handle(
  'fs:getFileStats',
  async (_event, filePath: unknown): Promise<FileStats | null> => {
    if (isBlockedSecretRead(filePath)) return null;
    try {
      const stats = await fs.stat(filePath as string);
      return {
        size: stats.size,
        mtime: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      console.error('Error getting file stats:', error);
      return null;
    }
  },
);

let windowIpcRegistered = false;

function registerWindowIpcHandlers(): void {
  if (windowIpcRegistered) {
    return;
  }
  windowIpcRegistered = true;

  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('window:maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isFullScreen()) {
      window.setFullScreen(false);
      return;
    }
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.on('window:reload', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.reload();
  });

  ipcMain.on('window:toggleDevTools', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools();
  });

  ipcMain.on('window:toggleFullScreen', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    window.setFullScreen(!window.isFullScreen());
  });

  ipcMain.handle('window:isMaximized', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window?.isMaximized() ?? false;
  });

  ipcMain.handle('window:isFullScreen', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window?.isFullScreen() ?? false;
  });

  ipcMain.handle('window:openExternal', async (_event, url: unknown) => {
    if (!isSafeExternalUrl(url)) return;
    await shell.openExternal(url as string);
  });
}

/** 统一挂载导航/开窗守卫：仅放行应用自身路由与 https/本机 http 外链 */
function attachNavigationGuards(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isAppOwnedNavigation(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(() => undefined);
    }
  });
}

function attachWindowStateEvents(window: BrowserWindow): void {
  const notifyMaximizeChange = (isMaximized: boolean) => {
    window.webContents.send('window:maximize-change', isMaximized);
  };
  const notifyFullScreenChange = (isFullScreen: boolean) => {
    window.webContents.send('window:fullscreen-change', isFullScreen);
  };

  window.on('maximize', () => notifyMaximizeChange(true));
  window.on('unmaximize', () => notifyMaximizeChange(false));
  window.on('enter-full-screen', () => notifyFullScreenChange(true));
  window.on('leave-full-screen', () => notifyFullScreenChange(false));
}

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDebug && !process.env.SKIP_DEVTOOLS) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  const isMac = process.platform === 'darwin';

  registerWindowIpcHandlers();
  registerThemeIpcHandlers(getAssetPath);

  const initialDark = nativeTheme.shouldUseDarkColors;

  mainWindow = new BrowserWindow({
    show: false,
    title: 'LR-Agent',
    width: 1400,
    height: 900,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    backgroundColor: themeWindowBackground(initialDark),
    icon: loadWindowIcon(getAssetPath(getThemeIconPath(initialDark))),
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 12, y: 8 },
        }
      : { frame: false }),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  attachWindowStateEvents(mainWindow);

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  Menu.setApplicationMenu(null);

  if (isDebug) {
    const menuBuilder = new MenuBuilder(mainWindow);
    menuBuilder.setupDevelopmentEnvironment();
  }

  new AppUpdater();
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC: renderer 查询 MCP Server URL + token
ipcMain.handle('mcp:getServerUrl', () => {
  const url = getMcpServerUrl();
  const token = getMcpServerToken();
  if (!url || !token) return null;
  return { url, token };
});

// IPC: renderer 查询本地 Agent 服务 base URL + token
ipcMain.handle('localAgent:getBaseUrl', () => {
  const url = getLocalAgentBaseUrl();
  const token = getLocalAgentToken();
  if (!url || !token) return null;
  return { url, token };
});

/** 为 http(s) 响应补充 CSP 与通用加固头；file:// 由 index.ejs 的 meta 兜底 */
function registerSecurityHeaders(): void {
  // 外设权限一律拒绝，仅保留剪贴板写入（复制路径/消息需要）
  const allowedPermissions = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(allowedPermissions.has(permission));
    },
  );
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    allowedPermissions.has(permission),
  );

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = buildMainCsp({
      isDevelopment: isDebug,
      origins: [
        getEnvironmentConfig().backendBaseUrl,
        getLocalAgentBaseUrl(),
        getMcpServerUrl(),
      ],
    });
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        ...EXTRA_SECURITY_HEADERS,
      },
    });
  });
}

app
  .whenReady()
  .then(async () => {
    if (!gotSingleInstanceLock) return;
    app.setAsDefaultProtocolClient('lr-agent');
    registerSecurityHeaders();
    // 覆盖未来新增的所有 webContents，统一做导航/开窗白名单
    app.on('web-contents-created', (_event, contents) => {
      attachNavigationGuards(contents);
    });

    // 处理首次通过 lr-agent:// 链接启动（Windows/Linux 走 argv，macOS 走 open-url）
    const launchDeepLink = process.argv.find((arg) =>
      arg.startsWith('lr-agent://'),
    );
    if (launchDeepLink) {
      handleResetDeepLink(launchDeepLink);
    }

    // Initialize local SQLite database
    await initializeDatabase();
    // 幂等迁移历史明文凭据（provider key / MCP header）
    await migrateSecrets();

    registerAuthHandlers();
    registerPretrainedModelHandlers();
    registerPreAnnotHandlers();
    registerWorkspaceHandlers();
    registerAnnotationAgentHandlers();
    registerQualityReportHandlers();
    registerDbHandlers();
    registerMemoryHandlers();
    registerCheckpointHandlers();
    registerSkillHandlers();
    registerTerminalHandlers();
    registerMcpHandlers();
    registerEnvHandlers();
    // 启动本地 MCP Server（异步，失败不阻断窗口创建）
    startMcpServer().catch((err) =>
      console.error('[MCP] Failed to start MCP server:', err),
    );
    // 启动本地 Agent 编排服务（异步，失败不阻断窗口创建）
    startLocalAgentServer().catch((err) =>
      console.error('[localAgent] Failed to start local agent server:', err),
    );
    createWindow();
    app.on('activate', () => {
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);

app.on('before-quit', () => {
  stopWatchingWorkspace();
  stopMcpServer();
  stopLocalAgentServer();
  closeDatabase();
});
