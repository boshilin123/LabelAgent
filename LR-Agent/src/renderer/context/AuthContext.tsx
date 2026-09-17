import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AuthStatus, UserPublic } from '../types/auth';
import * as authService from '../services/auth';
import * as userService from '../services/user';
import tokenHolder from '../services/tokenHolder';
import { setOfflineMode } from '../services/authMode';

interface AuthContextValue {
  status: AuthStatus;
  user: UserPublic | null;
  isAuthenticated: boolean;
  isOfflineMode: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchAccount: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: (user: UserPublic | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function statusToOfflineMode(status: AuthStatus): boolean {
  return status === 'authenticated_offline';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserPublic | null>(null);

  const handleSessionExpired = useCallback(() => {
    setOfflineMode(false);
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  useEffect(() => {
    tokenHolder.setOnSessionExpired(handleSessionExpired);
    return () => tokenHolder.setOnSessionExpired(null);
  }, [handleSessionExpired]);

  useEffect(() => {
    setOfflineMode(statusToOfflineMode(status));
  }, [status]);

  const applyRestoreResult = useCallback(
    (result: Awaited<ReturnType<typeof authService.restoreSession>>) => {
      if (result.mode === 'online') {
        setUser(result.user);
        setStatus('authenticated');
        return;
      }
      if (result.mode === 'offline') {
        setUser(result.user);
        setStatus('authenticated_offline');
        return;
      }
      setUser(null);
      setStatus('unauthenticated');
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const result = await authService.restoreSession();
        if (cancelled) return;
        applyRestoreResult(result);
      } catch {
        if (!cancelled) {
          setUser(null);
          setStatus('unauthenticated');
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyRestoreResult]);

  useEffect(() => {
    if (status !== 'authenticated') {
      return undefined;
    }

    const onOffline = () => {
      tokenHolder.setAccessToken(null);
      setStatus('authenticated_offline');
    };

    window.addEventListener('offline', onOffline);
    return () => window.removeEventListener('offline', onOffline);
  }, [status]);

  useEffect(() => {
    if (status !== 'authenticated_offline') {
      return undefined;
    }

    const attemptReconnect = async () => {
      const result = await authService.tryRefreshSession();
      if (result.mode === 'online') {
        setUser(result.user);
        setStatus('authenticated');
      }
    };

    const onOnline = () => {
      void attemptReconnect();
    };

    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [status]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authService.login(email, password);
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    await authService.register(email, password);
  }, []);

  const logout = useCallback(async () => {
    await authService.logout();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const switchAccount = useCallback(async () => {
    await authService.logout();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await userService.getMe();
    setUser(me);
  }, []);

  const isAuthenticated =
    status === 'authenticated' || status === 'authenticated_offline';
  const isOfflineMode = status === 'authenticated_offline';

  const value = useMemo(
    () => ({
      status,
      user,
      isAuthenticated,
      isOfflineMode,
      login,
      register,
      logout,
      switchAccount,
      refreshUser,
      setUser,
    }),
    [
      status,
      user,
      isAuthenticated,
      isOfflineMode,
      login,
      register,
      logout,
      switchAccount,
      refreshUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

export type { AuthStatus };
