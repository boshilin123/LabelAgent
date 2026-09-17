/**
 * 主进程进程控制公共工具（envInstaller / skillScriptRunner / commandJobManager 共用）。
 */
import { spawn, type ChildProcess } from 'child_process';

/**
 * 杀掉整棵进程树：Windows 用 taskkill /T /F；POSIX 杀进程组
 * （要求 spawn 时 detached，否则退化为只杀直接子进程）。
 */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      child.kill();
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * Agent 驱动的子进程环境净化。
 *
 * dev 模式下主进程继承的 NODE_OPTIONS（如 webpack 的 ts-node 预加载）会
 * 破坏任意裸 node 命令；Electron 运行时变量同样不该泄漏给用户命令。
 */
export function buildAgentSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}
