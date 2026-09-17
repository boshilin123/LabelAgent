export interface JwtPayload {
  exp?: number;
  sub?: string;
  type?: string;
}

export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      '=',
    );
    const json = atob(padded);
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

export function isRefreshTokenExpiredLocally(refreshTokenExp: number): boolean {
  return Date.now() / 1000 >= refreshTokenExp;
}
