import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

export function scheduleEditorLayout(
  editorInstance: monaco.editor.IStandaloneCodeEditor,
): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      editorInstance.layout();
    });
  });
}

/** Wait until the Monaco container has a non-zero size (or timeout). */
export function waitForEditorContainer(
  element: HTMLElement,
  isCancelled: () => boolean,
  timeoutMs = 500,
): Promise<boolean> {
  if (element.clientWidth > 0 && element.clientHeight > 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      ro.disconnect();
      clearTimeout(timeoutId);
      resolve(ready);
    };

    const ro = new ResizeObserver(() => {
      if (isCancelled()) {
        finish(false);
        return;
      }
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        finish(true);
      }
    });
    ro.observe(element);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (isCancelled()) {
          finish(false);
          return;
        }
        if (element.clientWidth > 0 && element.clientHeight > 0) {
          finish(true);
        }
      });
    });

    const timeoutId = window.setTimeout(() => {
      finish(!isCancelled());
    }, timeoutMs);
  });
}
