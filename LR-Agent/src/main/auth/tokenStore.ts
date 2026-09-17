import fs from 'fs-extra';
import { app, safeStorage } from 'electron';
import path from 'path';
import { isSecretStorageAvailable } from '../security/secretStore';

const TOKEN_FILE = 'refresh_token.dat';

function tokenFilePath(): string {
  return path.join(app.getPath('userData'), TOKEN_FILE);
}

/** 历史明文判断：仅接受可打印 ASCII，避免把密文误判为明文 */
function looksLikePlainToken(value: string): boolean {
  return (
    value.length > 0 && value.length < 8192 && /^[\x21-\x7e]+$/.test(value)
  );
}

export async function getRefreshToken(): Promise<string | null> {
  const filePath = tokenFilePath();
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  const buffer = await fs.readFile(filePath);
  // 失败关闭：safeStorage 不可用时绝不返回明文 token
  if (!isSecretStorageAvailable()) {
    return null;
  }

  try {
    return safeStorage.decryptString(buffer);
  } catch {
    // 兼容历史明文：读取一次后立即重写为密文
    const legacy = buffer.toString('utf-8');
    if (looksLikePlainToken(legacy)) {
      try {
        await setRefreshToken(legacy);
      } catch {
        // 迁移失败不阻断读取
      }
      return legacy;
    }
    return null;
  }
}

export async function setRefreshToken(token: string): Promise<void> {
  if (!isSecretStorageAvailable()) {
    throw new Error('secret_storage_unavailable');
  }
  const filePath = tokenFilePath();
  await fs.writeFile(filePath, safeStorage.encryptString(token));
}

export async function clearRefreshToken(): Promise<void> {
  const filePath = tokenFilePath();
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
}
