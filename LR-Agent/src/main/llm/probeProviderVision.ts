import * as providerRepo from '../db/providerRepository';
import { runVisionProbeRequest } from './visionProbe';

export async function probeAndPersistProviderVision(id: string) {
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

  const result = await runVisionProbeRequest({
    baseUrl: row.base_url,
    apiKey: row.api_key_encrypted,
    model: row.model,
  });

  const latest = providerRepo.getProvider(id);
  if (
    !latest ||
    latest.model !== row.model ||
    latest.base_url !== row.base_url
  ) {
    return latest ?? row;
  }

  const updated = providerRepo.updateProvider(id, {
    supportsVision: result.supportsVision,
    visionProbedAt: Date.now(),
    visionProbeDetail: result.detail,
  });
  if (!updated) {
    throw new Error('provider_not_found');
  }
  return updated;
}
