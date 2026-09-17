/**
 * 受限终端命令 IPC handlers。
 *
 * 渲染层（agentJobRegistry 的 runClientTool）在用户聊天内批准后调用；
 * 输出事件经节流合并后推给渲染层，避免 pip install 类高频输出淹没 IPC。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  getTerminalJob,
  killTerminalJob,
  startTerminalJob,
  subscribeTerminalEvents,
  killAllTerminalJobs,
  type TerminalEvent,
} from '../exec/commandJobManager';

/** 输出事件节流间隔（毫秒） */
const FLUSH_INTERVAL_MS = 150;

export function registerTerminalHandlers(): void {
  ipcMain.handle(
    'agent:terminal:start',
    (
      _event,
      payload: { command?: unknown; args?: unknown; timeoutMs?: unknown },
    ) => {
      if (
        !payload ||
        typeof payload.command !== 'string' ||
        (payload.args !== undefined && !Array.isArray(payload.args))
      ) {
        return { ok: false as const, error: 'invalid_command' as const };
      }
      return startTerminalJob({
        command: payload.command,
        args: payload.args?.map(String),
        timeoutMs:
          typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined,
      });
    },
  );

  ipcMain.handle('agent:terminal:read', (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') return { ok: false, error: 'job_not_found' };
    const snapshot = getTerminalJob(jobId);
    if (!snapshot) return { ok: false, error: 'job_not_found' };
    return { ok: true, snapshot };
  });

  ipcMain.handle('agent:terminal:kill', (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') return false;
    return killTerminalJob(jobId);
  });

  // 输出事件节流合并后广播给渲染层
  const pending = new Map<string, { text: string; timer: NodeJS.Timeout }>();
  const broadcast = (payload: unknown): void => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('agent:terminal:event', payload);
    });
  };
  const flush = (jobId: string): void => {
    const entry = pending.get(jobId);
    if (!entry) return;
    pending.delete(jobId);
    if (entry.text) {
      broadcast({ type: 'output', jobId, chunk: entry.text });
    }
  };
  const unsubscribe = subscribeTerminalEvents((event: TerminalEvent) => {
    if (event.type === 'output') {
      const entry = pending.get(event.jobId) ?? {
        text: '',
        timer: null as unknown as NodeJS.Timeout,
      };
      entry.text += event.chunk;
      if (!entry.timer) {
        entry.timer = setTimeout(() => flush(event.jobId), FLUSH_INTERVAL_MS);
      }
      pending.set(event.jobId, entry);
      return;
    }
    // exit：把残留 chunk 立即冲掉再发终态
    flush(event.jobId);
    broadcast({
      type: 'exit',
      jobId: event.jobId,
      status: event.snapshot.status,
      exitCode: event.snapshot.exitCode,
    });
  });
  app.on('will-quit', () => {
    unsubscribe();
    pending.forEach((entry) => clearTimeout(entry.timer));
    pending.clear();
    killAllTerminalJobs();
  });
}
