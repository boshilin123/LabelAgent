/**
 * 远程 MCP Server 配置持久化（<userData>/mcp.json）。
 *
 * 读路径为同步缓存（Assist 每轮组 client_context 时同步取用），写路径异步落盘。
 * 本机 Electron MCP Server 不落此文件。
 */
import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import { app } from 'electron';
import {
  encryptSecret,
  isEncryptedSecret,
  tryDecryptSecret,
} from '../security/secretStore';
import {
  MCP_AUTO_ALLOWLIST_THRESHOLD,
  MCP_TRANSPORTS,
  type McpConfig,
  type McpServerConfig,
  type McpServerInput,
  type McpTransport,
} from '../../shared/mcpTypes';

export function defaultMcpConfig(): McpConfig {
  return { mcpServers: {} };
}

export function getMcpStorePath(): string {
  return path.join(app.getPath('userData'), 'mcp.json');
}

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function sanitizeTransport(value: unknown): McpTransport {
  return MCP_TRANSPORTS.includes(value as McpTransport)
    ? (value as McpTransport)
    : 'streamable_http';
}

function sanitizeHeaders(
  raw: unknown,
  options: { decrypt: boolean } = { decrypt: false },
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (name && typeof value === 'string' && value.trim()) {
      if (options.decrypt) {
        // headers 落盘时加密；解密失败则置空（失败关闭，不发送错误凭据）
        out[name] = tryDecryptSecret(value) ?? '';
      } else {
        out[name] = value;
      }
    }
  }
  return out;
}

function sanitizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || name.length > 128 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 200) break;
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeServer(
  id: string,
  raw: unknown,
  options: { decryptHeaders: boolean } = { decryptHeaders: false },
): McpServerConfig | null {
  if (!ID_PATTERN.test(id)) return null;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  if (!url || !isHttpUrl(url)) return null;
  const now = Date.now();
  return {
    id,
    name:
      typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : id,
    url,
    transport: sanitizeTransport(record.transport),
    headers: sanitizeHeaders(record.headers, {
      decrypt: options.decryptHeaders,
    }),
    enabled: record.enabled !== false,
    preset:
      typeof record.preset === 'string' && record.preset.trim()
        ? record.preset.trim()
        : null,
    disabledTools: sanitizeStringList(record.disabledTools),
    lastTools: sanitizeStringList(record.lastTools),
    createdAt:
      typeof record.createdAt === 'number' && record.createdAt > 0
        ? record.createdAt
        : now,
    updatedAt:
      typeof record.updatedAt === 'number' && record.updatedAt > 0
        ? record.updatedAt
        : now,
  };
}

function sanitizeConfig(raw: unknown): McpConfig {
  if (!raw || typeof raw !== 'object') return defaultMcpConfig();
  const serversRaw = (raw as Record<string, unknown>).mcpServers;
  const mcpServers: Record<string, McpServerConfig> = {};
  if (
    serversRaw &&
    typeof serversRaw === 'object' &&
    !Array.isArray(serversRaw)
  ) {
    for (const [id, serverRaw] of Object.entries(
      serversRaw as Record<string, unknown>,
    )) {
      const server = sanitizeServer(id, serverRaw, { decryptHeaders: true });
      if (server) mcpServers[id] = server;
    }
  }
  return { mcpServers };
}

let cached: McpConfig | null = null;

/** 同步读取（内存缓存优先），供组 client_context 等同步调用点使用 */
export function getMcpConfig(): McpConfig {
  if (cached) return cached;
  try {
    cached = sanitizeConfig(
      fs.readJsonSync(getMcpStorePath(), { throws: false }),
    );
  } catch {
    cached = defaultMcpConfig();
  }
  return cached;
}

function encryptHeadersForDisk(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value ? encryptSecret(value) : value;
  }
  return out;
}

/** 磁盘表示：header 值加密；内存缓存保持明文 */
function configForDisk(config: McpConfig): McpConfig {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([id, server]) => [
        id,
        { ...server, headers: encryptHeadersForDisk(server.headers) },
      ]),
    ),
  };
}

async function writeMcpConfig(config: McpConfig): Promise<McpConfig> {
  cached = config;
  const storePath = getMcpStorePath();
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, configForDisk(config), { spaces: 2 });
  return config;
}

/**
 * 幂等迁移：把 mcp.json 中仍为明文的 header 值加密回写。
 * 任何失败都不抛出，避免阻断启动。
 */
export async function migrateStoredMcpSecrets(): Promise<void> {
  const storePath = getMcpStorePath();
  let raw: unknown;
  try {
    raw = await fs.readJson(storePath, { throws: false });
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object') return;
  const config = sanitizeConfig(raw);
  if (Object.keys(config.mcpServers).length === 0) return;

  const needsWrite = Object.values(config.mcpServers).some((server) =>
    Object.values(server.headers).some((value) => !isEncryptedSecret(value)),
  );
  if (!needsWrite) {
    cached = config;
    return;
  }
  try {
    await writeMcpConfig(config);
  } catch (err) {
    console.error('[mcp] failed to migrate header secrets:', err);
  }
}

export function listMcpServers(): McpServerConfig[] {
  return Object.values(getMcpConfig().mcpServers).sort(
    (a, b) => a.createdAt - b.createdAt,
  );
}

/** Assist 发送时使用：仅已启用且 URL 合法的 server */
export function getEnabledMcpServers(): McpServerConfig[] {
  return listMcpServers().filter((server) => server.enabled && server.url);
}

function newServerId(existing: Record<string, McpServerConfig>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `srv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    if (!existing[id]) return id;
  }
  return `srv_${randomUUID().replace(/-/g, '')}`;
}

export async function upsertMcpServer(
  input: McpServerInput,
): Promise<McpServerConfig | null> {
  const config = getMcpConfig();
  const now = Date.now();
  const id = input.id && ID_PATTERN.test(input.id) ? input.id : undefined;
  const existing = id ? config.mcpServers[id] : undefined;
  const finalId = id ?? newServerId(config.mcpServers);
  const candidate = sanitizeServer(finalId, {
    ...existing,
    ...input,
    id: finalId,
    lastTools: input.lastTools ?? existing?.lastTools,
    disabledTools: input.disabledTools ?? existing?.disabledTools,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  if (!candidate) return null;
  const next: McpConfig = {
    mcpServers: { ...config.mcpServers, [finalId]: candidate },
  };
  await writeMcpConfig(next);
  return candidate;
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  const config = getMcpConfig();
  if (!config.mcpServers[id]) return false;
  const nextServers = { ...config.mcpServers };
  delete nextServers[id];
  await writeMcpConfig({ mcpServers: nextServers });
  return true;
}

export async function setMcpServerEnabled(
  id: string,
  enabled: boolean,
): Promise<McpServerConfig | null> {
  const config = getMcpConfig();
  const existing = config.mcpServers[id];
  if (!existing) return null;
  const next: McpServerConfig = { ...existing, enabled, updatedAt: Date.now() };
  await writeMcpConfig({
    mcpServers: { ...config.mcpServers, [id]: next },
  });
  return next;
}

export async function setMcpServerTools(
  id: string,
  patch: { lastTools?: string[]; disabledTools?: string[] },
): Promise<McpServerConfig | null> {
  const config = getMcpConfig();
  const existing = config.mcpServers[id];
  if (!existing) return null;
  const lastTools =
    patch.lastTools !== undefined
      ? sanitizeStringList(patch.lastTools)
      : existing.lastTools;
  // 阈值自动白名单：大 server 新探测到的工具默认关闭，已有工具与显式传参不受影响
  // （「全部开启」按钮走 disabledTools 分支，传空数组即全开）。
  const disabledTools =
    patch.disabledTools !== undefined
      ? sanitizeStringList(patch.disabledTools)
      : resolveAutoAllowlistDisabledTools(existing, lastTools, patch.lastTools);
  const next: McpServerConfig = {
    ...existing,
    lastTools,
    disabledTools,
    updatedAt: Date.now(),
  };
  await writeMcpConfig({
    mcpServers: { ...config.mcpServers, [id]: next },
  });
  return next;
}

/**
 * 新发现工具的默认开关状态。
 *
 * 只有本次带 lastTools（即 probe 结果）且工具总数超过阈值时，才把「既不在旧 lastTools
 * 也不在 disabledTools 里」的工具追加进 disabledTools；其余情况保持原状。
 */
function resolveAutoAllowlistDisabledTools(
  existing: McpServerConfig,
  lastTools: string[],
  patchLastTools: string[] | undefined,
): string[] {
  if (patchLastTools === undefined) return existing.disabledTools;
  if (lastTools.length <= MCP_AUTO_ALLOWLIST_THRESHOLD) {
    return existing.disabledTools;
  }
  const known = new Set([...existing.lastTools, ...existing.disabledTools]);
  const discovered = lastTools.filter((name) => !known.has(name));
  if (discovered.length === 0) return existing.disabledTools;
  return sanitizeStringList([...existing.disabledTools, ...discovered]);
}

/** 仅测试用 */
export function resetMcpConfigCache(): void {
  cached = null;
}
