import fs from 'fs-extra';
import { app, safeStorage } from 'electron';
import path from 'path';
import { isSecretStorageAvailable } from '../security/secretStore';

const CACHE_FILE = 'session_cache.dat';

export interface LocalSessionCache {
  user: {
    id: string;
    email: string;
    email_verified: boolean;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    created_at: string;
  };
  lastOnlineAt: string;
  refreshTokenExp: number;
}

function cacheFilePath(): string {
  return path.join(app.getPath('userData'), CACHE_FILE);
}

async function readEncryptedJson(): Promise<LocalSessionCache | null> {
  const filePath = cacheFilePath();
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  const buffer = await fs.readFile(filePath);
  // 失败关闭：safeStorage 不可用时绝不返回明文缓存
  if (!isSecretStorageAvailable()) {
    return null;
  }

  let json: string;
  try {
    json = safeStorage.decryptString(buffer);
  } catch {
    // 兼容历史明文：读取一次后立即重写为密文
    const legacy = buffer.toString('utf-8').trim();
    if (!(legacy.startsWith('{') && legacy.endsWith('}'))) {
      return null;
    }
    try {
      const parsed = JSON.parse(legacy) as LocalSessionCache;
      try {
        await setSessionCache(parsed);
      } catch {
        // 迁移失败不阻断读取
      }
      return parsed;
    } catch {
      return null;
    }
  }

  try {
    return JSON.parse(json) as LocalSessionCache;
  } catch {
    return null;
  }
}

export async function getSessionCache(): Promise<LocalSessionCache | null> {
  return readEncryptedJson();
}

export async function setSessionCache(cache: LocalSessionCache): Promise<void> {
  if (!isSecretStorageAvailable()) {
    throw new Error('secret_storage_unavailable');
  }
  const filePath = cacheFilePath();
  const json = JSON.stringify(cache);
  await fs.writeFile(filePath, safeStorage.encryptString(json));
}

export async function clearSessionCache(): Promise<void> {
  const filePath = cacheFilePath();
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
}
