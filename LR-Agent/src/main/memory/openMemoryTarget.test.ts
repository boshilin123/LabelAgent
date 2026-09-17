import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';

import {
  isMemoryOpenTarget,
  listVsCodeExecutableCandidates,
  resolveWindowsCodeLaunchPath,
  toVsCodeFileUri,
} from './openMemoryTarget';

jest.mock('electron', () => ({
  shell: {
    showItemInFolder: jest.fn(),
    openExternal: jest.fn(),
  },
}));

describe('isMemoryOpenTarget', () => {
  it('accepts explorer and vscode', () => {
    expect(isMemoryOpenTarget('explorer')).toBe(true);
    expect(isMemoryOpenTarget('vscode')).toBe(true);
    expect(isMemoryOpenTarget('notepad')).toBe(false);
    expect(isMemoryOpenTarget(undefined)).toBe(false);
  });
});

describe('listVsCodeExecutableCandidates', () => {
  it('includes common Windows install paths', () => {
    const localApp = 'C:\\Users\\me\\AppData\\Local';
    const paths = listVsCodeExecutableCandidates(
      'win32',
      {
        LOCALAPPDATA: localApp,
        PROGRAMFILES: 'C:\\Program Files',
        'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      },
      'C:\\Users\\me',
    );
    expect(paths).toContain(
      path.join(localApp, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    );
    expect(paths).toContain(
      path.join('C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    );
    expect(paths).toContain(
      path.join(
        localApp,
        'Programs',
        'Microsoft VS Code Insiders',
        'Code - Insiders.exe',
      ),
    );
  });

  it('includes macOS app bundle CLI', () => {
    const paths = listVsCodeExecutableCandidates('darwin', {}, '/Users/me');
    expect(paths).toContain(
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    );
  });
});

describe('toVsCodeFileUri', () => {
  it('converts Windows paths to vscode://file URIs', () => {
    expect(toVsCodeFileUri('C:\\Users\\me\\MEMORY.md')).toBe(
      'vscode://file/C:/Users/me/MEMORY.md',
    );
  });
});

describe('resolveWindowsCodeLaunchPath', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('prefers adjacent code.cmd when where returns extensionless bin/code', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-launch-'));
    const bin = path.join(tempDir, 'bin');
    fs.mkdirSync(bin);
    const shim = path.join(bin, 'code');
    const cmd = path.join(bin, 'code.cmd');
    fs.writeFileSync(cmd, '');
    await expect(resolveWindowsCodeLaunchPath(shim)).resolves.toBe(cmd);
  });

  it('returns existing .exe paths unchanged', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-launch-'));
    const exe = path.join(tempDir, 'Code.exe');
    fs.writeFileSync(exe, '');
    await expect(resolveWindowsCodeLaunchPath(exe)).resolves.toBe(exe);
  });
});
