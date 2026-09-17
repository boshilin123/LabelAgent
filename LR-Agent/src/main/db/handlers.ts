import { ipcMain } from 'electron';
import { probeAndPersistProviderVision } from '../llm/probeProviderVision';
import { probeAndPersistProviderContext } from '../llm/probeProviderContext';
import * as sessionRepo from './sessionRepository';
import * as messageRepo from './messageRepository';
import * as providerRepo from './providerRepository';

export function registerDbHandlers(): void {
  // ── Session handlers ──────────────────────────────────────────────

  ipcMain.handle(
    'db:sessions:list',
    (
      _event,
      options: {
        userId: string;
        limit?: number;
        cursor?: string | null;
        annotationProjectId?: string | null;
        workspaceOnly?: boolean;
      },
    ) => {
      return sessionRepo.listSessions(options);
    },
  );

  ipcMain.handle(
    'db:sessions:get',
    (_event, sessionId: string, userId: string) => {
      return sessionRepo.getSession(sessionId, userId);
    },
  );

  ipcMain.handle(
    'db:sessions:create',
    (
      _event,
      session: {
        id: string;
        userId: string;
        title?: string;
        annotationProjectId?: string | null;
        interactionMode?: string | null;
        providerId?: string | null;
        model?: string | null;
      },
    ) => {
      return sessionRepo.createSession(session);
    },
  );

  ipcMain.handle(
    'db:sessions:update',
    (
      _event,
      sessionId: string,
      userId: string,
      patch: Record<string, unknown>,
    ) => {
      return sessionRepo.updateSession(
        sessionId,
        userId,
        patch as Parameters<typeof sessionRepo.updateSession>[2],
      );
    },
  );

  ipcMain.handle(
    'db:sessions:softDelete',
    (_event, sessionId: string, userId: string) => {
      sessionRepo.softDeleteSession(sessionId, userId);
    },
  );

  ipcMain.handle('db:sessions:getMessageIds', (_event, sessionId: string) => {
    return sessionRepo.getSessionMessageIds(sessionId);
  });

  ipcMain.handle('db:sessions:getMessageCount', (_event, sessionId: string) => {
    return sessionRepo.getSessionMessageCount(sessionId);
  });

  ipcMain.handle(
    'db:sessions:getLastMessagePreview',
    (_event, sessionId: string) => {
      return sessionRepo.getLastMessagePreview(sessionId);
    },
  );

  ipcMain.handle(
    'db:sessions:listWithStats',
    (
      _event,
      options: {
        userId: string;
        limit?: number;
        cursor?: string | null;
        annotationProjectId?: string | null;
        workspaceOnly?: boolean;
      },
    ) => {
      return sessionRepo.listSessionsWithStats(options);
    },
  );

  ipcMain.handle(
    'db:sessions:backfillLegacyUserId',
    (_event, userId: string) => {
      return sessionRepo.backfillLegacyUserId(userId);
    },
  );

  // ── Message handlers ──────────────────────────────────────────────

  ipcMain.handle(
    'db:messages:list',
    (
      _event,
      sessionId: string,
      options: {
        beforeMessageId?: string | null;
        limit?: number;
      },
    ) => {
      return messageRepo.getMessages(sessionId, options);
    },
  );

  ipcMain.handle(
    'db:messages:create',
    (
      _event,
      message: {
        id: string;
        sessionId: string;
        userId: string;
        role: string;
        interactionMode?: string | null;
        sortIndex?: number;
        blocksJson?: string;
        status?: string;
        providerId?: string | null;
        model?: string | null;
        error?: string | null;
      },
    ) => {
      return messageRepo.createMessage(message);
    },
  );

  ipcMain.handle(
    'db:messages:update',
    (_event, messageId: string, patch: Record<string, unknown>) => {
      return messageRepo.updateMessage(
        messageId,
        patch as Parameters<typeof messageRepo.updateMessage>[1],
      );
    },
  );

  ipcMain.handle(
    'db:messages:deleteAfter',
    (_event, sessionId: string, sortIndex: number) => {
      messageRepo.deleteMessagesAfter(sessionId, sortIndex);
    },
  );

  ipcMain.handle('db:messages:get', (_event, messageId: string) => {
    return messageRepo.getMessage(messageId);
  });

  ipcMain.handle(
    'db:messages:deleteAfterId',
    (_event, sessionId: string, messageId: string) => {
      messageRepo.deleteMessagesAfterId(sessionId, messageId);
    },
  );

  ipcMain.handle(
    'db:messages:cleanupStreaming',
    (_event, sessionId?: string) => {
      return messageRepo.cleanupStreamingMessages(sessionId);
    },
  );

  ipcMain.handle('db:messages:deleteBySession', (_event, sessionId: string) => {
    messageRepo.deleteMessagesBySession(sessionId);
  });

  ipcMain.handle(
    'db:messages:batchCreate',
    (
      _event,
      messages: Array<
        Parameters<typeof messageRepo.batchCreateMessages>[0][number]
      >,
    ) => {
      messageRepo.batchCreateMessages(messages);
    },
  );

  ipcMain.handle('db:messages:getForExport', (_event, sessionId: string) => {
    return messageRepo.getSessionMessagesForExport(sessionId);
  });

  // ── Provider handlers ─────────────────────────────────────────────

  ipcMain.handle('db:providers:list', () => {
    return providerRepo.listProviders();
  });

  ipcMain.handle('db:providers:get', (_event, id: string) => {
    return providerRepo.getProvider(id);
  });

  ipcMain.handle(
    'db:providers:create',
    (
      _event,
      provider: {
        id: string;
        name: string;
        baseUrl: string;
        apiKeyEncrypted: string;
        encryptionKeyId?: string;
        model: string;
        enabled?: boolean;
        isDefault?: boolean;
        supportsVision?: boolean;
      },
    ) => {
      return providerRepo.createProvider(provider);
    },
  );

  ipcMain.handle(
    'db:providers:update',
    (_event, id: string, patch: Record<string, unknown>) => {
      return providerRepo.updateProvider(
        id,
        patch as Parameters<typeof providerRepo.updateProvider>[1],
      );
    },
  );

  ipcMain.handle('db:providers:delete', (_event, id: string) => {
    providerRepo.deleteProvider(id);
  });

  ipcMain.handle('db:providers:setDefault', (_event, id: string) => {
    return providerRepo.setDefaultProvider(id);
  });

  ipcMain.handle('db:providers:getDefault', () => {
    return providerRepo.getDefaultProvider();
  });

  ipcMain.handle('db:providers:probeVision', (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('provider_not_found');
    }
    return probeAndPersistProviderVision(id);
  });

  ipcMain.handle('db:providers:probeContext', (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('provider_not_found');
    }
    return probeAndPersistProviderContext(id);
  });
}
