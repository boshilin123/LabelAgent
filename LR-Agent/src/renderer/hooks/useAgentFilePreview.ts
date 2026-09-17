import { useCallback, useEffect, useState } from 'react';
import {
  clearFilePreviewSession,
  getFilePreviewSession,
  setFilePreviewSession,
  subscribeFilePreview,
  type AgentFilePreviewSession,
} from '../services/agentFilePreviewStore';

export function useAgentFilePreview() {
  const [filePreview, setFilePreview] =
    useState<AgentFilePreviewSession | null>(() => getFilePreviewSession());

  useEffect(
    () => subscribeFilePreview(() => setFilePreview(getFilePreviewSession())),
    [],
  );

  const enterFilePreview = useCallback((next: AgentFilePreviewSession) => {
    setFilePreviewSession(next);
  }, []);

  const clearFilePreview = useCallback(() => {
    clearFilePreviewSession();
  }, []);

  return { filePreview, enterFilePreview, clearFilePreview };
}
