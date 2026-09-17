import { API_BASE_URL } from '../config';
import { ApiError, ApiErrorBody, TokenResponse } from '../types/auth';
import tokenHolder from './tokenHolder';
import { persistSession, clearSession } from './sessionPersistence';
import { isOfflineMode } from './authMode';
import { isAuthRejection, isNetworkError } from './networkUtils';

let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const refreshToken = await window.electron?.auth?.getRefreshToken();
  if (!refreshToken) {
    return false;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (err) {
    if (isNetworkError(err)) {
      return false;
    }
    throw err;
  }

  if (!response.ok) {
    if (isAuthRejection(response.status)) {
      await clearSession();
    }
    return false;
  }

  const result = (await response.json()) as TokenResponse;
  await persistSession(result);
  return true;
}

/** Deduplicated refresh — concurrent 401s share one in-flight request. */
export async function refreshSessionOnce(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function handleUnauthorized(): Promise<boolean> {
  const refreshed = await refreshSessionOnce();
  if (!refreshed) {
    if (isOfflineMode()) {
      return false;
    }
    tokenHolder.notifySessionExpired();
  }
  return refreshed;
}

export function buildAuthHeaders(headers?: HeadersInit): Headers {
  const requestHeaders = new Headers(headers);
  const accessToken = tokenHolder.getAccessToken();
  if (accessToken) {
    requestHeaders.set('Authorization', `Bearer ${accessToken}`);
  }
  return requestHeaders;
}

export interface AuthFetchOptions extends RequestInit {
  auth?: boolean;
  _retried?: boolean;
}

export async function authFetch(
  url: string,
  options: AuthFetchOptions = {},
): Promise<Response> {
  const { auth = true, _retried = false, headers, ...rest } = options;
  const requestHeaders = buildAuthHeaders(headers);

  if (
    rest.body &&
    !(rest.body instanceof FormData) &&
    !requestHeaders.has('Content-Type')
  ) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: requestHeaders,
    });
  } catch (err) {
    if (isNetworkError(err)) {
      throw new ApiError(0, 'network_unavailable');
    }
    throw err;
  }

  if (response.status === 401 && auth && !_retried) {
    const refreshed = await handleUnauthorized();
    if (refreshed) {
      return authFetch(url, { ...options, _retried: true });
    }
    if (isOfflineMode()) {
      throw new ApiError(0, 'network_unavailable');
    }
    throw new ApiError(401, 'session_expired');
  }

  return response;
}

export async function authFetchPath(
  path: string,
  options: AuthFetchOptions = {},
): Promise<Response> {
  return authFetch(`${API_BASE_URL}${path}`, options);
}

export async function parseApiError(response: Response): Promise<ApiError> {
  let detail = 'request_failed';
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (typeof body.detail === 'string') {
      detail = body.detail;
    }
  } catch {
    detail = response.statusText || detail;
  }
  return new ApiError(response.status, detail);
}
