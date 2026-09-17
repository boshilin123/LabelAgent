/**
 * 统一凭据加解密（基于 Electron safeStorage）。
 *
 * 存储格式：`v1:<base64(ciphertext)>`；历史明文（无前缀）在解密时原样返回，
 * 以便幂等迁移。safeStorage 不可用时**失败关闭**：加密抛错、解密抛错，
 * 绝不静默降级为明文落盘。
 */
import { safeStorage } from 'electron';

const VERSION_PREFIX = 'v1:';

/** 当前凭据版本标识（写入 encryption_key_id） */
export const SECRET_VERSION_KEY_ID = 'v1';

export function isSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(VERSION_PREFIX);
}

/** 加密为带版本前缀的字符串；safeStorage 不可用时抛错（失败关闭） */
export function encryptSecret(plain: string): string {
  if (!isSecretStorageAvailable()) {
    throw new Error('secret_storage_unavailable');
  }
  const encrypted = safeStorage.encryptString(plain);
  return `${VERSION_PREFIX}${encrypted.toString('base64')}`;
}

/** 解密；对历史明文（无前缀）原样返回；safeStorage 不可用时抛错 */
export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) {
    return stored;
  }
  if (!isSecretStorageAvailable()) {
    throw new Error('secret_storage_unavailable');
  }
  const base64 = stored.slice(VERSION_PREFIX.length);
  return safeStorage.decryptString(Buffer.from(base64, 'base64'));
}

/** 读取路径使用：解密失败返回 null，避免单条坏数据阻断整体读取 */
export function tryDecryptSecret(stored: string): string | null {
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}
