import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  MAX_RUNNING_JOBS,
  getTerminalJob,
  killAllTerminalJobs,
  killTerminalJob,
  readTerminalJobFrom,
  resetTerminalJobs,
  startTerminalJob,
  subscribeTerminalEvents,
} from './commandJobManager';
import {
  resetActiveWorkspaceRoot,
  setActiveWorkspaceRoot,
} from '../workspace/activeWorkspace';

const NODE = process.execPath;

/** 等待 job 到终态（close 事件异步落 snapshot） */
async function waitForTerminal(
  jobId: string,
): Promise<ReturnType<typeof getTerminalJob>> {
  for (let i = 0; i < 100; i += 1) {
    const snap = getTerminalJob(jobId);
    if (snap && snap.status !== 'running') return snap;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} 未在预期时间内结束`);
}

describe('startTerminalJob 门禁', () => {
  beforeEach(() => {
    resetTerminalJobs();
    resetActiveWorkspaceRoot();
  });

  afterEach(() => {
    killAllTerminalJobs();
    resetActiveWorkspaceRoot();
  });

  it('未打开工作区时拒绝执行', () => {
    const result = startTerminalJob({ command: 'git', args: ['status'] });
    expect(result).toMatchObject({ ok: false, error: 'no_workspace' });
  });

  it('拒绝空命令与超长参数', () => {
    setActiveWorkspaceRoot(os.tmpdir());
    expect(startTerminalJob({ command: '  ' })).toMatchObject({
      ok: false,
      error: 'invalid_command',
    });
    expect(
      startTerminalJob({ command: 'node', args: ['x'.repeat(9000)] }),
    ).toMatchObject({ ok: false, error: 'invalid_command' });
  });

  it('拒绝 shell 元字符（no-shell 约定）', () => {
    setActiveWorkspaceRoot(os.tmpdir());
    expect(startTerminalJob({ command: 'echo a|b' })).toMatchObject({
      ok: false,
      error: 'shell_syntax_unsupported',
    });
    expect(startTerminalJob({ command: 'echo a>b' })).toMatchObject({
      ok: false,
      error: 'shell_syntax_unsupported',
    });
    expect(startTerminalJob({ command: 'echo `id`' })).toMatchObject({
      ok: false,
      error: 'shell_syntax_unsupported',
    });
  });

  it('命中危险命令 denylist 直接拒绝', () => {
    setActiveWorkspaceRoot(os.tmpdir());
    expect(
      startTerminalJob({ command: 'rm', args: ['-rf', 'dist'] }),
    ).toMatchObject({ ok: false, error: 'denied_command' });
    expect(
      startTerminalJob({ command: 'shutdown', args: ['/s'] }),
    ).toMatchObject({ ok: false, error: 'denied_command' });
    expect(
      startTerminalJob({ command: 'reg', args: ['delete', 'HKLM\\x'] }),
    ).toMatchObject({ ok: false, error: 'denied_command' });
  });

  it('并发达到上限时拒绝新 job', () => {
    setActiveWorkspaceRoot(os.tmpdir());
    const started: string[] = [];
    for (let i = 0; i < MAX_RUNNING_JOBS; i += 1) {
      const r = startTerminalJob({
        command: NODE,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      });
      expect(r.ok).toBe(true);
      if (r.ok) started.push(r.jobId);
    }
    const extra = startTerminalJob({ command: NODE, args: ['-e', ''] });
    expect(extra).toMatchObject({ ok: false, error: 'too_many_jobs' });
    started.forEach((id) => killTerminalJob(id));
  });

  it('剥离 NODE_OPTIONS 等 Electron/开发期注入变量', async () => {
    setActiveWorkspaceRoot(os.tmpdir());
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '-r ts-node/register --no-warnings';
    try {
      const result = startTerminalJob({
        command: NODE,
        args: ['-e', "console.log(process.env.NODE_OPTIONS ?? 'CLEAN')"],
      });
      if (!result.ok) throw new Error('start failed');
      const snap = await waitForTerminal(result.jobId);
      expect(snap?.output).toContain('CLEAN');
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prev;
    }
  });
});

describe('startTerminalJob 执行', () => {
  let workspace: string;

  beforeEach(async () => {
    resetTerminalJobs();
    resetActiveWorkspaceRoot();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-job-'));
    setActiveWorkspaceRoot(workspace);
  });

  afterEach(async () => {
    killAllTerminalJobs();
    resetActiveWorkspaceRoot();
    // Windows：被杀进程的 cwd 短暂锁定目录，重试清理
    try {
      await fs.remove(workspace);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await fs.remove(workspace).catch(() => undefined);
    }
  });

  it('执行命令并捕获输出与退出码', async () => {
    const result = startTerminalJob({
      command: NODE,
      args: ['-e', "console.log('job-ok')"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snap = await waitForTerminal(result.jobId);
    expect(snap).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(snap?.output).toContain('job-ok');
  });

  it('cwd 锁定为当前工作区', async () => {
    const result = startTerminalJob({
      command: NODE,
      args: ['-e', 'console.log(process.cwd())'],
    });
    if (!result.ok) throw new Error('start failed');
    const snap = await waitForTerminal(result.jobId);
    expect(snap?.output).toContain(workspace);
  });

  it('非零退出码与 stderr 都被记录', async () => {
    const result = startTerminalJob({
      command: NODE,
      args: ['-e', "console.error('bad'); process.exit(3)"],
    });
    if (!result.ok) throw new Error('start failed');
    const snap = await waitForTerminal(result.jobId);
    expect(snap).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(snap?.output).toContain('bad');
  });

  it('超时杀进程树并标记 timeout', async () => {
    const result = startTerminalJob({
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 1000,
    });
    if (!result.ok) throw new Error('start failed');
    const snap = await waitForTerminal(result.jobId);
    expect(snap?.status).toBe('timeout');
  }, 30_000);

  it('手动 kill 标记 killed', async () => {
    const result = startTerminalJob({
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    if (!result.ok) throw new Error('start failed');
    expect(killTerminalJob(result.jobId)).toBe(true);
    const snap = await waitForTerminal(result.jobId);
    expect(snap?.status).toBe('killed');
  }, 30_000);

  it('游标式增量读取与环形缓冲丢头标记', async () => {
    const result = startTerminalJob({
      command: NODE,
      args: ['-e', "console.log('chunk-one'); console.log('chunk-two')"],
    });
    if (!result.ok) throw new Error('start failed');
    await waitForTerminal(result.jobId);

    const first = readTerminalJobFrom(result.jobId, 0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.chunk).toContain('chunk-one');
    expect(first.chunk).toContain('chunk-two');
    expect(first.dropped).toBeUndefined();

    const second = readTerminalJobFrom(result.jobId, first.nextCursor);
    expect(second.ok && second.chunk).toBe('');
  });

  it('不存在的 job 返回 job_not_found', () => {
    expect(readTerminalJobFrom('nope', 0)).toMatchObject({
      ok: false,
      error: 'job_not_found',
    });
    expect(killTerminalJob('nope')).toBe(false);
  });

  it('输出与终态经 subscribeTerminalEvents 推送', async () => {
    const events: Array<{ type: string; jobId?: string }> = [];
    const unsubscribe = subscribeTerminalEvents((event) => {
      events.push({ type: event.type, jobId: event.jobId });
    });
    const result = startTerminalJob({
      command: NODE,
      args: ['-e', "console.log('stream-me')"],
    });
    if (!result.ok) throw new Error('start failed');
    await waitForTerminal(result.jobId);
    unsubscribe();
    const types = events
      .filter((e) => e.jobId === result.jobId)
      .map((e) => e.type);
    expect(types).toContain('output');
    expect(types).toContain('exit');
  });
});
