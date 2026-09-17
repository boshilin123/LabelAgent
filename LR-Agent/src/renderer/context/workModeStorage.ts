import type { WorkMode } from './workModeTypes';

const STORAGE_KEY = 'lr-agent:workMode';

export function readStoredWorkMode(): WorkMode {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'annotation') return 'annotation';
  return 'editor';
}

export { STORAGE_KEY as WORK_MODE_STORAGE_KEY };
