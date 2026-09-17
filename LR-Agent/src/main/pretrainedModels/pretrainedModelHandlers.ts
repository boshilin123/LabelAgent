import { dialog, ipcMain } from 'electron';
import {
  getPretrainedModels,
  savePretrainedModels,
  scanFaceAlignmentDirectory,
  scanKeypointBundleDirectory,
  scanSam2Directory,
  validatePretrainedModel,
  type PretrainedModelConfig,
} from './pretrainedModelStore';

export default function registerPretrainedModelHandlers(): void {
  ipcMain.handle('pretrainedModels:getAll', async () => getPretrainedModels());

  ipcMain.handle(
    'pretrainedModels:saveAll',
    async (_event, models: PretrainedModelConfig[]) => {
      await savePretrainedModels(models);
    },
  );

  ipcMain.handle(
    'pretrainedModels:validate',
    async (
      _event,
      model: Pick<
        PretrainedModelConfig,
        | 'modelType'
        | 'checkpointPath'
        | 'configPath'
        | 'keypointBackend'
        | 'keypointTemplateIds'
        | 'auxiliaryPaths'
      >,
    ) => validatePretrainedModel(model),
  );

  ipcMain.handle(
    'pretrainedModels:scanSam2Directory',
    async (_event, rootDir: string) => scanSam2Directory(rootDir),
  );

  ipcMain.handle(
    'pretrainedModels:scanFaceAlignmentDirectory',
    async (_event, rootDir: string) => scanFaceAlignmentDirectory(rootDir),
  );

  ipcMain.handle(
    'pretrainedModels:scanKeypointBundleDirectory',
    async (_event, rootDir: string) => scanKeypointBundleDirectory(rootDir),
  );

  ipcMain.handle(
    'dialog:openFile',
    async (
      _event,
      options?: {
        title?: string;
        filters?: { name: string; extensions: string[] }[];
      },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: options?.title,
        filters: options?.filters,
      });
      return result.filePaths[0] || null;
    },
  );
}
