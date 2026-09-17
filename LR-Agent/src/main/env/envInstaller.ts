/**
 * 环境一键安装器。
 *
 * 使用嵌入式 Python 运行时（python-build-standalone）为 local-agent / inference
 * 创建独立 venv 并安装依赖，阶段推进：
 *   prepare-runtime → create-venv → install-deps → verify → done/failed/cancelled
 *
 * 安装全程仅由用户在向导中手动触发（无静默安装），进度通过
 * env:install:progress 推送给渲染层；支持随时取消（杀进程树），
 * 关窗口不断流，应用退出时终止。
 */
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { app, BrowserWindow } from 'electron';
import type {
  InstallProgress,
  InstallStartResult,
  InstallTarget,
  InferenceVariant,
} from '../../shared/envTypes';
import {
  ensureRuntimeExtracted,
  getRuntimesDir,
  getVenvDir,
  getVenvPythonPath,
  readInstallMarker,
  removeVenv,
  requirementsHash,
  TARGET_PYTHON_VERSION,
  writeInstallMarker,
} from './runtimeManager';
import { getEnvironmentConfig } from './envStore';
import { trimEnvironmentValue } from './pythonDiscovery';
import { buildInferenceSpawnEnv } from '../preAnnot/inferenceProcess';
import { killProcessTree } from '../exec/processUtils';

const MAX_LOG_LINES = 40;

// SAM-2 依赖修复：git+https 在无 git 的机器上装不了，改写为 GitHub 源码 zip，
// pip 对 github.com 归档 URL 内置解包支持（无 git 也能装）
const SAM2_GIT_URL = 'git+https://github.com/facebookresearch/sam2.git';
const SAM2_ARCHIVE_URL =
  'SAM-2 @ https://github.com/facebookresearch/sam2/archive/refs/heads/main.zip';

const TORCH_GPU_INDEX = 'https://download.pytorch.org/whl/cu121';
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';

/** 验证阶段要 import 的模块（import 成功即视为核心依赖可用） */
const VERIFY_IMPORTS: Record<InstallTarget, string> = {
  'local-agent': 'fastapi, uvicorn, langchain_core',
  inference: 'torch, torchvision, ultralytics, cv2, PIL, sam2',
};

interface InstallJob {
  target: InstallTarget;
  variant: InferenceVariant;
  requirementsHashValue: string;
  progress: InstallProgress;
  canceled: boolean;
  child: ChildProcess | null;
}

let currentInstall: InstallJob | null = null;

class InstallCanceledError extends Error {}

function rootOf(target: InstallTarget): string {
  if (target === 'local-agent') {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'local-agent');
    }
    return path.resolve(app.getAppPath(), 'vendor', 'local-agent');
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'inference');
  }
  return path.resolve(app.getAppPath(), 'vendor', 'inference');
}

async function requirementsPathOf(
  target: InstallTarget,
  variant: InferenceVariant,
): Promise<string> {
  const root = rootOf(target);
  const file =
    target === 'local-agent'
      ? 'requirements.txt'
      : `requirements-${variant}.txt`;
  const requirementsPath = path.join(root, file);
  if (!(await fs.pathExists(requirementsPath))) {
    throw new Error(`依赖清单不存在: ${requirementsPath}`);
  }
  return requirementsPath;
}

/** 探测本机 GPU：nvidia-smi 可用且报出设备则用 GPU 依赖，否则 CPU */
async function detectInferenceVariant(): Promise<InferenceVariant> {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return 'cpu';
  }
  try {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(
        'nvidia-smi',
        ['--query-gpu=name', '--format=csv,noheader'],
        { stdio: 'ignore', windowsHide: true },
      );
      child.on('error', () => resolve(null));
      child.on('close', resolve);
      setTimeout(() => {
        child.kill();
        resolve(null);
      }, 5000);
    });
    return code === 0 ? 'gpu' : 'cpu';
  } catch {
    return 'cpu';
  }
}

/** 去掉 BOM；SAM-2 的 git 依赖改写为 GitHub 归档 zip */
function sanitizeRequirements(content: string): string {
  const lines: string[] = [];
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    lines.push(line.includes(SAM2_GIT_URL) ? SAM2_ARCHIVE_URL : line);
  }
  return lines.join('\n');
}

function pushProgress(): void {
  if (!currentInstall) return;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('env:install:progress', currentInstall.progress);
  }
}

function setStage(stage: InstallProgress['stage'], error?: string): void {
  if (!currentInstall || currentInstall.progress.stage === 'done') return;
  const { progress } = currentInstall;
  progress.stage = error ? 'failed' : stage;
  if (error) progress.error = error;
  pushProgress();
}

function appendLine(text: string): void {
  if (!currentInstall) return;
  const { lines } = currentInstall.progress;
  lines.push(text);
  if (lines.length > MAX_LOG_LINES) {
    lines.splice(0, lines.length - MAX_LOG_LINES);
  }
  pushProgress();
}

function isFinished(stage: InstallProgress['stage']): boolean {
  return stage === 'done' || stage === 'failed' || stage === 'cancelled';
}

/** 流式执行命令，输出逐行进 job 日志；进程树可取消 */
function runCommand(
  job: InstallJob,
  command: string,
  args: string[],
  cwd: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    appendLine(`> ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildInferenceSpawnEnv(command),
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    job.child = child;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8').replace(/\n+$/, '');
      if (text.trim()) appendLine(text.trim());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      appendLine(`启动失败: ${err.message}`);
      if (job.child === child) job.child = null;
      resolve(null);
    });
    child.on('close', (code) => {
      if (job.child === child) job.child = null;
      resolve(code);
    });
  });
}

async function runInstall(job: InstallJob): Promise<void> {
  const { target, variant } = job;
  try {
    appendLine(`=== 开始安装 ${target} (${variant}) ===`);

    setStage('prepare-runtime');
    const version = TARGET_PYTHON_VERSION[target];
    const runtimePython = await ensureRuntimeExtracted(version);
    if (!runtimePython) {
      throw new Error(
        `嵌入式运行时 ${version} 未就绪。开发模式请先运行 npm run fetch-python-runtimes；` +
          `打包产物缺失请重新构建安装包。`,
      );
    }
    appendLine(`使用嵌入式运行时: ${runtimePython}`);
    if (job.canceled) throw new InstallCanceledError();

    setStage('create-venv');
    await removeVenv(target);
    const venvDir = getVenvDir(target);
    let code = await runCommand(
      job,
      runtimePython,
      ['-m', 'venv', venvDir],
      getRuntimesDir(),
    );
    if (job.canceled) throw new InstallCanceledError();
    if (code !== 0) throw new Error('创建虚拟环境失败');

    const venvPython = getVenvPythonPath(target);
    code = await runCommand(
      job,
      venvPython,
      ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'],
      getRuntimesDir(),
    );
    if (job.canceled) throw new InstallCanceledError();
    if (code !== 0) throw new Error('pip 升级失败');

    setStage('install-deps');
    const requirementsPath = await requirementsPathOf(target, variant);
    const sanitized = sanitizeRequirements(
      await fs.readFile(requirementsPath, 'utf8'),
    );
    const preparedFile = path.join(
      getRuntimesDir(),
      `${target}-requirements.txt`,
    );
    await fs.writeFile(preparedFile, sanitized, 'utf8');

    const indexUrl = trimEnvironmentValue(getEnvironmentConfig().pipIndexUrl);
    if (indexUrl) {
      appendLine(`使用 pip 镜像源: ${indexUrl}`);
    }
    const pipArgs = [
      '-m',
      'pip',
      'install',
      '-r',
      preparedFile,
      '--no-cache-dir',
    ];
    if (indexUrl) {
      pipArgs.push('--index-url', indexUrl);
    } else if (variant === 'gpu') {
      pipArgs.push('--extra-index-url', TORCH_GPU_INDEX);
    } else {
      pipArgs.push('--extra-index-url', TORCH_CPU_INDEX);
    }

    code = await runCommand(job, venvPython, pipArgs, getRuntimesDir());
    if (job.canceled) throw new InstallCanceledError();
    if (code !== 0) throw new Error(`pip 安装失败 (exit ${code})`);

    setStage('verify');
    code = await runCommand(
      job,
      venvPython,
      ['-c', `import ${VERIFY_IMPORTS[target]}; print('verify ok')`],
      getRuntimesDir(),
    );
    if (job.canceled) throw new InstallCanceledError();
    if (code !== 0) throw new Error('依赖导入验证失败');

    await writeInstallMarker(target, {
      requirementsHash: job.requirementsHashValue,
      variant: target === 'inference' ? variant : undefined,
      installedAt: new Date().toISOString(),
    });

    appendLine('=== 安装完成 ===');
    setStage('done');
    currentInstall!.progress.finishedAt = Date.now();
  } catch (err) {
    if (err instanceof InstallCanceledError || job.canceled) {
      appendLine('=== 安装已取消 ===');
      setStage('cancelled');
      currentInstall!.progress.finishedAt = Date.now();
    } else {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(`=== 安装失败: ${message} ===`);
      setStage('failed', message);
      currentInstall!.progress.finishedAt = Date.now();
    }
  }
}

/** 启动一键安装；同一目标已完成时直接返回 alreadyInstalled */
export async function startInstall(
  target: InstallTarget,
): Promise<InstallStartResult> {
  if (currentInstall && !isFinished(currentInstall.progress.stage)) {
    return { ok: false, error: '已有安装任务进行中' };
  }

  const variant =
    target === 'inference' ? await detectInferenceVariant() : 'cpu';

  const requirementsPath = await requirementsPathOf(target, variant);
  const content = sanitizeRequirements(
    await fs.readFile(requirementsPath, 'utf8'),
  );
  const hash = requirementsHash(content);

  const marker = await readInstallMarker(target);
  const venvReady = fs.existsSync(getVenvPythonPath(target));
  if (
    marker &&
    marker.requirementsHash === hash &&
    (target === 'local-agent' || marker.variant === variant) &&
    venvReady
  ) {
    return { ok: true, alreadyInstalled: true };
  }

  currentInstall = {
    target,
    variant,
    requirementsHashValue: hash,
    canceled: false,
    child: null,
    progress: {
      target,
      variant: target === 'inference' ? variant : undefined,
      stage: 'pending',
      lines: [],
      startedAt: Date.now(),
      finishedAt: null,
    },
  };
  pushProgress();

  void runInstall(currentInstall);
  return { ok: true };
}

/** 取消进行中的安装（杀进程树），无进行中任务返回 false */
export function cancelInstall(): boolean {
  if (!currentInstall || isFinished(currentInstall.progress.stage)) {
    return false;
  }
  currentInstall.canceled = true;
  if (currentInstall.child) killProcessTree(currentInstall.child);
  return true;
}

/** 当前安装进度（向导重开时恢复展示），无任务时返回 null */
export function getInstallProgress(): InstallProgress | null {
  if (!currentInstall) return null;
  return {
    ...currentInstall.progress,
    lines: [...currentInstall.progress.lines],
  };
}

app.on('before-quit', () => {
  if (currentInstall && currentInstall.child) {
    killProcessTree(currentInstall.child);
  }
});
