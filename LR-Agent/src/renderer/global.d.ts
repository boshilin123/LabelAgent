import type { ElectronHandler } from '../main/preload';

declare global {
  interface Window {
    electron: ElectronHandler;
    MonacoEnvironment?: {
      getWorker?: (moduleId: string, label: string) => Worker;
      getWorkerUrl?: (moduleId: string, label: string) => string;
    };
  }

  // eslint-disable-next-line no-var
  var MonacoEnvironment: Window['MonacoEnvironment'];
}

declare module '*?url' {
  const src: string;
  export default src;
}

export {};
