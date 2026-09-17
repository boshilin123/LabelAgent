/**
 * 在资源管理器中显示记忆文件，或用本机 VS Code 打开。
 * 不强制安装 VS Code；找不到可执行文件且协议打不开时抛 vscode_not_found。
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { shell } from 'electron';

const execFileAsync = promisify(execFile);

export type MemoryOpenTarget = 'explorer' | 'vscode';

export function isMemoryOpenTarget(value: unknown): value is MemoryOpenTarget {
  return value === 'explorer' || value === 'vscode';
}

export function listVsCodeExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string[] {
  if (platform === 'win32') {
    const localApp = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    const programFiles = env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 =
      env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(localApp, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(localApp, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(
        localApp,
        'Programs',
        'Microsoft VS Code Insiders',
        'Code - Insiders.exe',
      ),
      path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
      path.join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(
        programFiles,
        'Microsoft VS Code Insiders',
        'Code - Insiders.exe',
      ),
      path.join(programFilesX86, 'Microsoft VS Code', 'Code.exe'),
      path.join(programFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
      '/usr/local/bin/code',
    ];
  }
  return ['/usr/bin/code', '/usr/local/bin/code'];
}

export function toVsCodeFileUri(filePath: string): string {
  return `vscode://file/${encodeURI(filePath.replace(/\\/g, '/'))}`;
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate && (await fs.pathExists(candidate))) {
      return candidate;
    }
  }
  return null;
}

/** Windows 上 `where code` 常返回无扩展名的 bin/code，需改成 .cmd 或旁路 Code.exe */
export async function resolveWindowsCodeLaunchPath(
  found: string,
): Promise<string> {
  if (/\.(exe|cmd|bat)$/i.test(found) && (await fs.pathExists(found))) {
    return found;
  }
  const withCmd = `${found}.cmd`;
  if (await fs.pathExists(withCmd)) {
    return withCmd;
  }
  const withExe = `${found}.exe`;
  if (await fs.pathExists(withExe)) {
    return withExe;
  }
  const siblingExe = path.normalize(
    path.join(path.dirname(found), '..', 'Code.exe'),
  );
  if (await fs.pathExists(siblingExe)) {
    return siblingExe;
  }
  return found;
}

async function resolveVsCodeFromRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const keys = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code - Insiders.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code - Insiders.exe',
  ];
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/ve'], {
        windowsHide: true,
        timeout: 3000,
      });
      const match = stdout.match(/REG_SZ\s+(.+\.exe)/i);
      const found = match?.[1]?.trim().replace(/^"|"$/g, '');
      if (found && (await fs.pathExists(found))) {
        return found;
      }
    } catch {
      // 下一枚注册表项
    }
  }
  return null;
}

async function resolveVsCodeFromEnvPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const dirs = `${env.Path || env.PATH || ''}`
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  const names =
    platform === 'win32' ? ['Code.exe', 'code.cmd', 'code'] : ['code'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await fs.pathExists(candidate)) {
        return platform === 'win32'
          ? resolveWindowsCodeLaunchPath(candidate)
          : candidate;
      }
    }
  }
  return null;
}

async function resolveVsCodeFromWhich(
  platform: NodeJS.Platform,
): Promise<string | null> {
  const cmd = platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, ['code'], {
      windowsHide: true,
      timeout: 3000,
    });
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!first) return null;
    return platform === 'win32' ? resolveWindowsCodeLaunchPath(first) : first;
  } catch {
    return null;
  }
}

export async function findVsCodeExecutable(): Promise<string | null> {
  const fromCandidates = await firstExisting(listVsCodeExecutableCandidates());
  if (fromCandidates) return fromCandidates;

  const fromRegistry = await resolveVsCodeFromRegistry();
  if (fromRegistry) return fromRegistry;

  const fromEnvPath = await resolveVsCodeFromEnvPath(
    process.platform,
    process.env,
  );
  if (fromEnvPath) return fromEnvPath;

  return resolveVsCodeFromWhich(process.platform);
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const useShell =
      process.platform === 'win32' &&
      (!path.extname(command) || /\.(cmd|bat)$/i.test(command));
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: useShell,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function openWithVsCodeProtocol(filePath: string): Promise<boolean> {
  try {
    await shell.openExternal(toVsCodeFileUri(filePath));
    return true;
  } catch {
    return false;
  }
}

export async function openMemoryFileWithTarget(
  filePath: string,
  target: MemoryOpenTarget,
): Promise<void> {
  if (target === 'explorer') {
    shell.showItemInFolder(filePath);
    return;
  }

  const executable = await findVsCodeExecutable();
  if (executable) {
    try {
      await spawnDetached(executable, [filePath]);
      return;
    } catch {
      if (await openWithVsCodeProtocol(filePath)) {
        return;
      }
      throw new Error('vscode_open_failed');
    }
  }

  if (await openWithVsCodeProtocol(filePath)) {
    return;
  }
  throw new Error('vscode_not_found');
}
