/**
 * Skill 脚本受控执行器（主进程）。
 *
 * Skill 附属 scripts/ 是模型可调用的一半自动化的"手脚"：此前只能读源码，
 * 这里补上受控执行入口。安全边界（纵深防御，逐层独立生效）：
 *   1. skill 名与脚本相对路径走 skillScanner 同款白名单，脚本必须位于
 *      <skill>/scripts/ 内（resolve + realpath 双重校验，防穿越 / 防 symlink 逃逸）；
 *   2. 解释器按扩展名分派（.py → 应用 Python 运行时，.sh → bash），
 *      其余扩展名拒绝；参数数组 spawn，不经 shell；
 *   3. cwd 优先当前工作区（脚本常需处理工作区数据），未打开工作区时回退 skill 目录；
 *   4. 输出环形缓冲截断（结果直接进模型上下文，避免撑爆预算）；
 *      超时强杀进程树。
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { killProcessTree, buildAgentSpawnEnv } from '../exec/processUtils';
import { getActiveWorkspaceRoot } from '../workspace/activeWorkspace';
import { getVenvPythonPath } from '../env/runtimeManager';
import {
  normalizeSkillRelativePath,
  resolveSkillDirPath,
} from './skillScanner';

/** 单次脚本输出上限（字符）：结果会作为 ToolMessage 进入模型上下文 */
export const MAX_SCRIPT_OUTPUT_CHARS = 8_000;
/** 默认超时：脚本定位为"说明书里的一个步骤"，长于 2 分钟视为挂死 */
export const SCRIPT_TIMEOUT_MS = 120_000;
/** 参数个数 / 单参长度上限 */
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4_096;
/** 与 skillScanner 一致的安全命名（用于区分 invalid_name / skill_not_found） */
const SKILL_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPathWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export type SkillScriptError =
  | 'invalid_name'
  | 'skill_not_found'
  | 'invalid_path'
  | 'script_not_found'
  | 'unsupported_type'
  | 'invalid_args'
  | 'spawn_failed';

export type SkillScriptRunResult =
  | {
      ok: true;
      exitCode: number | null;
      output: string;
      truncated: boolean;
      timedOut: boolean;
      durationMs: number;
      interpreter: string;
    }
  | { ok: false; error: SkillScriptError; message?: string };

export interface SkillScriptRunOptions {
  /** 超时毫秒数（默认 SCRIPT_TIMEOUT_MS） */
  timeoutMs?: number;
  /** 解释器覆盖（仅供测试注入 process.execPath，生产按扩展名分派） */
  interpreter?: string;
  /** skills 根目录覆盖（默认 ~/.agents/skills，仅供测试） */
  rootDir?: string;
}

/** .py 解释器：优先应用自带 local-agent venv（安装向导产物，必有可用依赖），退化系统 python */
function resolvePythonInterpreter(): string {
  try {
    const venvPython = getVenvPythonPath('local-agent');
    if (venvPython && fs.existsSync(venvPython)) return venvPython;
  } catch {
    // 运行时未就绪（如开发模式未 fetch runtime），走系统解释器
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function interpreterForScript(
  scriptPath: string,
  override?: string,
): string | null {
  if (override) return override;
  const ext = path.extname(scriptPath).toLowerCase();
  if (ext === '.py') return resolvePythonInterpreter();
  if (ext === '.sh') return 'bash';
  return null;
}

function finalizeOutput(
  output: string,
  streamTruncated: boolean,
): { output: string; truncated: boolean } {
  if (output.length <= MAX_SCRIPT_OUTPUT_CHARS && !streamTruncated) {
    return { output, truncated: false };
  }
  return {
    output: `${output.slice(0, MAX_SCRIPT_OUTPUT_CHARS)}\n…（输出过长已截断）`,
    truncated: true,
  };
}

/**
 * 执行 skill 捆绑脚本。
 * skillName 支持目录名或 frontmatter name（与 read_agent_skill 一致）；
 * script 为相对 skill 目录的路径，必须落在 scripts/ 内。
 */
export async function runSkillScript(
  skillName: string,
  script: string,
  args: string[] = [],
  options: SkillScriptRunOptions = {},
): Promise<SkillScriptRunResult> {
  const startedAt = Date.now();
  const fail = (
    error: SkillScriptError,
    message?: string,
  ): SkillScriptRunResult => ({ ok: false, error, message });

  // 1. 参数形状校验（MCP schema 已约束，这里兜底）
  if (
    !Array.isArray(args) ||
    args.length > MAX_ARGS ||
    args.some((arg) => typeof arg !== 'string' || arg.length > MAX_ARG_CHARS)
  ) {
    return fail('invalid_args');
  }

  // 2. skill 目录（复用 skillScanner 的命名白名单 + frontmatter 反查）
  const { rootDir } = options;
  const skillDir = await resolveSkillDirPath(skillName, rootDir);
  if (!skillDir) {
    return fail(
      SKILL_NAME_SHAPE.test(skillName.trim())
        ? 'skill_not_found'
        : 'invalid_name',
    );
  }

  // 3. 脚本路径：相对路径白名单 + 必须在 scripts/ 内 + realpath 防 symlink 逃逸
  const rel = normalizeSkillRelativePath(script);
  if (!rel || !rel.startsWith('scripts/')) return fail('invalid_path');
  const scriptPath = path.resolve(skillDir, ...rel.split('/'));
  if (!isPathWithin(scriptPath, skillDir)) return fail('invalid_path');
  try {
    const [realScript, realSkillDir] = await Promise.all([
      fs.realpath(scriptPath),
      fs.realpath(skillDir),
    ]);
    if (!isPathWithin(realScript, realSkillDir)) return fail('invalid_path');
    const stat = await fs.stat(realScript);
    if (!stat.isFile()) return fail('script_not_found');
  } catch {
    return fail('script_not_found');
  }

  // 4. 解释器分派
  const interpreter = interpreterForScript(scriptPath, options.interpreter);
  if (!interpreter) {
    return fail(
      'unsupported_type',
      '仅支持 .py 与 .sh 脚本（按扩展名分派解释器）',
    );
  }

  // 5. cwd：当前工作区优先，回退 skill 目录
  const cwd = getActiveWorkspaceRoot() ?? skillDir;

  return new Promise<SkillScriptRunResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(interpreter, [scriptPath, ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 强制 Python 子进程 UTF-8 输出：Windows 管道默认 cp936，会弄乱中文结果
        env: { ...buildAgentSpawnEnv(), PYTHONUTF8: '1' },
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      resolve(
        fail('spawn_failed', err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    let output = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(
      () => {
        timedOut = true;
        killProcessTree(child);
      },
      Math.max(1_000, options.timeoutMs ?? SCRIPT_TIMEOUT_MS),
    );

    const onChunk = (chunk: Buffer) => {
      if (output.length >= MAX_SCRIPT_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      output += chunk.toString('utf8');
      if (output.length > MAX_SCRIPT_OUTPUT_CHARS) {
        output = output.slice(0, MAX_SCRIPT_OUTPUT_CHARS);
        truncated = true;
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const finish = (result: SkillScriptRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (err) => {
      finish(fail('spawn_failed', err.message));
    });

    child.on('close', (exitCode) => {
      const finalized = finalizeOutput(output, truncated);
      finish({
        ok: true,
        exitCode,
        output: finalized.output,
        truncated: finalized.truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        interpreter,
      });
    });
  });
}
