import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  PretrainedModelConfig,
  PretrainedModelType,
  KeypointBackend,
  createModelId,
  defaultParamsForType,
  KEYPOINT_BACKEND_PRESETS,
} from '../types/pretrainedModel';
import {
  loadPretrainedModels,
  persistPretrainedModels,
} from '../services/pretrainedModelService';

interface PretrainedModelsContextValue {
  models: PretrainedModelConfig[];
  loading: boolean;
  refreshModels: () => Promise<void>;
  upsertModel: (model: PretrainedModelConfig) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  getModelsByType: (type: PretrainedModelType) => PretrainedModelConfig[];
  getDefaultModel: (type: PretrainedModelType) => PretrainedModelConfig | null;
  getDefaultKeypointModel: (templateId: string) => PretrainedModelConfig | null;
}

const PretrainedModelsContext =
  createContext<PretrainedModelsContextValue | null>(null);

export function PretrainedModelsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [models, setModels] = useState<PretrainedModelConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshModels = useCallback(async () => {
    setLoading(true);
    try {
      const list = await loadPretrainedModels();
      setModels(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshModels().catch(() => undefined);
  }, [refreshModels]);

  const upsertModel = useCallback(
    async (model: PretrainedModelConfig) => {
      const exists = models.some((item) => item.id === model.id);
      const next = exists
        ? models.map((item) => (item.id === model.id ? model : item))
        : [...models, model];
      await persistPretrainedModels(next, model);
      setModels(await loadPretrainedModels());
    },
    [models],
  );

  const deleteModel = useCallback(
    async (id: string) => {
      const next = models.filter((item) => item.id !== id);
      await persistPretrainedModels(next);
      setModels(await loadPretrainedModels());
    },
    [models],
  );

  const getModelsByType = useCallback(
    (type: PretrainedModelType) =>
      models.filter((m) => m.modelType === type && m.enabled),
    [models],
  );

  const getDefaultModel = useCallback(
    (type: PretrainedModelType) => {
      const enabled = models.filter((m) => m.modelType === type && m.enabled);
      return enabled.find((m) => m.isDefault) ?? enabled[0] ?? null;
    },
    [models],
  );

  const getDefaultKeypointModel = useCallback(
    (templateId: string) => {
      const enabled = models.filter(
        (m) =>
          m.modelType === 'keypoint_estimation' &&
          m.enabled &&
          m.keypointTemplateIds?.includes(templateId),
      );
      return enabled.find((m) => m.isDefault) ?? enabled[0] ?? null;
    },
    [models],
  );

  const value = useMemo(
    () => ({
      models,
      loading,
      refreshModels,
      upsertModel,
      deleteModel,
      getModelsByType,
      getDefaultModel,
      getDefaultKeypointModel,
    }),
    [
      models,
      loading,
      refreshModels,
      upsertModel,
      deleteModel,
      getModelsByType,
      getDefaultModel,
      getDefaultKeypointModel,
    ],
  );

  return (
    <PretrainedModelsContext.Provider value={value}>
      {children}
    </PretrainedModelsContext.Provider>
  );
}

export function usePretrainedModels(): PretrainedModelsContextValue {
  const ctx = useContext(PretrainedModelsContext);
  if (!ctx) {
    throw new Error(
      'usePretrainedModels must be used within PretrainedModelsProvider',
    );
  }
  return ctx;
}

export function buildEmptyModel(
  modelType: PretrainedModelType,
  keypointBackend: KeypointBackend = 'yolo_pose',
): PretrainedModelConfig {
  const now = new Date().toISOString();
  const preset = KEYPOINT_BACKEND_PRESETS[keypointBackend];

  return {
    id: createModelId(),
    name: '',
    modelType,
    enabled: true,
    isDefault: false,
    checkpointPath: '',
    configPath: modelType === 'image_segmentation' ? '' : undefined,
    keypointBackend:
      modelType === 'keypoint_estimation' ? keypointBackend : undefined,
    keypointTemplateIds:
      modelType === 'keypoint_estimation'
        ? [...preset.defaultTemplateIds]
        : undefined,
    auxiliaryPaths:
      modelType === 'keypoint_estimation' &&
      keypointBackend === 'face_alignment'
        ? { detector: '', torchHome: '' }
        : undefined,
    params: defaultParamsForType(modelType, keypointBackend),
    description: '',
    createdAt: now,
    updatedAt: now,
  };
}
