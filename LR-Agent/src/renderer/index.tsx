import { createRoot } from 'react-dom/client';
import { isResizeObserverLoopError } from './utils/resizeObserver';
import { setApiBaseUrlOverride } from './config';
import './monacoSetup';
import App from './App';

// 尽早读取 environment.json 持久化的后端地址，注入 config.ts 覆盖，
// 保证 AuthProvider 引导期的首次请求即用对地址（无配置时保持默认）
window.electron?.env
  ?.getSettings()
  .then((settings) => {
    setApiBaseUrlOverride(settings.backendBaseUrl);
  })
  .catch(() => undefined);

if (process.env.NODE_ENV === 'development') {
  const SUPPRESSED_MESSAGES = new Set(['Canceled', 'canceled']);

  const shouldSuppressDevOverlay = (value: unknown): boolean => {
    if (
      isResizeObserverLoopError(typeof value === 'string' ? value : undefined)
    ) {
      return true;
    }
    if (typeof value !== 'string') return false;
    return SUPPRESSED_MESSAGES.has(value);
  };

  const isMonacoWorkerRuntimeFailure = (value: unknown): boolean => {
    if (value instanceof Event && value.type === 'error') {
      return value.target instanceof Worker;
    }
    return false;
  };

  const suppressDevOverlayEvent = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  window.addEventListener(
    'error',
    (event) => {
      const message = event.message ?? event.error?.message;
      if (shouldSuppressDevOverlay(message)) {
        suppressDevOverlayEvent(event);
        return;
      }

      if (isMonacoWorkerRuntimeFailure(event.error ?? event)) {
        // eslint-disable-next-line no-console
        console.warn('[Monaco worker runtime error]', event.error ?? event);
        suppressDevOverlayEvent(event);
        return;
      }

      if (
        !event.error &&
        event.target instanceof HTMLScriptElement &&
        event.target.src.includes('.worker.')
      ) {
        // eslint-disable-next-line no-console
        console.warn('[Monaco worker load error]', event.target.src);
        suppressDevOverlayEvent(event);
        return;
      }

      if (!event.error && event.target instanceof Worker) {
        // eslint-disable-next-line no-console
        console.warn('[Monaco worker load error]', event.target);
        suppressDevOverlayEvent(event);
      }
    },
    true,
  );

  window.addEventListener('unhandledrejection', (event) => {
    const { reason } = event;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : undefined;

    if (shouldSuppressDevOverlay(message)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (isMonacoWorkerRuntimeFailure(reason)) {
      // eslint-disable-next-line no-console
      console.warn('[Monaco worker rejection]', reason);
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });
}

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
root.render(<App />);
