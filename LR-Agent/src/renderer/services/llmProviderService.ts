import { type LlmProviderConfig } from '../../shared/agentTypes';
import {
  createLlmProviderOnApi,
  deleteLlmProviderOnApi,
  fetchLlmProvidersFromApi,
  setDefaultLlmProviderOnApi,
  updateLlmProviderOnApi,
} from './llmProviderApi';

const DEFAULT_PROVIDER_KEY = 'lr-agent:defaultLlmProviderId';
const AUX_PROVIDER_KEY = 'lr-agent:auxiliaryLlmProviderId';

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

  if (saved.isDefault) {
    const updated = await setDefaultLlmProviderOnApi(saved.id);
    persistDefaultProviderId(updated.id);
    return updated;
  }
  return saved;
}

export async function removeLlmProvider(id: string): Promise<void> {
  await deleteLlmProviderOnApi(id);
}

export async function markDefaultLlmProvider(
  id: string,
): Promise<LlmProviderConfig> {
  const updated = await setDefaultLlmProviderOnApi(id);
  persistDefaultProviderId(updated.id);
  return updated;
}
