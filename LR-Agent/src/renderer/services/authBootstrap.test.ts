import { ApiError, TokenResponse, UserPublic } from '../types/auth';
import { restoreSession, tryRefreshSession } from './auth';
import { apiFetch } from './api';
import { decodeJwtPayload, isRefreshTokenExpiredLocally } from './jwtUtils';
import { isAuthRejection, isNetworkError } from './networkUtils';

jest.mock('./api');

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

function authMock() {
  return window.electron.auth as unknown as {
    getRefreshToken: jest.Mock;
    setRefreshToken: jest.Mock;
    setSessionCache: jest.Mock;
    clearRefreshToken: jest.Mock;
    clearSessionCache: jest.Mock;
    getSessionCache: jest.Mock;
  };
}

const mockUser: UserPublic = {
  id: 'user-1',
  email: 'test@example.com',
  email_verified: true,
  username: 'tester',
  display_name: 'Tester',
  avatar_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

function makeRefreshToken(exp: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp, sub: 'user-1', type: 'refresh' }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

function makeTokenResponse(refreshToken: string): TokenResponse {
  return {
    access_token: 'access-token',
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: 900,
    user: mockUser,
  };
}

describe('jwtUtils', () => {
  it('decodes JWT payload without verification', () => {
    const token = makeRefreshToken(4_102_444_800);
    const payload = decodeJwtPayload(token);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.exp).toBe(4_102_444_800);
  });

  it('returns null for malformed token', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
  });

  it('detects expired refresh token locally', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(isRefreshTokenExpiredLocally(past)).toBe(true);
    const future = Math.floor(Date.now() / 1000) + 60;
    expect(isRefreshTokenExpiredLocally(future)).toBe(false);
  });
});

describe('networkUtils', () => {
  it('detects fetch network errors', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new Error('network_unavailable'))).toBe(true);
    expect(isNetworkError(new ApiError(401, 'session_expired'))).toBe(false);
  });

  it('detects auth rejection status codes', () => {
    expect(isAuthRejection(401)).toBe(true);
    expect(isAuthRejection(403)).toBe(true);
    expect(isAuthRejection(500)).toBe(false);
  });
});

describe('restoreSession', () => {
  const futureExp = Math.floor(Date.now() / 1000) + 86_400;
  const refreshToken = makeRefreshToken(futureExp);

  beforeEach(() => {
    jest.clearAllMocks();
    authMock().getRefreshToken.mockResolvedValue(refreshToken);
    authMock().setRefreshToken.mockResolvedValue(undefined);
    authMock().setSessionCache.mockResolvedValue(undefined);
    authMock().clearRefreshToken.mockResolvedValue(undefined);
    authMock().clearSessionCache.mockResolvedValue(undefined);
    authMock().getSessionCache.mockResolvedValue({
      user: mockUser,
      lastOnlineAt: new Date().toISOString(),
      refreshTokenExp: futureExp,
    });
  });

  it('returns none when refresh token is missing', async () => {
    authMock().getRefreshToken.mockResolvedValue(null);

    await expect(restoreSession()).resolves.toEqual({ mode: 'none' });
  });

  it('returns none when electron auth bridge is unavailable', async () => {
    const original = window.electron;
    (window as unknown as { electron?: typeof original }).electron = undefined;
    try {
      await expect(restoreSession()).resolves.toEqual({ mode: 'none' });
      expect(mockApiFetch).not.toHaveBeenCalled();
    } finally {
      window.electron = original;
    }
  });

  it('returns online and persists cache when refresh succeeds', async () => {
    mockApiFetch.mockResolvedValue(makeTokenResponse(refreshToken));

    await expect(restoreSession()).resolves.toEqual({
      mode: 'online',
      user: mockUser,
    });
    expect(authMock().setSessionCache).toHaveBeenCalled();
  });

  it('returns offline when refresh fails due to network error', async () => {
    mockApiFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(restoreSession()).resolves.toEqual({
      mode: 'offline',
      user: mockUser,
    });
    expect(authMock().clearRefreshToken).not.toHaveBeenCalled();
  });

  it('returns none and clears session when refresh is rejected', async () => {
    mockApiFetch.mockRejectedValue(new ApiError(401, 'invalid_token'));

    await expect(restoreSession()).resolves.toEqual({ mode: 'none' });
    expect(authMock().clearRefreshToken).toHaveBeenCalled();
    expect(authMock().clearSessionCache).toHaveBeenCalled();
  });

  it('returns none when refresh token is locally expired', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 60;
    const expiredToken = makeRefreshToken(pastExp);
    authMock().getRefreshToken.mockResolvedValue(expiredToken);

    await expect(restoreSession()).resolves.toEqual({ mode: 'none' });
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(authMock().clearRefreshToken).toHaveBeenCalled();
  });

  it('returns none on network error when session cache is missing', async () => {
    authMock().getSessionCache.mockResolvedValue(null);
    mockApiFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(restoreSession()).resolves.toEqual({ mode: 'none' });
    expect(authMock().clearRefreshToken).not.toHaveBeenCalled();
  });
});

describe('tryRefreshSession', () => {
  const futureExp = Math.floor(Date.now() / 1000) + 86_400;
  const refreshToken = makeRefreshToken(futureExp);

  beforeEach(() => {
    jest.clearAllMocks();
    authMock().getRefreshToken.mockResolvedValue(refreshToken);
    authMock().setRefreshToken.mockResolvedValue(undefined);
    authMock().setSessionCache.mockResolvedValue(undefined);
    authMock().clearRefreshToken.mockResolvedValue(undefined);
    authMock().clearSessionCache.mockResolvedValue(undefined);
    authMock().getSessionCache.mockResolvedValue({
      user: mockUser,
      lastOnlineAt: new Date().toISOString(),
      refreshTokenExp: futureExp,
    });
  });

  it('returns offline on network failure during background refresh', async () => {
    mockApiFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(tryRefreshSession()).resolves.toEqual({
      mode: 'offline',
      user: mockUser,
    });
  });

  it('returns online when background refresh succeeds', async () => {
    mockApiFetch.mockResolvedValue(makeTokenResponse(refreshToken));

    await expect(tryRefreshSession()).resolves.toEqual({
      mode: 'online',
      user: mockUser,
    });
  });
});
