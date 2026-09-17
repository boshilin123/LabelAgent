import { randomUUID } from 'node:crypto';

jest.mock('remark-math', () => ({
  __esModule: true,
  default: () => undefined,
}));

jest.mock('rehype-katex', () => ({
  __esModule: true,
  default: () => undefined,
}));

if (typeof globalThis.crypto?.randomUUID !== 'function') {
  try {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: randomUUID,
    });
  } catch {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID },
    });
  }
}

const hasDom = typeof window !== 'undefined';

if (hasDom) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

if (hasDom) {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    writable: true,
    value: {
      platform: 'win32',
      ipcRenderer: {
        sendMessage: jest.fn(),
        on: jest.fn(() => jest.fn()),
        once: jest.fn(),
        invoke: jest.fn(),
      },
      window: {
        minimize: jest.fn(),
        maximize: jest.fn(),
        close: jest.fn(),
        reload: jest.fn(),
        toggleDevTools: jest.fn(),
        toggleFullScreen: jest.fn(),
        isMaximized: jest.fn().mockResolvedValue(false),
        isFullScreen: jest.fn().mockResolvedValue(false),
        openExternal: jest.fn().mockResolvedValue(undefined),
        onMaximizeChange: jest.fn(() => jest.fn()),
        onFullScreenChange: jest.fn(() => jest.fn()),
      },
      fileSystem: {
        openDirectory: jest.fn(),
        readDirectory: jest.fn(),
        readFile: jest.fn(),
        readFileBuffer: jest.fn(),
        getFileStats: jest.fn(),
        openPath: jest.fn(),
        onChanged: jest.fn(() => jest.fn()),
      },
      auth: {
        getRefreshToken: jest.fn().mockResolvedValue(null),
        setRefreshToken: jest.fn().mockResolvedValue(undefined),
        clearRefreshToken: jest.fn().mockResolvedValue(undefined),
        getSessionCache: jest.fn().mockResolvedValue(null),
        setSessionCache: jest.fn().mockResolvedValue(undefined),
        clearSessionCache: jest.fn().mockResolvedValue(undefined),
        getPendingResetToken: jest.fn().mockResolvedValue(null),
        onResetPasswordDeepLink: jest.fn(() => jest.fn()),
      },
      annotation: {
        getProjects: jest.fn().mockResolvedValue([]),
        saveProjects: jest.fn().mockResolvedValue(undefined),
        writeProjectConfig: jest.fn().mockResolvedValue(undefined),
        removeProjectConfig: jest.fn().mockResolvedValue(undefined),
        showItemInFolder: jest.fn().mockResolvedValue(undefined),
        readFileAnnotationDoc: jest.fn().mockResolvedValue(null),
        writeFileAnnotationDoc: jest.fn().mockResolvedValue(undefined),
        exportAnnotations: jest.fn().mockResolvedValue({
          success: true,
          outputDir: '',
          filesWritten: 0,
          imageCount: 0,
          annotationCount: 0,
          message: 'ok',
        }),
      },
      theme: {
        getSystemDark: jest.fn().mockResolvedValue(false),
        onSystemChanged: jest.fn(() => jest.fn()),
        notifyEffectiveTheme: jest.fn(),
      },
      preAnnot: {
        checkRuntime: jest.fn().mockResolvedValue({ pythonOk: false }),
        run: jest.fn().mockResolvedValue({ ok: false, error: 'mock' }),
        cancel: jest.fn().mockResolvedValue(undefined),
      },
      workspace: {
        writeTextFile: jest.fn().mockResolvedValue({ success: true }),
        readTextFile: jest
          .fn()
          .mockResolvedValue({ success: true, content: '' }),
        deleteTextFile: jest.fn().mockResolvedValue({ success: true }),
      },
      env: {
        getStatus: jest.fn().mockResolvedValue(null),
        getSettings: jest.fn().mockResolvedValue(null),
        setSettings: jest.fn().mockResolvedValue(undefined),
      },
      localAgent: {
        getBaseUrl: jest.fn().mockResolvedValue(null),
        onStatus: jest.fn(() => jest.fn()),
      },
      pretrainedModels: {
        getAll: jest.fn().mockResolvedValue([]),
        saveAll: jest.fn().mockResolvedValue(undefined),
      },
      memory: {
        readIndex: jest.fn().mockResolvedValue(null),
        setActive: jest.fn().mockResolvedValue(undefined),
        listEntries: jest.fn().mockResolvedValue([]),
        syncFacts: jest.fn().mockResolvedValue({
          annotatedFiles: 0,
          annotationCount: 0,
        }),
      },
      checkpoint: {
        capture: jest.fn().mockResolvedValue({}),
        recordAfter: jest.fn().mockResolvedValue({}),
        restore: jest.fn().mockResolvedValue({ ok: true, restoredPaths: [] }),
        discard: jest.fn().mockResolvedValue(undefined),
        has: jest.fn().mockResolvedValue(false),
      },
      dialog: {
        confirm: jest.fn().mockResolvedValue(true),
        openFile: jest.fn().mockResolvedValue(null),
      },
    },
  });
}

export {};
