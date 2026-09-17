import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  getHiddenSkills,
  getSkillsConfig,
  getSkillsStorePath,
  isSkillHidden,
  resetSkillsStoreCache,
  setSkillHidden,
} from './skillsStore';

let userDataDir: string;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
  },
}));

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-'));
  resetSkillsStoreCache();
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('getSkillsConfig', () => {
  it('无文件时返回空清单', () => {
    expect(getSkillsConfig()).toEqual({ hiddenSkills: [] });
  });

  it('清洗落盘文件：非字符串/非法目录名/重复项丢弃', () => {
    fs.writeJsonSync(getSkillsStorePath(), {
      hiddenSkills: ['ok-skill', 12, '', 'bad name', 'ok-skill', '../escape'],
    });
    resetSkillsStoreCache();
    expect(getHiddenSkills()).toEqual(['ok-skill']);
  });

  it('结构非法时回退默认值', () => {
    fs.writeJsonSync(getSkillsStorePath(), { hiddenSkills: 'not-a-list' });
    resetSkillsStoreCache();
    expect(getSkillsConfig()).toEqual({ hiddenSkills: [] });
  });
});

describe('setSkillHidden', () => {
  it('停用与启用往返，落盘持久化', async () => {
    await setSkillHidden('caveman', true);
    expect(isSkillHidden('caveman')).toBe(true);

    resetSkillsStoreCache();
    expect(getHiddenSkills()).toEqual(['caveman']);

    await setSkillHidden('caveman', false);
    expect(isSkillHidden('caveman')).toBe(false);
    resetSkillsStoreCache();
    expect(getHiddenSkills()).toEqual([]);
  });

  it('重复停用不产生重复项', async () => {
    await setSkillHidden('a', true);
    await setSkillHidden('a', true);
    expect(getHiddenSkills()).toEqual(['a']);
  });

  it('拒绝非法目录名（防路径穿越）', async () => {
    await setSkillHidden('../escape', true);
    await setSkillHidden('bad name', true);
    await setSkillHidden('', true);
    expect(getHiddenSkills()).toEqual([]);
  });
});
