import type {
  EnvSettings,
  EnvironmentStatus,
  InstallProgress,
  InstallStartResult,
  InstallTarget,
  PythonValidationResult,
} from '../../shared/envTypes';

export const DEFAULT_BACKEND_BASE_URL = 'http://localhost:8000/api/v1';

export async function loadEnvironmentStatus(): Promise<EnvironmentStatus | null> {
  try {
    return window.electron?.env ? await window.electron.env.getStatus() : null;
  } catch {
    return null;
  }
}

export async function saveEnvSettings(
  patch: Partial<EnvSettings>,
): Promise<EnvSettings | null> {
  try {
    return window.electron?.env
      ? await window.electron.env.setSettings(patch)
      : null;
  } catch {
    return null;
  }
}

export async function startEnvironmentInstall(
  target: InstallTarget,
): Promise<InstallStartResult> {
  if (!window.electron?.env) {
    return { ok: false, error: '当前环境不支持一键安装' };
  }
  try {
    return await window.electron.env.installStart(target);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function cancelEnvironmentInstall(): Promise<boolean> {
  try {
    return (await window.electron?.env?.installCancel()) ?? false;
  } catch {
    return false;
  }
}

export async function loadInstallProgress(): Promise<InstallProgress | null> {
  try {
    return window.electron?.env
      ? await window.electron.env.installGetProgress()
      : null;
  } catch {
    return null;
  }
}

export async function completeFirstRun(): Promise<void> {
  await window.electron?.env?.completeFirstRun().catch(() => undefined);
}

export async function dismissFirstRun(): Promise<void> {
  await window.electron?.env?.dismissFirstRun().catch(() => undefined);
}

export async function showItemInFolder(itemPath: string): Promise<void> {
  if (!itemPath) return;
  await window.electron?.env?.showItemInFolder(itemPath).catch(() => undefined);
}

/** 真实校验解释器路径（主进程执行 --version），失败/无环境时返回 null */
export async function validatePythonInterpreter(
  pythonPath: string,
): Promise<PythonValidationResult | null> {
  try {
    return window.electron?.env
      ? await window.electron.env.validatePython(pythonPath)
      : null;
  } catch {
    return null;
  }
}

/** 弹出系统文件选择对话框选 Python 解释器，取消时返回 null */
export async function pickPythonInterpreter(): Promise<string | null> {
  if (!window.electron?.dialog) return null;
  try {
    return await window.electron.dialog.openFile({
      title: '选择 Python 解释器',
    });
  } catch {
    return null;
  }
}
