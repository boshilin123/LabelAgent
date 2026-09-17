import {
  MessageResponse,
  RestoreSessionResult,
  TokenResponse,
} from '../types/auth';
import { resolveApiBaseUrl } from '../config';
import tokenHolder from './tokenHolder';
import { apiFetch } from './api';
import { isNetworkError } from './networkUtils';
import {
  clearSession,
  persistSession,
  readValidSessionCache,
} from './sessionPersistence';
import { decodeJwtPayload, isRefreshTokenExpiredLocally } from './jwtUtils';

async function getStoredRefreshToken(): Promise<string | null> {
  return (await window.electron?.auth?.getRefreshToken()) ?? null;
}

async function refreshWithToken(refreshToken: string): Promise<TokenResponse> {
  try {
    const result = await apiFetch<TokenResponse>('/auth/refresh', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    await persistSession(result);
    return result;
  } catch (err) {
    if (isNetworkError(err)) {
      throw err;
    }
    await clearSession();
    throw err;
  }
}

export async function register(email: string, password: string): Promise<void> {
  await apiFetch<MessageResponse>('/auth/register', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ email, password }),
  });
}

export async function resendVerificationEmail(): Promise<void> {
  await apiFetch<MessageResponse>('/auth/resend-verification-email', {
    method: 'POST',
  });
}

export async function verifyEmail(token: string): Promise<void> {
  const response = await fetch(`${resolveApiBaseUrl()}/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    let detail = 'request_failed';
    try {
      const body = (await response.json()) as { detail?: string };
      if (typeof body.detail === 'string') {
        detail = body.detail;
      }
    } catch {
      detail = response.statusText || detail;
    }
    throw new Error(detail);
  }
}

export async function forgotPassword(email: string): Promise<void> {
  await apiFetch<MessageResponse>('/auth/forgot-password', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ email }),
  });
}

export async function resetPassword(
  token: string,
  password: string,
): Promise<void> {
  await apiFetch<MessageResponse>('/auth/reset-password', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ token, password }),
  });
}

export async function login(
  email: string,
  password: string,
): Promise<TokenResponse> {
  const result = await apiFetch<TokenResponse>('/auth/login', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ email, password }),
  });
  await persistSession(result);
  return result;
}

export async function refresh(refreshToken: string): Promise<TokenResponse> {
  return refreshWithToken(refreshToken);
}

export async function logout(): Promise<void> {
  const refreshToken = await getStoredRefreshToken();
  if (refreshToken) {
    try {
      await apiFetch<MessageResponse>('/auth/logout', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch {
      // Ignore network errors during logout.
    }
  }
  await clearSession();
}

export async function tryRefreshSession(): Promise<RestoreSessionResult> {
  const refreshToken = await getStoredRefreshToken();
  if (!refreshToken) {
    return { mode: 'none' };
  }

  const payload = decodeJwtPayload(refreshToken);
  if (payload?.exp && isRefreshTokenExpiredLocally(payload.exp)) {
    await clearSession();
    return { mode: 'none' };
  }

  const cache = await readValidSessionCache();

  try {
    const result = await refreshWithToken(refreshToken);
    return { mode: 'online', user: result.user };
  } catch (err) {
    if (isNetworkError(err) && cache) {
      return { mode: 'offline', user: cache.user };
    }
    return { mode: 'none' };
  }
}

export async function restoreSession(): Promise<RestoreSessionResult> {
  const refreshToken = await getStoredRefreshToken();
  if (!refreshToken) {
    return { mode: 'none' };
  }

  const payload = decodeJwtPayload(refreshToken);
  if (payload?.exp && isRefreshTokenExpiredLocally(payload.exp)) {
    await clearSession();
    return { mode: 'none' };
  }

  const cache = await readValidSessionCache();

  try {
    const result = await refreshWithToken(refreshToken);
    return { mode: 'online', user: result.user };
  } catch (err) {
    if (isNetworkError(err) && cache) {
      tokenHolder.setAccessToken(null);
      return { mode: 'offline', user: cache.user };
    }
    return { mode: 'none' };
  }
}

export { clearSession };
