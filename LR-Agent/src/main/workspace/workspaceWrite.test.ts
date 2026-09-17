import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  deleteScopedTextFile,
  readScopedTextFile,
  writeScopedTextFile,
} from './workspaceWrite';

let tmpRoot = '';

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-agent-wswrite-'));
});

afterAll(async () => {
  if (tmpRoot) {
    await fs.remove(tmpRoot);
  }
});

describe('workspaceWrite 写盘策略', () => {
  it('白名单内的文本文件可写、可读、可删', async () => {
    const root = path.join(tmpRoot, 'ok');
    await fs.ensureDir(root);

    const writeResult = await writeScopedTextFile(root, 'notes/todo.txt', 'hi');
    expect(writeResult.success).toBe(true);

    const readResult = await readScopedTextFile(root, 'notes/todo.txt');
    expect(readResult).toEqual(
      expect.objectContaining({ success: true, content: 'hi', exists: true }),
    );

    const deleteResult = await deleteScopedTextFile(root, 'notes/todo.txt');
    expect(deleteResult.success).toBe(true);
  });

  it('拒绝脚本/可执行扩展名与白名单之外的类型', async () => {
    const root = path.join(tmpRoot, 'blocked');
    await fs.ensureDir(root);

    for (const name of [
      'evil.bat',
      'evil.ps1',
      'evil.vbs',
      'evil.exe',
      'evil.xyz',
    ]) {
      const result = await writeScopedTextFile(root, name, 'payload');
      expect(result).toEqual(
        expect.objectContaining({ success: false, error: 'extension_blocked' }),
      );
    }
  });

  it('拒绝路径穿越与 .lr-agent 目录', async () => {
    const root = path.join(tmpRoot, 'traversal');
    await fs.ensureDir(root);

    const traversal = await writeScopedTextFile(root, '../escape.txt', 'x');
    expect(traversal).toEqual(
      expect.objectContaining({
        success: false,
        error: 'path_traversal_forbidden',
      }),
    );

    const protectedDir = await writeScopedTextFile(
      root,
      '.lr-agent/state.txt',
      'x',
    );
    expect(protectedDir).toEqual(
      expect.objectContaining({
        success: false,
        error: 'lr_agent_dir_forbidden',
      }),
    );
  });

  it('拒绝经符号链接逃逸出授权根', async () => {
    const root = path.join(tmpRoot, 'symlink-root');
    const outside = path.join(tmpRoot, 'symlink-outside');
    await fs.ensureDir(root);
    await fs.ensureDir(outside);

    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      await fs.symlink(outside, path.join(root, 'link'), linkType);
    } catch {
      // 环境不支持创建符号链接（如 Windows 未开启开发者模式），跳过该断言
      return;
    }

    const writeResult = await writeScopedTextFile(root, 'link/escape.txt', 'x');
    expect(writeResult).toEqual(
      expect.objectContaining({ success: false, error: 'path_outside_root' }),
    );

    const readResult = await readScopedTextFile(root, 'link/escape.txt');
    expect(readResult).toEqual(
      expect.objectContaining({ success: false, error: 'path_outside_root' }),
    );

    const deleteResult = await deleteScopedTextFile(root, 'link/escape.txt');
    expect(deleteResult).toEqual(
      expect.objectContaining({ success: false, error: 'path_outside_root' }),
    );
  });
});
