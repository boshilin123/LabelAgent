import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { EnvSettings } from '../../shared/envTypes';

import {
  defaultEnvSettings,
  getEnvironmentConfig,
  getEnvironmentStorePath,
  resetEnvironmentConfigCache,
  updateEnvironmentConfig,
} from './envStore';

let userDataDir: string;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
  },
}));

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-store-'));
  resetEnvironmentConfigCache();
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('defaultEnvSettings', () => {
  it('has empty overrides and uncompleted first run', () => {
    expect(defaultEnvSettings()).toEqual({
      backendBaseUrl: '',
      pipIndexUrl: '',
      localAgentPythonOverride: '',
      inferencePythonOverride: '',
      firstRunCompleted: false,
      firstRunDismissedAt: null,
      firstRunSeenAt: null,
    });
  });
});

describe('getEnvironmentConfig', () => {
  it('returns defaults when no file exists', () => {
    expect(getEnvironmentConfig()).toEqual(defaultEnvSettings());
  });

  it('reads and sanitizes a persisted file', () => {
    fs.writeJsonSync(
      getEnvironmentStorePath(),
      {
        backendBaseUrl: 'http://localhost:8000/api/v1',
        pipIndexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple',
        localAgentPythonOverride: 'C:\\Python312\\python.exe',
        inferencePythonOverride: '',
        firstRunCompleted: true,
        firstRunDismissedAt: '2026-09-07T00:00:00.000Z',
        firstRunSeenAt: '2026-09-07T00:01:00.000Z',
        unknownField: 'ignored',
      },
      { spaces: 2 },
    );
    expect(getEnvironmentConfig()).toEqual({
      backendBaseUrl: 'http://localhost:8000/api/v1',
      pipIndexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple',
      localAgentPythonOverride: 'C:\\Python312\\python.exe',
      inferencePythonOverride: '',
      firstRunCompleted: true,
      firstRunDismissedAt: '2026-09-07T00:00:00.000Z',
      firstRunSeenAt: '2026-09-07T00:01:00.000Z',
    });
  });

  it('coerces invalid field types back to defaults', () => {
    fs.writeJsonSync(getEnvironmentStorePath(), {
      backendBaseUrl: 42,
      firstRunCompleted: 'yes',
      firstRunDismissedAt: 123,
    });
    expect(getEnvironmentConfig()).toEqual(defaultEnvSettings());
  });
});

describe('updateEnvironmentConfig', () => {
  it('persists a partial patch and merges with existing settings', async () => {
    await updateEnvironmentConfig({
      backendBaseUrl: 'http://example.com:9000',
    });
    await updateEnvironmentConfig({
      firstRunCompleted: true,
      pipIndexUrl: 'https://mirror.example/simple',
    });

    const expected: EnvSettings = {
      ...defaultEnvSettings(),
      backendBaseUrl: 'http://example.com:9000',
      pipIndexUrl: 'https://mirror.example/simple',
      firstRunCompleted: true,
    };
    const stored = fs.readJsonSync(getEnvironmentStorePath());
    expect(stored).toEqual(expected);
    expect(getEnvironmentConfig()).toEqual(expected);
  });
});
