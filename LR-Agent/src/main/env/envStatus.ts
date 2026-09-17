/**
 * 环境状态聚合检测 — 环境向导 / 顶部横幅的数据源。
 *
 * 四项：后端连通性、local-agent 环境、inference 环境、模型清单。
 * 不改动机器状态；inference 检测会复用既有的运行时探针（懒 spawn ping）。
 */
import http from 'http';
import fs from 'fs-extra';
import {
  type BackendEnvStatus,
  type EnvironmentStatus,
  type InferenceEnvStatus,
  type LocalAgentEnvStatus,
  type ModelGroupStatus,
} from '../../shared/envTypes';
import { getEnvironmentConfig } from './envStore';
import { getVenvPythonPath, readInstallMarker } from './runtimeManager';
import {
  resolveLocalAgentPython,
  getLocalAgentBaseUrl,
} from '../localAgent/serverProcess';
import {
  checkInferenceRuntime,
  resolvePythonExecutable,
} from '../preAnnot/inferenceProcess';
import { getPretrainedModels } from '../pretrainedModels/pretrainedModelStore';

export const DEFAULT_BACKEND_BASE_URL = 'http://localhost:8000/api/v1';

function isUsablePython(pythonPath: string | null): boolean {
  if (!pythonPath) return false;
  try {
    return fs.existsSync(pythonPath);
  } catch {
    return false;
  }
}

function isVenvPath(
  target: 'local-agent' | 'inference',
  pythonPath: string | null,
): boolean {
  if (!pythonPath) return false;
  const venv = getVenvPythonPath(target);
  return (
    pythonPath.replace(/\\/g, '/').toLowerCase() ===
    venv.replace(/\\/g, '/').toLowerCase()
  );
}

async function hasInstalledVenv(
  target: 'local-agent' | 'inference',
): Promise<boolean> {
  return (
    isUsablePython(getVenvPythonPath(target)) &&
    (await readInstallMarker(target)) !== null
  );
}

/** 探测后端 /health（3s 超时）；<base 去掉尾部 /api/v1>/health */
async function probeBackend(baseUrl: string): Promise<BackendEnvStatus> {
  const root = baseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '');
  const url = `${root}/health`;
  const startedAt = Date.now();

  const reachable = await new Promise<boolean>((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });

  return {
    configuredUrl: baseUrl,
    reachable,
    latencyMs: reachable ? Date.now() - startedAt : undefined,
    error: reachable
      ? undefined
      : '后端不可达。离线模式仍可使用本地功能，或检查后端容器是否运行。',
  };
}

async function localAgentStatus(): Promise<LocalAgentEnvStatus> {
  const pythonPath = resolveLocalAgentPython();
  const pythonUsable = isUsablePython(pythonPath);
  const serviceUrl = getLocalAgentBaseUrl();
  return {
    pythonPath: pythonUsable ? pythonPath : null,
    pythonOk: pythonUsable,
    pythonFromVenv: isVenvPath('local-agent', pythonUsable ? pythonPath : null),
    depsInstalled: await hasInstalledVenv('local-agent'),
    serviceRunning: Boolean(serviceUrl),
    serviceUrl,
  };
}

async function buildEnvironmentStatus(): Promise<EnvironmentStatus> {
  const settings = getEnvironmentConfig();
  const backendUrl = settings.backendBaseUrl.trim() || DEFAULT_BACKEND_BASE_URL;
  const localAgent = await localAgentStatus();

  const inferencePythonPath = resolvePythonExecutable();
  const inferenceUsable = isUsablePython(inferencePythonPath);
  let inference: InferenceEnvStatus;
  try {
    const runtime = await checkInferenceRuntime();
    inference = {
      pythonPath: inferenceUsable ? inferencePythonPath : null,
      pythonOk: runtime.pythonOk || inferenceUsable,
      pythonFromVenv: isVenvPath('inference', inferencePythonPath),
      depsInstalled: await hasInstalledVenv('inference'),
      runtime,
    };
  } catch (err) {
    inference = {
      pythonPath: inferenceUsable ? inferencePythonPath : null,
      pythonOk: false,
      pythonFromVenv: isVenvPath('inference', inferencePythonPath),
      depsInstalled: await hasInstalledVenv('inference'),
      runtime: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let models: ModelGroupStatus[];
  try {
    const all = await getPretrainedModels();
    models = (
      ['object_detection', 'image_segmentation', 'keypoint_estimation'] as const
    ).map((modelType) => {
      const group = all.filter((m) => m.modelType === modelType);
      return {
        modelType,
        registered: group.length,
        enabled: group.filter((m) => m.enabled).length,
        checkpointPaths: group
          .map((m) => m.checkpointPath)
          .filter((p): p is string => Boolean(p)),
      };
    });
  } catch {
    models = [];
  }

  return {
    collectedAt: Date.now(),
    settings,
    backend: await probeBackend(backendUrl),
    localAgent,
    inference,
    models,
  };
}

export function getEnvironmentStatus(): Promise<EnvironmentStatus> {
  return buildEnvironmentStatus();
}
