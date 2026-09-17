import { LocalSessionCache, TokenResponse, UserPublic } from '../types/auth';
import tokenHolder from './tokenHolder';
import { decodeJwtPayload, isRefreshTokenExpiredLocally } from './jwtUtils';

function getAuthBridge() {
  return window.electron?.auth ?? null;
}

export async function writeSessionCache(
  user: UserPublic,
  refreshToken: string,
): Promise<void> {
  const auth = getAuthBridge();
  if (!auth) {
    return;
  }
  const payload = decodeJwtPayload(refreshToken);
  const refreshTokenExp = payload?.exp;
  if (!refreshTokenExp) {
    return;
  }

  const cache: LocalSessionCache = {
    user,
    lastOnlineAt: new Date().toISOString(),
    refreshTokenExp,
  };
  await auth.setSessionCache(cache);
}

export async function readValidSessionCache(): Promise<LocalSessionCache | null> {
  const cache = (await getAuthBridge()?.getSessionCache()) ?? null;
  if (!cache) {
    return null;
  }
  if (isRefreshTokenExpiredLocally(cache.refreshTokenExp)) {
    return null;
  }
  return cache;
}

export async function persistSession(result: TokenResponse): Promise<void> {
  tokenHolder.setAccessToken(result.access_token);
  const auth = getAuthBridge();
  if (!auth) {
    return;
  }
  await auth.setRefreshToken(result.refresh_token);
  await writeSessionCache(result.user, result.refresh_token);
}

export async function clearSession(): Promise<void> {
  tokenHolder.setAccessToken(null);
  const auth = getAuthBridge();
  if (!auth) {
    return;
  }
  await auth.clearRefreshToken();
  await auth.clearSessionCache();
}
