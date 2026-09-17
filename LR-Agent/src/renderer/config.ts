/**
 * API 地址配置。
 *
 * - `API_BASE_URL`：云端 LR-Agent-backend（仅 auth / users 账号体系）
 * - `LOCAL_AGENT_BASE_URL`：本机 LR-Agent-local（Agent 编排：Assist / 标注 / 质量报告）
 *
 * 本地 Agent 服务由 Electron 主进程 spawn，端口随机分配；
 * renderer 通过 IPC（window.electron.localAgent.getBaseUrl）获取实际地址。
 */

export const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:8000/api/v1';

/** 本地 Agent 服务默认地址（IPC 不可用时的回退，对应 local_main.py 默认端口） */
export const LOCAL_AGENT_DEFAULT_BASE_URL = 'http://127.0.0.1:8765/api/v1';

export const REMEMBERED_EMAIL_KEY = 'lr-agent:remembered-email';

// 运行时覆盖：由 environment.json（环境向导持久化的 backendBaseUrl）引导期注入，
// 优先于编译期 API_BASE_URL；更换后端地址后需重新登录才会作用于账户会话。
let apiBaseUrlOverride: string | null = null;

/** 设置后端地址运行时覆盖（空值清除覆盖，恢复默认） */
export function setApiBaseUrlOverride(url: string | null): void {
  apiBaseUrlOverride = url?.trim() || null;
}

/** Resolve API base URL; uses page hostname for LAN/mobile verify flows. */
export function resolveApiBaseUrl(): string {
  if (apiBaseUrlOverride) {
    return apiBaseUrlOverride;
  }
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL;
  }
  if (typeof window !== 'undefined' && window.location.hostname) {
    return `http://${window.location.hostname}:8000/api/v1`;
  }
  return API_BASE_URL;
}

let cachedLocalAgentBaseUrl: string | null = null;
let cachedLocalAgentToken: string | null = null;

async function queryLocalAgentEndpoint(): Promise<{
  url: string;
  token: string;
} | null> {
  if (typeof window === 'undefined') return null;
  return (
    (await window.electron?.localAgent?.getBaseUrl?.().catch(() => null)) ??
    null
  );
}

/**
 * 解析本地 Agent 服务 base URL 与访问 token。
 *
 * 优先使用 Electron main 进程持有的实际监听地址（随机端口）；
 * 服务尚未就绪时短暂重试；IPC 不可用（如纯 Web 调试）时回退默认端口（此时无 token）。
 */
export async function resolveLocalAgentAuth(options?: {
  retries?: number;
  intervalMs?: number;
}): Promise<{ baseUrl: string; token: string | null }> {
  if (cachedLocalAgentBaseUrl) {
    return { baseUrl: cachedLocalAgentBaseUrl, token: cachedLocalAgentToken };
  }

  const retries = options?.retries ?? 10;
  const intervalMs = options?.intervalMs ?? 500;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await queryLocalAgentEndpoint();
    if (result) {
      cachedLocalAgentBaseUrl = result.url;
      cachedLocalAgentToken = result.token;
      return { baseUrl: result.url, token: result.token };
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return { baseUrl: LOCAL_AGENT_DEFAULT_BASE_URL, token: null };
}

/**
 * 解析本地 Agent 服务 base URL。
 *
 * 优先使用 Electron main 进程持有的实际监听地址（随机端口）；
 * 服务尚未就绪时短暂重试；IPC 不可用（如纯 Web 调试）时回退默认端口。
 */
export async function resolveLocalAgentBaseUrl(options?: {
  retries?: number;
  intervalMs?: number;
}): Promise<string> {
  const { baseUrl } = await resolveLocalAgentAuth(options);
  return baseUrl;
}

/**
 * 携带本地服务 Bearer token 的 fetch 封装。
 * 所有发往 LR-Agent-local 的请求都应经此发出（否则服务返回 401）。
 */
export async function localAgentFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  if (!cachedLocalAgentToken) {
    await resolveLocalAgentAuth();
  }
  const headers = new Headers(init?.headers);
  if (cachedLocalAgentToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${cachedLocalAgentToken}`);
  }
  return fetch(input, { ...init, headers });
}
