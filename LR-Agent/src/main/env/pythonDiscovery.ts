/**
 * Python 解释器发现公共工具 — 供 localAgent 与 preAnnot 两个 spawn 服务共用。
 *
 * 解释器候选由各服务自行组装，优先级统一为：
 *   环境变量 → environment.json 用户覆盖 → CONDA_PREFIX/conda 候选
 *   → 嵌入式运行时 venv → 系统 python 兜底
 */
import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import type { PythonValidationResult } from '../../shared/envTypes';

const execFileAsync = promisify(execFile);

export function trimEnvironmentValue(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** 去掉首尾引号；目录路径补全 python(.exe)；不存在/无法 stat 时原样返回 */
export function normalizePythonPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return trimmed;
  try {
    if (fs.statSync(trimmed).isDirectory()) {
      return process.platform === 'win32'
        ? path.join(trimmed, 'python.exe')
        : path.join(trimmed, 'bin', 'python');
    }
  } catch {
    // 路径不可访问时原样返回，交给后续 exists 检查兜底
  }
  return trimmed;
}

/** conda 环境解释器的常规候选位置（按优先级排序） */
export function condaEnvCandidates(
  home: string,
  condaEnv: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    return [
      path.join(home, 'anaconda3', 'envs', condaEnv, 'python.exe'),
      path.join(home, 'miniconda3', 'envs', condaEnv, 'python.exe'),
      path.join(
        home,
        'AppData',
        'Local',
        'miniconda3',
        'envs',
        condaEnv,
        'python.exe',
      ),
      path.join(
        home,
        'AppData',
        'Local',
        'anaconda3',
        'envs',
        condaEnv,
        'python.exe',
      ),
    ];
  }
  return [
    path.join(home, 'miniconda3', 'envs', condaEnv, 'bin', 'python'),
    path.join(home, 'anaconda3', 'envs', condaEnv, 'bin', 'python'),
  ];
}

/** 从 .../envs/<name>/python.exe 或 .../envs/<name>/bin/python 推断 conda 环境根目录 */
export function inferCondaEnvRoot(pythonPath: string): string | null {
  const normalized = pythonPath.replace(/\\/g, '/');
  if (!normalized.toLowerCase().includes('/envs/')) return null;
  if (normalized.endsWith('/bin/python')) {
    return path.dirname(path.dirname(pythonPath));
  }
  return path.dirname(pythonPath);
}

/**
 * 从 conda 环境注册表（~/.conda/environments.txt）收集目标环境的解释器候选。
 *
 * anaconda 安装在非用户目录盘符（例如 D:\Users\user\anaconda3 而 USERPROFILE
 * 在 C:）时，固定路径候选会全部落空；注册表记录了本机所有 conda 环境位置，
 * 是最可靠的兜底发现方式。
 */
export function condaRegistryCandidates(
  home: string,
  condaEnv: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const registryPath = path.join(home, '.conda', 'environments.txt');
  let lines: string[];
  try {
    lines = fs
      .readFileSync(registryPath, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  const envPython = (root: string): string =>
    platform === 'win32'
      ? path.join(root, 'python.exe')
      : path.join(root, 'bin', 'python');
  for (const rawLine of lines) {
    const root = rawLine.trim();
    if (!root || path.basename(root) !== condaEnv) continue;
    const candidate = envPython(root);
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function isUsablePythonPath(candidate: string): boolean {
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

/** 按顺序返回第一个真实存在的候选 */
export function pickExistingPython(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && isUsablePythonPath(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 所有候选都不可用时降级为系统解释器名称并告警 */
export function systemPythonFallback(
  warnTag: string,
  envName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  console.warn(
    `${warnTag} ${envName} python not found; falling back to system python. ` +
      `Use the environment wizard (设置 → 环境检测与安装) to fix or override the interpreter.`,
  );
  return platform === 'win32' ? 'python' : 'python3';
}

/**
 * 真正校验「给定路径是否是可执行的 Python 解释器」：执行 `<path> --version`。
 *
 * 与 isUsablePythonPath 的区别在于后者只做 fs.existsSync，无法区分「文件存在但不是
 * Python」。这里供向导「手动指定解释器」做即时可用性反馈，不参与核心解释器解析。
 */
export async function validatePythonInterpreter(
  rawPath: string,
): Promise<PythonValidationResult> {
  const normalized = normalizePythonPath(rawPath);
  if (!normalized) return { state: 'empty' };
  if (!isUsablePythonPath(normalized)) {
    return { state: 'invalid', reason: '路径不存在' };
  }
  try {
    const { stdout, stderr } = await execFileAsync(normalized, ['--version'], {
      timeout: 8000,
      windowsHide: true,
    });
    // pythonw.exe 等无控制台解释器可能退出码 0 但无输出，仍视为可用（无版本号）。
    const version = /Python\s+(\d+\.\d+(?:\.\d+)?)/.exec(
      `${stdout}${stderr}`,
    )?.[1];
    return { state: 'valid', version };
  } catch {
    return {
      state: 'invalid',
      reason: '无法执行，可能不是有效的 Python 解释器',
    };
  }
}
