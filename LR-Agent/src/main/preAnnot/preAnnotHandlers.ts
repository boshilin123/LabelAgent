import { ipcMain } from 'electron';
import {
  checkInferenceRuntime,
  runPreAnnotInference,
  shutdownInferenceProcess,
} from './inferenceProcess';
import type { PreAnnotRequest } from '../../shared/preAnnotTypes';

export default function registerPreAnnotHandlers(): void {
  ipcMain.handle('preAnnot:checkRuntime', async () => checkInferenceRuntime());

  ipcMain.handle('preAnnot:run', async (_event, request: PreAnnotRequest) =>
    runPreAnnotInference(request),
  );

  ipcMain.handle('preAnnot:cancel', async () => {
    shutdownInferenceProcess();
  });
}
