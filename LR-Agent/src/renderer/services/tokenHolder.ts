type SessionExpiredHandler = () => void;

let accessToken: string | null = null;
let onSessionExpired: SessionExpiredHandler | null = null;

const tokenHolder = {
  getAccessToken(): string | null {
    return accessToken;
  },

  setAccessToken(token: string | null): void {
    accessToken = token;
  },

  setOnSessionExpired(handler: SessionExpiredHandler | null): void {
    onSessionExpired = handler;
  },

  notifySessionExpired(): void {
    onSessionExpired?.();
  },
};

export default tokenHolder;
