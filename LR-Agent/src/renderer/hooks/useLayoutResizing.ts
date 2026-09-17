import { useSyncExternalStore } from 'react';

function subscribe(onStoreChange: () => void): () => void {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => observer.disconnect();
}

function getSnapshot(): boolean {
  return document.body.classList.contains('is-resizing');
}

function getServerSnapshot(): boolean {
  return false;
}

/** True while user is dragging left/right sidebar resizers (see Layout.tsx). */
export function useLayoutResizing(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
