import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  condaEnvCandidates,
  condaRegistryCandidates,
  inferCondaEnvRoot,
  isUsablePythonPath,
  normalizePythonPath,
  pickExistingPython,
  systemPythonFallback,
  trimEnvironmentValue,
} from './pythonDiscovery';

let tempBase: string;

beforeEach(() => {
  tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'py-discovery-'));
});

afterEach(() => {
  fs.rmSync(tempBase, { recursive: true, force: true });
});

describe('trimEnvironmentValue', () => {
  it('returns undefined for empty input', () => {
    expect(trimEnvironmentValue(undefined)).toBeUndefined();
    expect(trimEnvironmentValue('')).toBeUndefined();
    expect(trimEnvironmentValue('   ')).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(trimEnvironmentValue('  C:\\Python\\python.exe  ')).toBe(
      'C:\\Python\\python.exe',
    );
  });
});

describe('normalizePythonPath', () => {
  it('strips surrounding quotes', () => {
    expect(normalizePythonPath('"C:\\Python\\python.exe"')).toBe(
      'C:\\Python\\python.exe',
    );
    expect(normalizePythonPath("'C:\\Python\\python.exe'")).toBe(
      'C:\\Python\\python.exe',
    );
  });

  it('appends python.exe when the path is an existing directory on win32', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const dir = path.join(tempBase, 'env-dir');
      fs.mkdirSync(dir);
      expect(normalizePythonPath(dir)).toBe(path.join(dir, 'python.exe'));
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('returns the input unchanged for an inaccessible path', () => {
    const missing = path.join(tempBase, 'does-not-exist', 'python.exe');
    expect(normalizePythonPath(missing)).toBe(missing);
  });

  it('returns the input unchanged for an existing file', () => {
    const file = path.join(tempBase, 'python.exe');
    fs.writeFileSync(file, 'x');
    expect(normalizePythonPath(file)).toBe(file);
  });
});

describe('condaEnvCandidates', () => {
  it('lists expected win32 candidate paths in priority order', () => {
    const candidates = condaEnvCandidates('C:\\Users\\me', 'lr-agent', 'win32');
    expect(candidates).toEqual([
      path.join('C:\\Users\\me', 'anaconda3', 'envs', 'lr-agent', 'python.exe'),
      path.join(
        'C:\\Users\\me',
        'miniconda3',
        'envs',
        'lr-agent',
        'python.exe',
      ),
      path.join(
        'C:\\Users\\me',
        'AppData',
        'Local',
        'miniconda3',
        'envs',
        'lr-agent',
        'python.exe',
      ),
      path.join(
        'C:\\Users\\me',
        'AppData',
        'Local',
        'anaconda3',
        'envs',
        'lr-agent',
        'python.exe',
      ),
    ]);
  });

  it('lists darwin/linux candidates without anaconda-first', () => {
    const candidates = condaEnvCandidates('/home/me', 'lr-agent', 'linux');
    expect(candidates).toEqual([
      path.join('/home/me', 'miniconda3', 'envs', 'lr-agent', 'bin', 'python'),
      path.join('/home/me', 'anaconda3', 'envs', 'lr-agent', 'bin', 'python'),
    ]);
  });
});

describe('condaRegistryCandidates', () => {
  function writeRegistry(home: string, lines: string[]): void {
    const condaDir = path.join(home, '.conda');
    fs.mkdirSync(condaDir, { recursive: true });
    fs.writeFileSync(path.join(condaDir, 'environments.txt'), lines.join('\n'));
  }

  it('finds an env on a non-user-profile drive from the registry', () => {
    writeRegistry(tempBase, [
      'D:\\Users\\user\\anaconda3',
      'D:\\Users\\user\\anaconda3\\envs\\lr-agent-local',
      'D:\\Users\\user\\anaconda3\\envs\\other-env',
    ]);
    expect(
      condaRegistryCandidates(tempBase, 'lr-agent-local', 'win32'),
    ).toEqual(['D:\\Users\\user\\anaconda3\\envs\\lr-agent-local\\python.exe']);
  });

  it('ignores the base env line and deduplicates', () => {
    writeRegistry(tempBase, [
      'D:\\Users\\user\\anaconda3',
      'D:\\Users\\user\\anaconda3\\envs\\lr-agent-local',
      'D:\\Users\\user\\anaconda3\\envs\\lr-agent-local',
    ]);
    expect(
      condaRegistryCandidates(tempBase, 'lr-agent-local', 'win32'),
    ).toHaveLength(1);
  });

  it('returns an empty list when the registry is missing', () => {
    expect(
      condaRegistryCandidates(tempBase, 'lr-agent-local', 'win32'),
    ).toEqual([]);
  });

  it('uses bin/python on posix platforms', () => {
    writeRegistry(tempBase, ['/opt/anaconda3/envs/lr-agent-local']);
    expect(
      condaRegistryCandidates(tempBase, 'lr-agent-local', 'darwin'),
    ).toEqual([
      path.join('/opt/anaconda3/envs/lr-agent-local', 'bin', 'python'),
    ]);
  });
});

describe('inferCondaEnvRoot', () => {
  it('derives env root from a win32 envs python path', () => {
    const pythonPath = 'D:\\conda\\envs\\lr-agent\\python.exe';
    expect(inferCondaEnvRoot(pythonPath)).toBe('D:\\conda\\envs\\lr-agent');
  });

  it('derives env root from a posix bin/python path', () => {
    const pythonPath = '/opt/conda/envs/lr-agent/bin/python';
    expect(inferCondaEnvRoot(pythonPath)).toBe('/opt/conda/envs/lr-agent');
  });

  it('returns null when the path is not under an envs directory', () => {
    expect(inferCondaEnvRoot('D:\\conda\\python.exe')).toBeNull();
  });
});

describe('pickExistingPython', () => {
  it('returns the first existing candidate', () => {
    const second = path.join(tempBase, 'second.exe');
    fs.writeFileSync(second, 'x');
    const result = pickExistingPython([
      path.join(tempBase, 'missing-first.exe'),
      second,
    ]);
    expect(result).toBe(second);
  });

  it('skips empty strings and returns null when nothing exists', () => {
    expect(
      pickExistingPython(['', path.join(tempBase, 'nothing.exe')]),
    ).toBeNull();
  });
});

describe('isUsablePythonPath', () => {
  it('detects a real file and rejects fake paths', () => {
    const file = path.join(tempBase, 'python.exe');
    fs.writeFileSync(file, 'x');
    expect(isUsablePythonPath(file)).toBe(true);
    expect(isUsablePythonPath('')).toBe(false);
    expect(isUsablePythonPath(path.join(tempBase, 'nope.exe'))).toBe(false);
  });
});

describe('systemPythonFallback', () => {
  it('returns the platform-specific interpreter name', () => {
    expect(systemPythonFallback('[test]', 'lr-agent', 'win32')).toBe('python');
    expect(systemPythonFallback('[test]', 'lr-agent', 'linux')).toBe('python3');
  });
});
