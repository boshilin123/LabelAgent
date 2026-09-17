import * as providerRepo from '../db/providerRepository';
import { runContextProbeRequest } from './contextProbe';

export async function probeAndPersistProviderContext(id: string) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('provider_not_found');
  }
  const row = providerRepo.getProvider(id);
  if (!row) {
    throw new Error('provider_not_found');
  }
  if (row.enabled !== 1) {
    return row;
  }
  // 用户手填的窗口值优先，探测不覆盖
  if (row.context_window_source === 'manual') {
    return row;
  }

  const result = await runContextProbeRequest({
    baseUrl: row.base_url,
    apiKey: row.api_key_encrypted,
    model: row.model,
  });
  if (result.contextWindowTokens === null) {
    // 探测/推断都失败时保留现状，不把已有值抹掉
    return providerRepo.getProvider(id) ?? row;
  }

  const latest = providerRepo.getProvider(id);
  if (
    !latest ||
    latest.model !== row.model ||
    latest.base_url !== row.base_url
  ) {
    return latest ?? row;
  }

  const updated = providerRepo.updateProvider(id, {
    contextWindowTokens: result.contextWindowTokens,
    contextWindowSource: result.source,
  });
  if (!updated) {
    throw new Error('provider_not_found');
  }
  return updated;
}
