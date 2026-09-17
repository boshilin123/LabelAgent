/**
 * 凭据存储的幂等迁移（provider API key 与 MCP header）。
 *
 * 对历史明文值加密回写为 v1；任何单行/单步失败都只记录日志，不阻断启动。
 */
import { getDatabase } from '../db/database';
import { migrateStoredMcpSecrets } from '../mcp/mcpStore';
import {
  SECRET_VERSION_KEY_ID,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from './secretStore';

interface ProviderSecretRow {
  id: string;
  api_key_encrypted: string;
  encryption_key_id: string;
}

/** 幂等迁移 llm_providers 中仍为明文的 api key */
export function migrateProviderSecrets(): void {
  let rows: ProviderSecretRow[];
  try {
    rows = getDatabase().all(
      'SELECT id, api_key_encrypted, encryption_key_id FROM llm_providers',
    ) as unknown as ProviderSecretRow[];
  } catch (err) {
    console.error('[security] provider secret migration skipped:', err);
    return;
  }

  for (const row of rows) {
    try {
      if (
        row.encryption_key_id === SECRET_VERSION_KEY_ID &&
        isEncryptedSecret(row.api_key_encrypted)
      ) {
        continue;
      }
      const plain = isEncryptedSecret(row.api_key_encrypted)
        ? decryptSecret(row.api_key_encrypted)
        : row.api_key_encrypted;
      const encrypted = encryptSecret(plain ?? '');
      getDatabase().run(
        'UPDATE llm_providers SET api_key_encrypted = ?, encryption_key_id = ? WHERE id = ?',
        encrypted,
        SECRET_VERSION_KEY_ID,
        row.id,
      );
    } catch (err) {
      console.error(`[security] failed to migrate provider ${row.id}:`, err);
    }
  }
}

export async function migrateSecrets(): Promise<void> {
  migrateProviderSecrets();
  await migrateStoredMcpSecrets();
}
