import { type LlmProviderConfig } from '../../shared/agentTypes';
import {
  createLlmProviderOnApi,
  deleteLlmProviderOnApi,
  fetchLlmProvidersFromApi,
  probeLlmProviderContextOnApi,
  setDefaultLlmProviderOnApi,
  updateLlmProviderOnApi,
} from './llmProviderApi';

const DEFAULT_PROVIDER_KEY = 'lr-agent:defaultLlmProviderId';
const AUX_PROVIDER_KEY = 'lr-agent:auxiliaryLlmProviderId';

const CONTEXT_PROBE_CACHE_MS = 5 * 60_000;
const contextProbes = new Map<
  string,
  {
    model: string;
    baseUrl: string;
    startedAt: number;
    result: Promise<LlmProviderConfig>;
  }
>();

export function invalidateLlmProviderContext(id?: string): void {
  if (id) contextProbes.delete(id);
  else contextProbes.clear();
}

/** 发送前读取 /models 的真实窗口；手填值优先，探测失败保留现值，短时复用结果。 */
export async function ensureLlmProviderContext(
  provider: LlmProviderConfig,
): Promise<LlmProviderConfig> {
  if (!provider.enabled || provider.contextWindowSource === 'manual') {
    return provider;
  }
  const cached = contextProbes.get(provider.id);
  if (
    cached &&
    cached.model === provider.model &&
    cached.baseUrl === provider.baseUrl &&
    Date.now() - cached.startedAt < CONTEXT_PROBE_CACHE_MS &&
    provider.updatedAt <= cached.startedAt
  ) {
    return cached.result;
  }
  const result = probeLlmProviderContextOnApi(provider.id)
    .then((updated) => {
      if (
        updated.model !== provider.model ||
        updated.baseUrl !== provider.baseUrl
      ) {
        return provider;
      }
      // 只更新窗口元数据；本轮的模型、凭据等继续使用发送时的快照。
      return {
        ...provider,
        contextWindowTokens: updated.contextWindowTokens,
        contextWindowSource: updated.contextWindowSource,
      };
    })
    .catch(() => provider);
  contextProbes.set(provider.id, {
    model: provider.model,
    baseUrl: provider.baseUrl,
    startedAt: Date.now(),
    result,
  });
  return result;
}

export function buildEmptyProvider(): LlmProviderConfig {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: '',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: true,
    isDefault: false,
    supportsVision: false,
    visionProbedAt: null,
    visionProbeDetail: '',
    contextWindowTokens: null,
    contextWindowSource: '',
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadLlmProviders(): Promise<LlmProviderConfig[]> {
  return fetchLlmProvidersFromApi();
}

export function loadDefaultProviderId(): string | null {
  return localStorage.getItem(DEFAULT_PROVIDER_KEY);
}

export function persistDefaultProviderId(id: string | null): void {
  if (id) {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, id);
  } else {
    localStorage.removeItem(DEFAULT_PROVIDER_KEY);
  }
}

export function getEnabledProviders(
  providers: LlmProviderConfig[],
): LlmProviderConfig[] {
  return providers.filter((item) => item.enabled);
}

export function resolveDefaultProvider(
  providers: LlmProviderConfig[],
): LlmProviderConfig | null {
  const enabled = getEnabledProviders(providers);
  if (enabled.length === 0) return null;
  const storedId = loadDefaultProviderId();
  const stored = storedId ? enabled.find((item) => item.id === storedId) : null;
  if (stored) return stored;
  return enabled.find((item) => item.isDefault) ?? enabled[0] ?? null;
}

export function loadAuxiliaryProviderId(): string | null {
  return localStorage.getItem(AUX_PROVIDER_KEY);
}

export function persistAuxiliaryProviderId(id: string | null): void {
  if (id) {
    localStorage.setItem(AUX_PROVIDER_KEY, id);
  } else {
    localStorage.removeItem(AUX_PROVIDER_KEY);
  }
}

/**
 * 辅助模型：用于子代理查阅、上下文摘要等轻量调用。
 * 未配置、已删除或已禁用时返回 null（调用方回退为跟随会话模型）。
 */
export function resolveAuxiliaryProvider(
  providers: LlmProviderConfig[],
): LlmProviderConfig | null {
  const storedId = loadAuxiliaryProviderId();
  if (!storedId) return null;
  const match = providers.find((item) => item.id === storedId);
  return match && match.enabled ? match : null;
}

export async function upsertLlmProvider(
  providers: LlmProviderConfig[],
  provider: LlmProviderConfig,
  isNew: boolean,
): Promise<LlmProviderConfig> {
  const saved = isNew
    ? await createLlmProviderOnApi(provider)
    : await updateLlmProviderOnApi(provider);
  invalidateLlmProviderContext(provider.id);

  if (saved.isDefault) {
    const updated = await setDefaultLlmProviderOnApi(saved.id);
    persistDefaultProviderId(updated.id);
    return updated;
  }
  return saved;
}

export async function removeLlmProvider(id: string): Promise<void> {
  invalidateLlmProviderContext(id);
  await deleteLlmProviderOnApi(id);
}

export async function markDefaultLlmProvider(
  id: string,
): Promise<LlmProviderConfig> {
  const updated = await setDefaultLlmProviderOnApi(id);
  persistDefaultProviderId(updated.id);
  return updated;
}
