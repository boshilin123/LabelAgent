/**
 * 受限终端命令执行器（主进程）。
 *
 * Agent 的通用命令入口。与 skillScriptRunner 同一套纵深防御思路，但目标
 * 是"任意命令"，因此把安全重心放在执行前门禁与强制确认上：
 *   - 每次执行前必须经渲染层聊天内确认（ASYNC pending → 用户批准 → IPC start）；
 *   - cwd 强制锁定当前工作区（未打开工作区直接拒绝），不可配置；
 *   - 数组参数 spawn、不经 shell：command 中的 shell 元字符一律拒绝
 *     （管道/重定向/命令组合由模型多轮调用替代，不在这里模拟）；
 *   - 危险命令 denylist 命中即拒（确认门槛兜不住的破坏性操作）；
 *   - Windows 上 npm/npx 等是 .cmd 批处理垫片，按 PATH 解析而不是开 shell；
 *   - 输出环形缓冲（丢头部，游标绝对偏移），超时/手杀杀进程树。
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';
import { killProcessTree, buildAgentSpawnEnv } from './processUtils';
import { getActiveWorkspaceRoot } from '../workspace/activeWorkspace';

/** 输出环形缓冲上限（字符） */
export const MAX_JOB_OUTPUT_CHARS = 128_000;
/** 默认/最大超时 */
export const DEFAULT_JOB_TIMEOUT_MS = 300_000;
export const MAX_JOB_TIMEOUT_MS = 600_000;
/** 并发 job 上限 */
export const MAX_RUNNING_JOBS = 4;
/** 结束后保留的 job 快照数（供模型回读输出） */
const MAX_FINISHED_JOBS = 50;

export type TerminalJobStatus =
  'running' | 'exited' | 'timeout' | 'killed' | 'failed';

export interface TerminalJobSnapshot {
  jobId: string;
  command: string;
  args: string[];
  status: TerminalJobStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  /** 环形缓冲内当前内容（可能已丢头部） */
  output: string;
  /** 输出是否因超过缓冲上限而丢弃过内容 */
  truncated: boolean;
  /** 已从缓冲头部丢弃的字符数（游标换算用） */
  droppedChars: number;
}

export type TerminalStartError =
  | 'no_workspace'
  | 'invalid_command'
  | 'shell_syntax_unsupported'
  | 'denied_command'
  | 'too_many_jobs'
  | 'spawn_failed';

export type TerminalStartResult =
  | { ok: true; jobId: string }
  | { ok: false; error: TerminalStartError; message?: string };

export type TerminalReadResult =
  | {
      ok: true;
      jobId: string;
      status: TerminalJobStatus;
      exitCode: number | null;
      /** 自 cursor 起的输出（可能因环形缓冲截断而跳过） */
      chunk: string;
      nextCursor: number;
      /** cursor 指向的内容已被环形缓冲丢弃 */
      dropped?: boolean;
      truncated: boolean;
    }
  | { ok: false; error: 'job_not_found' };

export type TerminalEvent =
  | { type: 'output'; jobId: string; chunk: string; status: TerminalJobStatus }
  | { type: 'exit'; jobId: string; snapshot: TerminalJobSnapshot };

interface TerminalJob {
  snapshot: TerminalJobSnapshot;
  child: ChildProcess | null;
}

const jobs = new Map<string, TerminalJob>();
const eventListeners = new Set<(event: TerminalEvent) => void>();

function emitEvent(event: TerminalEvent): void {
  eventListeners.forEach((listener) => listener(event));
}

/** 订阅 job 事件（IPC 层转发给渲染层用）；返回退订函数 */
export function subscribeTerminalEvents(
  listener: (event: TerminalEvent) => void,
): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

// ── 执行前门禁 ──────────────────────────────────────────────────────────────

/** command 中不允许出现的 shell 元字符（无 shell 执行，出现即语义错误） */
const SHELL_METACHARS = /[|&;<>\n\r`$\0]/;

/** 危险命令 denylist：命中即拒，不走确认流程 */
const DENYLIST: RegExp[] = [
  /\brm\b[^|]*\s-[a-zA-Z]*[rf]/, // rm -r / -f / -rf
  /\bdel\b[^|]*\/[sq]/i, // del /s /q
  /\brd\b\s+\/s/i, // rd /s
  /\bmkfs/i,
  /\bdiskpart/i,
  /\bformat\b/i, // format 磁盘（非命令用法时极少作首个 token）
  /\breg(\.exe)?\s+delete/i,
  /\bshutdown/i,
  /\breboot\b/,
  /\bcipher\b\s+\/w/i,
  /\bRemove-Item\b[^|]*-Recurse/i,
  /\bgit\s+push\b[^|]*--force/i,
  /\bdrop\s+(database|table)\b/i,
];

/** Windows 下需要 .cmd 垫片解析的常见包管理器命令 */
const WINDOWS_CMD_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'tsc', 'ng']);

/** PATH 上解析 .cmd / .exe 垫片；找不到原样返回（交给 spawn 报错） */
function resolveWindowsCommand(command: string): string {
  if (process.platform !== 'win32') return command;
  if (path.extname(command)) return command;
  const base = path.basename(command).toLowerCase();
  if (!WINDOWS_CMD_SHIMS.has(base)) return command;
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['.cmd', '.exe']) {
      const candidate = path.join(dir, `${base}${ext}`);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // 不可访问的 PATH 项跳过
      }
    }
  }
  return command;
}

function runGates(command: string, args: string[]): TerminalStartResult | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 512) {
    return { ok: false, error: 'invalid_command' };
  }
  if (args.length > 128 || args.some((arg) => arg.length > 8_192)) {
    return { ok: false, error: 'invalid_command' };
  }
  if (SHELL_METACHARS.test(trimmed)) {
    return {
      ok: false,
      error: 'shell_syntax_unsupported',
      message:
        '终端执行不经 shell，不支持管道/重定向/命令组合；请拆成多步分别调用',
    };
  }
  const fullLine = [trimmed, ...args].join(' ');
  if (DENYLIST.some((pattern) => pattern.test(fullLine))) {
    return { ok: false, error: 'denied_command' };
  }
  return null;
}

// ── job 生命周期 ────────────────────────────────────────────────────────────

function runningCount(): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.snapshot.status === 'running') count += 1;
  }
  return count;
}

function pruneFinishedJobs(): void {
  const finished = [...jobs.entries()].filter(
    ([, job]) => job.snapshot.status !== 'running',
  );
  while (finished.length > MAX_FINISHED_JOBS) {
    const [oldest] = finished.shift()!;
    jobs.delete(oldest);
  }
}

export function startTerminalJob(input: {
  command: string;
  args?: string[];
  timeoutMs?: number;
}): TerminalStartResult {
  const cwd = getActiveWorkspaceRoot();
  if (!cwd) {
    return {
      ok: false,
      error: 'no_workspace',
      message: '未打开工作区，终端命令只能在打开的工作区内执行',
    };
  }
  const args = (input.args ?? []).map(String);
  const gate = runGates(input.command, args);
  if (gate) return gate;
  if (runningCount() >= MAX_RUNNING_JOBS) {
    return { ok: false, error: 'too_many_jobs' };
  }

  const command = resolveWindowsCommand(input.command.trim());
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS, 1_000),
    MAX_JOB_TIMEOUT_MS,
  );

  const jobId = randomUUID();
  const job: TerminalJob = {
    snapshot: {
      jobId,
      command,
      args,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      output: '',
      truncated: false,
      droppedChars: 0,
    },
    child: null,
  };
  jobs.set(jobId, job);

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildAgentSpawnEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (err) {
    job.snapshot.status = 'failed';
    job.snapshot.finishedAt = Date.now();
    return {
      ok: false,
      error: 'spawn_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  job.child = child;

  let output = '';
  const appendOutput = (chunk: string) => {
    if (!chunk) return;
    output += chunk;
    if (output.length > MAX_JOB_OUTPUT_CHARS) {
      const cut = output.length - MAX_JOB_OUTPUT_CHARS;
      output = output.slice(cut);
      job.snapshot.droppedChars += cut;
      job.snapshot.truncated = true;
    }
    job.snapshot.output = output;
    emitEvent({
      type: 'output',
      jobId,
      chunk,
      status: job.snapshot.status,
    });
  };
  child.stdout?.on('data', (chunk: Buffer) =>
    appendOutput(chunk.toString('utf8')),
  );
  child.stderr?.on('data', (chunk: Buffer) =>
    appendOutput(chunk.toString('utf8')),
  );

  const timer = setTimeout(() => {
    if (job.snapshot.status !== 'running') return;
    job.snapshot.status = 'timeout';
    killProcessTree(child);
  }, timeoutMs);

  child.on('error', (err) => {
    if (job.snapshot.status !== 'running') return;
    clearTimeout(timer);
    job.snapshot.status = 'failed';
    job.snapshot.finishedAt = Date.now();
    job.child = null;
    appendOutput(`\n[启动失败] ${err.message}\n`);
    emitEvent({ type: 'exit', jobId, snapshot: { ...job.snapshot } });
  });

  child.on('close', (exitCode) => {
    clearTimeout(timer);
    if (job.snapshot.status === 'running') {
      job.snapshot.status = 'exited';
    }
    job.snapshot.exitCode = exitCode;
    job.snapshot.finishedAt = Date.now();
    job.child = null;
    emitEvent({ type: 'exit', jobId, snapshot: { ...job.snapshot } });
    pruneFinishedJobs();
  });

  return { ok: true, jobId };
}

export function getTerminalJob(jobId: string): TerminalJobSnapshot | null {
  const job = jobs.get(jobId);
  return job ? { ...job.snapshot } : null;
}

/** 游标式增量读取：cursor 为绝对字符偏移（含已丢弃部分） */
export function readTerminalJobFrom(
  jobId: string,
  cursor = 0,
): TerminalReadResult {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, error: 'job_not_found' };
  const { snapshot } = job;
  const bufferStart = snapshot.droppedChars;
  const dropped = cursor < bufferStart;
  const localStart = Math.max(0, cursor - bufferStart);
  const chunk = snapshot.output.slice(localStart);
  return {
    ok: true,
    jobId,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    chunk,
    nextCursor: bufferStart + snapshot.output.length,
    ...(dropped ? { dropped: true } : {}),
    truncated: snapshot.truncated,
  };
}

export function killTerminalJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.snapshot.status !== 'running') return false;
  job.snapshot.status = 'killed';
  if (job.child) killProcessTree(job.child);
  // close 事件负责补 exitCode/finishedAt/exit 事件
  return true;
}

/** 应用退出时终止全部运行中 job（main.ts before-quit 调用） */
export function killAllTerminalJobs(): void {
  for (const job of jobs.values()) {
    if (job.snapshot.status === 'running' && job.child) {
      job.snapshot.status = 'killed';
      killProcessTree(job.child);
    }
  }
}

/** 仅测试用 */
export function resetTerminalJobs(): void {
  killAllTerminalJobs();
  jobs.clear();
}
