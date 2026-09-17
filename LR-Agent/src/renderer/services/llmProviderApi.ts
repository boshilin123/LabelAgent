import type { LlmProviderConfig } from '../../shared/agentTypes';

function getDb() {
  return (
    window as unknown as {
      electron: {
        db: {
          providers: {
            list: () => Promise<ProviderRow[]>;
            get: (id: string) => Promise<ProviderRow | undefined>;
            create: (p: CreateProviderParams) => Promise<ProviderRow>;
            update: (
              id: string,
              patch: Record<string, unknown>,
            ) => Promise<ProviderRow | undefined>;
            delete: (id: string) => Promise<void>;
            setDefault: (id: string) => Promise<ProviderRow>;
            getDefault: () => Promise<ProviderRow | undefined>;
            probeVision: (id: string) => Promise<ProviderRow>;
            probeContext: (id: string) => Promise<ProviderRow>;
          };
        };
      };
    }
  ).electron.db;
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key_encrypted: string;
  encryption_key_id: string;
  model: string;
  enabled: number;
  is_default: number;
  supports_vision: number;
  vision_probed_at: number | null;
  vision_probe_detail: string;
  context_window_tokens: number | null;
  context_window_source: string;
  created_at: number;
  updated_at: number;
}

interface CreateProviderParams {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEncrypted: string;
  encryptionKeyId?: string;
  model: string;
  enabled?: boolean;
  isDefault?: boolean;
  supportsVision?: boolean;
  contextWindowTokens?: number | null;
  contextWindowSource?: string;
}

// ── Mappers ───────────────────────────────────────────────────────

function rowToConfig(row: ProviderRow): LlmProviderConfig {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: row.api_key_encrypted,
    model: row.model,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    supportsVision: row.supports_vision === 1,
    visionProbedAt: row.vision_probed_at,
    visionProbeDetail: row.vision_probe_detail ?? '',
    contextWindowTokens: row.context_window_tokens ?? null,
    contextWindowSource:
      (row.context_window_source as LlmProviderConfig['contextWindowSource']) ??
      '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function configToCreateParams(config: LlmProviderConfig): CreateProviderParams {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    apiKeyEncrypted: config.apiKey,
    encryptionKeyId: 'v1',
    model: config.model,
    enabled: config.enabled,
    isDefault: config.isDefault,
    supportsVision: config.supportsVision,
    contextWindowTokens: config.contextWindowTokens ?? null,
    contextWindowSource: config.contextWindowSource ?? '',
  };
}

function configToUpdatePatch(
  config: LlmProviderConfig,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    name: config.name,
    baseUrl: config.baseUrl,
    apiKeyEncrypted: config.apiKey,
    model: config.model,
    enabled: config.enabled,
    isDefault: config.isDefault,
    supportsVision: config.supportsVision,
  };
  if (config.visionProbedAt !== undefined) {
    patch.visionProbedAt = config.visionProbedAt;
  }
  if (config.visionProbeDetail !== undefined) {
    patch.visionProbeDetail = config.visionProbeDetail;
  }
  if (config.contextWindowTokens !== undefined) {
    patch.contextWindowTokens = config.contextWindowTokens;
    patch.contextWindowSource = config.contextWindowSource ?? '';
  }
  return patch;
}

// ── Public API ────────────────────────────────────────────────────

export async function fetchLlmProvidersFromApi(): Promise<LlmProviderConfig[]> {
  const db = getDb();
  const rows = await db.providers.list();
  return rows.map(rowToConfig);
}

export async function createLlmProviderOnApi(
  provider: LlmProviderConfig,
): Promise<LlmProviderConfig> {
  const db = getDb();
  const row = await db.providers.create(configToCreateParams(provider));
  return rowToConfig(row);
}

export async function updateLlmProviderOnApi(
  provider: LlmProviderConfig,
): Promise<LlmProviderConfig> {
  const db = getDb();
  const row = await db.providers.update(
    provider.id,
    configToUpdatePatch(provider),
  );
  return rowToConfig(row!);
}

export async function deleteLlmProviderOnApi(id: string): Promise<void> {
  const db = getDb();
  await db.providers.delete(id);
}

export async function setDefaultLlmProviderOnApi(
  id: string,
): Promise<LlmProviderConfig> {
  const db = getDb();
  const row = await db.providers.setDefault(id);
  return rowToConfig(row);
}

export async function probeLlmProviderVisionOnApi(
  id: string,
): Promise<LlmProviderConfig> {
  const db = getDb();
  const row = await db.providers.probeVision(id);
  if (!row) {
    throw new Error('provider_not_found');
  }
  return rowToConfig(row);
}

export async function probeLlmProviderContextOnApi(
  id: string,
): Promise<LlmProviderConfig> {
  const db = getDb();
  const row = await db.providers.probeContext(id);
  if (!row) {
    throw new Error('provider_not_found');
  }
  return rowToConfig(row);
}
