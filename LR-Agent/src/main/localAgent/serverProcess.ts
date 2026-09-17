/**
 * LR-Agent-local 本地 Agent 编排服务进程管理。
 *
 * 由 Electron 主进程 spawn 一个长驻 uvicorn 子进程（FastAPI，仅监听 127.0.0.1），
 * 承担 Assist 工具循环 SSE、标注 / 质量报告 LLM 编排。
 * 用户认证仍走云端 LR-Agent-backend；本服务无认证、无数据库。
 *
 * 生命周期对齐 mcp/server.ts：start → getBaseUrl → stop。
 * Python 解释器解析顺序统一为：
 *   LR_AGENT_LOCAL_PYTHON / LR_AGENT_LOCAL_CONDA_ENV（环境变量）
 *   → environment.json 用户覆盖 → CONDA_PREFIX/conda 候选
 *   → 嵌入式运行时 venv → 系统 python 兜底
 * 服务状态通过 localAgent:status 事件推送给渲染层（向导 / 横幅消费）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomBytes } from 'crypto';
import http from 'http';
import net from 'net';
import fs from 'fs-extra';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import type { LocalAgentServiceStatus } from '../../shared/envTypes';
import {
  condaEnvCandidates,
  condaRegistryCandidates,
  normalizePythonPath,
  pickExistingPython,
  systemPythonFallback,
  trimEnvironmentValue,
} from '../env/pythonDiscovery';
import { getEnvironmentConfig } from '../env/envStore';
import { getVenvPythonPath } from '../env/runtimeManager';
import { buildInferenceSpawnEnv } from '../preAnnot/inferenceProcess';

let processRef: ChildProcessWithoutNullStreams | null = null;
let startingProcess: Promise<string> | null = null;
let listenPort: number | null = null;
let stopping = false;
/** 本地服务访问 token（每次启动重新生成，仅注入子进程与渲染层） */
let authToken: string | null = null;

function pushLocalAgentStatus(status: LocalAgentServiceStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('localAgent:status', status);
  }
}

const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 300;

function getLocalAgentRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'local-agent');
  }
  return path.resolve(app.getAppPath(), 'vendor', 'local-agent');
}

export function resolveLocalAgentPython(): string {
  const condaEnv = process.env.LR_AGENT_LOCAL_CONDA_ENV ?? 'lr-agent-local';
  const candidates: string[] = [];

  const fromEnvVar = trimEnvironmentValue(process.env.LR_AGENT_LOCAL_PYTHON);
  if (fromEnvVar) {
    candidates.push(normalizePythonPath(fromEnvVar));
  }

  const userOverride = trimEnvironmentValue(
    getEnvironmentConfig().localAgentPythonOverride,
  );
  if (userOverride) {
    candidates.push(normalizePythonPath(userOverride));
  }

  const home = trimEnvironmentValue(process.env.CONDA_PREFIX);
  if (home && path.basename(home) === condaEnv) {
    candidates.push(
      process.platform === 'win32'
        ? path.join(home, 'python.exe')
        : path.join(home, 'bin', 'python'),
    );
  }

  candidates.push(
    ...condaEnvCandidates(app.getPath('home'), condaEnv),
    ...condaRegistryCandidates(app.getPath('home'), condaEnv),
    getVenvPythonPath('local-agent'),
  );

  const found = pickExistingPython(candidates);
  if (found) return found;

  return systemPythonFallback('[localAgent]', condaEnv);
}

/** 获取本机随机空闲端口 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
    srv.on('error', reject);
  });
}

function pingHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealthy(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (processRef === null || processRef.exitCode !== null) {
      throw new Error('本地 Agent 服务进程已退出');
    }
    if (await pingHealth(port)) return;
    if (Date.now() > deadline) {
      throw new Error(`本地 Agent 服务健康检查超时（${HEALTH_TIMEOUT_MS}ms）`);
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
}

/** 启动本地 Agent 服务，返回 API base URL（含 /api/v1 前缀） */
export async function startLocalAgentServer(): Promise<string> {
  if (processRef && listenPort) {
    return `http://127.0.0.1:${listenPort}/api/v1`;
  }
  if (startingProcess) {
    return startingProcess;
  }

  startingProcess = (async () => {
    const root = getLocalAgentRoot();
    const entry = path.join(root, 'local_main.py');
    if (!(await fs.pathExists(entry))) {
      throw new Error(`本地 Agent 服务未找到: ${entry}`);
    }

    const port = await getFreePort();
    const pythonPath = resolveLocalAgentPython();
    const spawnEnv = buildInferenceSpawnEnv(pythonPath);
    spawnEnv.LR_AGENT_LOCAL_PORT = String(port);
    authToken = randomBytes(32).toString('hex');
    spawnEnv.LR_AGENT_LOCAL_TOKEN = authToken;

    pushLocalAgentStatus({ state: 'starting', baseUrl: null });

    const proc = spawn(pythonPath, [entry], {
      cwd: root,
      stdio: 'pipe',
      env: spawnEnv,
    }) as ChildProcessWithoutNullStreams;
    // ENOENT/权限等 spawn 失败走正常启动错误流，而不是 unhandled 'error'
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve());
      proc.once('error', reject);
    });
    proc.on('error', (err) => {
      console.error('[localAgent] process error:', err);
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      console.log('[localAgent]', chunk.trimEnd());
    });
    proc.stderr.on('data', (chunk: string) => {
      console.error('[localAgent]', chunk.trimEnd());
    });
    proc.on('exit', (code) => {
      console.log(`[localAgent] process exited with code ${code}`);
      if (processRef === proc) {
        processRef = null;
        listenPort = null;
        authToken = null;
      }
      const wasStopping = stopping;
      stopping = false;
      pushLocalAgentStatus({
        state: 'stopped',
        baseUrl: null,
        message: wasStopping
          ? undefined
          : `本地 Agent 服务已退出 (code ${code ?? 'unknown'})`,
      });
    });

    processRef = proc;
    try {
      await waitForHealthy(port);
    } catch (err) {
      proc.kill();
      processRef = null;
      pushLocalAgentStatus({
        state: 'error',
        baseUrl: null,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    listenPort = port;
    const baseUrl = `http://127.0.0.1:${port}/api/v1`;
    console.log(`[localAgent] Local agent server started at ${baseUrl}`);
    pushLocalAgentStatus({ state: 'running', baseUrl });
    return baseUrl;
  })();

  try {
    return await startingProcess;
  } finally {
    startingProcess = null;
  }
}

/** 停止本地 Agent 服务 */
export function stopLocalAgentServer(): void {
  if (processRef) {
    stopping = true;
    processRef.kill();
    processRef = null;
    listenPort = null;
    authToken = null;
  }
}

/** 获取当前服务 base URL（未启动时返回 null） */
export function getLocalAgentBaseUrl(): string | null {
  if (listenPort) return `http://127.0.0.1:${listenPort}/api/v1`;
  return null;
}

/** 获取当前服务访问 token（未启动时返回 null） */
export function getLocalAgentToken(): string | null {
  return authToken;
}
