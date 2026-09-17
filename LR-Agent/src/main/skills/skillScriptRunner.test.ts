import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { runSkillScript } from './skillScriptRunner';
import {
  resetActiveWorkspaceRoot,
  setActiveWorkspaceRoot,
} from '../workspace/activeWorkspace';

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => os.tmpdir()),
  },
}));

// 解释器统一注入 node（process.execPath），使 .py 夹具内容可写为 JS，
// 测试不依赖宿主机是否装有 python/bash。
const NODE = process.execPath;

describe('runSkillScript', () => {
  let tmpDir: string;
  let skillDir: string;

  const writeFixture = async (
    relPath: string,
    content: string,
  ): Promise<void> => {
    const filePath = path.join(skillDir, ...relPath.split('/'));
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, 'utf-8');
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-runner-'));
    skillDir = path.join(tmpDir, 'skills', 'script-fixture');
    await fs.ensureDir(skillDir);
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: script-fixture-fm\ndescription: fixture skill for runner tests\n---\nbody',
      'utf-8',
    );
  });

  afterEach(async () => {
    resetActiveWorkspaceRoot();
    await fs.remove(tmpDir);
  });

  it('runs a scripts/ python script with args and returns output', async () => {
    await writeFixture(
      'scripts/echo.py',
      "process.stdout.write('args:' + process.argv.slice(2).join(','));",
    );
    const result = await runSkillScript(
      'script-fixture',
      'scripts/echo.py',
      ['a', 'b'],
      { interpreter: NODE, rootDir: path.join(tmpDir, 'skills') },
    );
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      output: 'args:a,b',
      truncated: false,
      timedOut: false,
    });
  });

  it('resolves skill by frontmatter name', async () => {
    await writeFixture('scripts/hi.py', "process.stdout.write('hi');");
    const result = await runSkillScript(
      'script-fixture-fm',
      'scripts/hi.py',
      [],
      { interpreter: NODE, rootDir: path.join(tmpDir, 'skills') },
    );
    expect(result).toMatchObject({ ok: true, output: 'hi' });
  });

  it('uses the active workspace as cwd, falling back to the skill dir', async () => {
    await writeFixture(
      'scripts/cwd.py',
      'process.stdout.write(process.cwd());',
    );
    const fallback = await runSkillScript(
      'script-fixture',
      'scripts/cwd.py',
      [],
      { interpreter: NODE, rootDir: path.join(tmpDir, 'skills') },
    );
    expect(fallback).toMatchObject({ ok: true, output: skillDir });

    const workspace = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workspace);
    setActiveWorkspaceRoot(workspace);
    const withWorkspace = await runSkillScript(
      'script-fixture',
      'scripts/cwd.py',
      [],
      { interpreter: NODE, rootDir: path.join(tmpDir, 'skills') },
    );
    expect(withWorkspace).toMatchObject({ ok: true, output: workspace });
  });

  it('propagates non-zero exit codes without failing', async () => {
    await writeFixture('scripts/fail.py', 'process.exit(3);');
    const result = await runSkillScript(
      'script-fixture',
      'scripts/fail.py',
      [],
      { interpreter: NODE, rootDir: path.join(tmpDir, 'skills') },
    );
    expect(result).toMatchObject({ ok: true, exitCode: 3 });
  });

  it('kills the process tree on timeout and reports timedOut', async () => {
    await writeFixture(
      'scripts/loop.py',
      "process.stdout.write('started'); setInterval(() => {}, 1000);",
    );
    const result = await runSkillScript(
      'script-fixture',
      'scripts/loop.py',
      [],
      {
        interpreter: NODE,
        timeoutMs: 1000,
        rootDir: path.join(tmpDir, 'skills'),
      },
    );
    expect(result).toMatchObject({ ok: true, timedOut: true });
    expect(result.ok && result.output).toContain('started');
    expect(result.ok && result.durationMs).toBeLessThan(30_000);
  });

  it('truncates oversized output', async () => {
    await writeFixture(
      'scripts/big.py',
      `process.stdout.write('x'.repeat(${20_000}));`,
    );
    const result = await runSkillScript(
      'script-fixture',
      'scripts/big.py',
      [],
      { interpreter: NODE, rootDir: path.join(tmpDir, 'skills') },
    );
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.output.length).toBeLessThan(20_000);
    expect(result.ok && result.output).toContain('已截断');
  });

  it('rejects path traversal and absolute paths', async () => {
    await writeFixture('scripts/ok.py', '');
    for (const bad of ['../evil.py', 'C:/evil.py', 'scripts/../../evil.py']) {
      const result = await runSkillScript('script-fixture', bad, [], {
        interpreter: NODE,
        rootDir: path.join(tmpDir, 'skills'),
      });
      expect(result).toMatchObject({ ok: false, error: 'invalid_path' });
    }
  });

  it('rejects scripts outside the scripts/ directory', async () => {
    await writeFixture('references/tool.py', '');
    const result = await runSkillScript(
      'script-fixture',
      'references/tool.py',
      [],
      { interpreter: NODE, rootDir: path.join(tmpDir, 'skills') },
    );
    expect(result).toMatchObject({ ok: false, error: 'invalid_path' });
  });

  it('rejects symlink escapes out of the skill directory', async () => {
    const outside = path.join(tmpDir, 'outside.py');
    await fs.writeFile(outside, 'process.exit(0);', 'utf-8');
    const link = path.join(skillDir, 'scripts', 'link.py');
    await fs.ensureDir(path.dirname(link));
    try {
      await fs.symlink(outside, link, 'file');
    } catch {
      // Windows 无开发者模式时创建 symlink 需要提权，跳过该用例
      return;
    }
    const result = await runSkillScript(
      'script-fixture',
      'scripts/link.py',
      [],
      {
        interpreter: NODE,
        rootDir: path.join(tmpDir, 'skills'),
      },
    );
    expect(result).toMatchObject({ ok: false, error: 'invalid_path' });
  });

  it('rejects unsupported script types, missing scripts, bad skills and args', async () => {
    await writeFixture('scripts/readme.txt', 'not a script');
    expect(
      await runSkillScript('script-fixture', 'scripts/readme.txt', [], {
        rootDir: path.join(tmpDir, 'skills'),
      }),
    ).toMatchObject({ ok: false, error: 'unsupported_type' });

    expect(
      await runSkillScript('script-fixture', 'scripts/nope.py', [], {
        rootDir: path.join(tmpDir, 'skills'),
      }),
    ).toMatchObject({ ok: false, error: 'script_not_found' });

    expect(
      await runSkillScript('no-such-skill', 'scripts/x.py', [], {
        rootDir: path.join(tmpDir, 'skills'),
      }),
    ).toMatchObject({ ok: false, error: 'skill_not_found' });

    expect(
      await runSkillScript('bad name!', 'scripts/x.py', [], {
        rootDir: path.join(tmpDir, 'skills'),
      }),
    ).toMatchObject({ ok: false, error: 'invalid_name' });

    expect(
      await runSkillScript(
        'script-fixture',
        'scripts/x.py',
        [1 as unknown as string],
        {
          rootDir: path.join(tmpDir, 'skills'),
        },
      ),
    ).toMatchObject({ ok: false, error: 'invalid_args' });
  });

  it('dispatches .py to a real python interpreter when one exists', async () => {
    const probe = spawnSync(
      process.platform === 'win32' ? 'python' : 'python3',
      ['--version'],
    );
    if (probe.error || probe.status !== 0) {
      // 宿主机无系统 python（如仅用嵌入式运行时）时跳过
      return;
    }
    await writeFixture(
      'scripts/greet.py',
      "import sys\nprint('hello from', sys.argv[1])",
    );
    const result = await runSkillScript(
      'script-fixture',
      'scripts/greet.py',
      ['manual-world'],
      { rootDir: path.join(tmpDir, 'skills') },
    );
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.ok && result.output).toContain('hello from manual-world');
    expect(result.ok && result.interpreter).not.toBe(NODE);
  });
});
