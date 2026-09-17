export type AuthStatus =
  'loading' | 'unauthenticated' | 'authenticated' | 'authenticated_offline';

export interface LocalSessionCache {
  user: UserPublic;
  lastOnlineAt: string;
  refreshTokenExp: number;
}

export type RestoreSessionResult =
  | { mode: 'online'; user: UserPublic }
  | { mode: 'offline'; user: UserPublic }
  | { mode: 'none' };

export interface UserPublic {
  id: string;
  email: string;
  email_verified: boolean;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: UserPublic;
}

export interface MessageResponse {
  message: string;
}

export interface ApiErrorBody {
  detail?: string | { msg: string }[];
}

export class ApiError extends Error {
  status: number;

  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}
