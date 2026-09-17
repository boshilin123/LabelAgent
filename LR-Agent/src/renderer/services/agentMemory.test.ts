import { afterEach, describe, expect, it } from '@jest/globals';
import {
  getMemoryOpenTarget,
  isMemoryOpenTarget,
  memoryOpenErrorMessage,
  setMemoryOpenTarget,
} from './agentMemory';

const STORAGE_KEY = 'lr-agent.memoryOpenTarget';

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe('memory open target', () => {
  it('defaults to explorer', () => {
    expect(getMemoryOpenTarget()).toBe('explorer');
  });

  it('persists vscode and explorer', () => {
    setMemoryOpenTarget('vscode');
    expect(getMemoryOpenTarget()).toBe('vscode');
    setMemoryOpenTarget('explorer');
    expect(getMemoryOpenTarget()).toBe('explorer');
  });

  it('rejects unknown stored values', () => {
    expect(isMemoryOpenTarget('notepad')).toBe(false);
    window.localStorage.setItem(STORAGE_KEY, 'notepad');
    expect(getMemoryOpenTarget()).toBe('explorer');
  });
});

describe('memoryOpenErrorMessage', () => {
  it('maps wrapped Electron IPC errors', () => {
    expect(
      memoryOpenErrorMessage(
        new Error(
          "Error invoking remote method 'agent:memory:openFile': Error: vscode_not_found",
        ),
      ),
    ).toBe('未检测到 VS Code');
    expect(
      memoryOpenErrorMessage(
        new Error(
          "Error invoking remote method 'agent:memory:openFile': Error: vscode_open_failed",
        ),
      ),
    ).toBe('无法用 VS Code 打开');
    expect(memoryOpenErrorMessage(new Error('memory_file_not_found'))).toBe(
      '记忆文件不存在，请先让 Agent 写入或点刷新',
    );
  });
});
