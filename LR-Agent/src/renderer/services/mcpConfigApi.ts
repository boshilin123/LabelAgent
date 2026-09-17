/**
 * MCP 配置 renderer 侧 API：封装 window.electron.mcp IPC 与 local-agent 测试连接。
 */
import type {
  McpConfig,
  McpPreset,
  McpProbeResult,
  McpServerConfig,
  McpServerInput,
  McpTransport,
} from '../../shared/mcpTypes';
import { localAgentFetch, resolveLocalAgentBaseUrl } from '../config';

export async function listMcpConfig(): Promise<McpConfig> {
  return (
    (await window.electron?.mcp?.listConfig?.().catch(() => null)) ?? {
      mcpServers: {},
    }
  );
}

export async function listMcpPresets(): Promise<McpPreset[]> {
  return (await window.electron?.mcp?.listPresets?.().catch(() => null)) ?? [];
}

export async function upsertMcpServer(
  input: McpServerInput,
): Promise<McpServerConfig | null> {
  const result = await window.electron?.mcp?.upsertServer?.(input);
  return result ?? null;
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  return (await window.electron?.mcp?.deleteServer?.(id)) ?? false;
}

export async function setMcpServerEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await window.electron?.mcp?.setEnabled?.(id, enabled);
}

export async function setMcpServerTools(
  id: string,
  patch: { lastTools?: string[]; disabledTools?: string[] },
): Promise<McpServerConfig | null> {
  const result = await window.electron?.mcp?.setTools?.(id, patch);
  return result ?? null;
}

/**
 * 测试连接：让本机 local-agent 直接连目标 MCP Server 并列出工具。
 * 不走 LLM；headers 只发往 127.0.0.1 的本机服务。
 */
export async function probeMcpServer(input: {
  url: string;
  transport: McpTransport;
  headers: Record<string, string>;
}): Promise<McpProbeResult> {
  try {
    const base = await resolveLocalAgentBaseUrl();
    const resp = await localAgentFetch(`${base}/agent/mcp/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: input.url,
        transport: input.transport,
        headers: input.headers,
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    return (await resp.json()) as McpProbeResult;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
