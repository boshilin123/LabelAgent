/**
 * MCP 配置模块 IPC：远程 server 增删改查、开关、广场预设、已启用列表。
 * 本机 MCP Server 的 URL 查询（mcp:getServerUrl）仍在 main.ts 中注册。
 */
import { ipcMain } from 'electron';
import type { McpServerInput } from '../../shared/mcpTypes';
import { MCP_PRESETS } from '../../shared/mcpPresets';
import {
  deleteMcpServer,
  getEnabledMcpServers,
  getMcpConfig,
  setMcpServerEnabled,
  setMcpServerTools,
  upsertMcpServer,
} from './mcpStore';

function sanitizeInput(raw: unknown): McpServerInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name.trim()) return null;
  if (typeof record.url !== 'string' || !record.url.trim()) return null;
  const headers: Record<string, string> = {};
  if (record.headers && typeof record.headers === 'object') {
    for (const [key, value] of Object.entries(
      record.headers as Record<string, unknown>,
    )) {
      if (typeof value === 'string') headers[key] = value;
    }
  }
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    name: record.name,
    url: record.url,
    transport: record.transport === 'sse' ? 'sse' : 'streamable_http',
    headers,
    enabled: record.enabled !== false,
    preset: typeof record.preset === 'string' ? record.preset : null,
  };
}

export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:listConfig', () => getMcpConfig());

  ipcMain.handle('mcp:listPresets', () => MCP_PRESETS);

  ipcMain.handle('mcp:getEnabledServers', () => getEnabledMcpServers());

  ipcMain.handle('mcp:upsertServer', async (_event, raw: unknown) => {
    const input = sanitizeInput(raw);
    if (!input) return null;
    return upsertMcpServer(input);
  });

  ipcMain.handle('mcp:deleteServer', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id.trim()) return false;
    return deleteMcpServer(id.trim());
  });

  ipcMain.handle(
    'mcp:setEnabled',
    async (_event, id: unknown, enabled: unknown) => {
      if (typeof id !== 'string' || !id.trim()) return null;
      return setMcpServerEnabled(id.trim(), enabled === true);
    },
  );

  ipcMain.handle(
    'mcp:setTools',
    async (_event, id: unknown, patch: unknown) => {
      if (typeof id !== 'string' || !id.trim()) return null;
      if (!patch || typeof patch !== 'object') return null;
      const record = patch as Record<string, unknown>;
      return setMcpServerTools(id.trim(), {
        lastTools: Array.isArray(record.lastTools)
          ? (record.lastTools as string[])
          : undefined,
        disabledTools: Array.isArray(record.disabledTools)
          ? (record.disabledTools as string[])
          : undefined,
      });
    },
  );
}
