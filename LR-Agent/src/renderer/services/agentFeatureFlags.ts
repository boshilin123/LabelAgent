/**
 * Client-side feature flags for Agent capability extensions.
 *
 * Default: enabled. Override in DevTools for local debugging only.
 * Authoritative kill switch lives on the backend (`agent_*_enabled` settings).
 */

declare global {
  interface Window {
    __LR_AGENT_MUTATION_ENABLED__?: boolean;
    __LR_AGENT_DOCUMENT_WRITE_ENABLED__?: boolean;
  }
}

function readWindowFlag(
  key: '__LR_AGENT_MUTATION_ENABLED__' | '__LR_AGENT_DOCUMENT_WRITE_ENABLED__',
): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  const value = window[key];
  if (value == null) {
    return true;
  }
  return Boolean(value);
}

export function isAgentDocumentWriteEnabled(): boolean {
  return readWindowFlag('__LR_AGENT_DOCUMENT_WRITE_ENABLED__');
}
