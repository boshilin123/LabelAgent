/**
 * 环境配置持久化（<userData>/environment.json）。
 *
 * 存储环境向导的运行时配置：自定义后端地址、pip 镜像源、
 * Python 解释器覆盖以及首次引导完成/跳过标记。
 * 读路径为同步缓存（服务 spawn 时同步解析 python 需要），写路径异步落盘。
 */
import path from 'path';
import fs from 'fs-extra';
import { app } from 'electron';
import type { EnvSettings } from '../../shared/envTypes';

export function defaultEnvSettings(): EnvSettings {
  return {
    backendBaseUrl: '',
    pipIndexUrl: '',
    localAgentPythonOverride: '',
    inferencePythonOverride: '',
    firstRunCompleted: false,
    firstRunDismissedAt: null,
    firstRunSeenAt: null,
  };
}

export function getEnvironmentStorePath(): string {
  return path.join(app.getPath('userData'), 'environment.json');
}

let cached: EnvSettings | null = null;

function sanitize(raw: unknown): EnvSettings {
  const base = defaultEnvSettings();
  if (!raw || typeof raw !== 'object') return base;
  const record = raw as Record<string, unknown>;
  const asString = (value: unknown): string =>
    typeof value === 'string' ? value : '';
  return {
    backendBaseUrl: asString(record.backendBaseUrl),
    pipIndexUrl: asString(record.pipIndexUrl),
    localAgentPythonOverride: asString(record.localAgentPythonOverride),
    inferencePythonOverride: asString(record.inferencePythonOverride),
    firstRunCompleted: record.firstRunCompleted === true,
    firstRunDismissedAt:
      typeof record.firstRunDismissedAt === 'string'
        ? record.firstRunDismissedAt
        : null,
    firstRunSeenAt:
      typeof record.firstRunSeenAt === 'string' ? record.firstRunSeenAt : null,
  };
}

/** 同步读取（内存缓存优先），供解释器解析等同步调用点使用 */
export function getEnvironmentConfig(): EnvSettings {
  if (cached) return cached;
  try {
    cached = sanitize(
      fs.readJsonSync(getEnvironmentStorePath(), { throws: false }),
    );
  } catch {
    cached = defaultEnvSettings();
  }
  return cached;
}

export async function updateEnvironmentConfig(
  patch: Partial<EnvSettings>,
): Promise<EnvSettings> {
  const next = sanitize({ ...getEnvironmentConfig(), ...patch });
  cached = next;
  const storePath = getEnvironmentStorePath();
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, next, { spaces: 2 });
  return next;
}

/** 仅测试用 */
export function resetEnvironmentConfigCache(): void {
  cached = null;
}
