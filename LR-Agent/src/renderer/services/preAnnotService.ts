import type {
  PreAnnotJobKind,
  PreAnnotNormBox,
  PreAnnotRequest,
  PreAnnotResult,
  PreAnnotRunResponse,
} from '../../shared/preAnnotTypes';
import type {
  PretrainedModelConfig,
  PretrainedModelParams,
} from '../types/pretrainedModel';

function createJobId(): string {
  return `preannot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runPreAnnot(
  kind: PreAnnotJobKind,
  imagePath: string,
  model: PretrainedModelConfig,
  options?: {
    box?: PreAnnotNormBox;
    templateId?: string;
    overrides?: Partial<PretrainedModelParams>;
  },
): Promise<PreAnnotRunResponse> {
  if (!window.electron?.preAnnot) {
    return { ok: false, error: '预标注 API 不可用（非 Electron 环境）' };
  }

  const request: PreAnnotRequest = {
    jobId: createJobId(),
    kind,
    imagePath,
    model,
    box: options?.box,
    templateId: options?.templateId,
    overrides: options?.overrides,
  };

  return window.electron.preAnnot.run(request);
}

export function assertPreAnnotResult<T extends PreAnnotResult>(
  response: PreAnnotRunResponse,
  guard: (result: PreAnnotResult) => result is T,
  label: string,
): T {
  if (!response.ok || !response.result) {
    throw new Error(response.error ?? `${label} 推理失败`);
  }
  if (!guard(response.result)) {
    throw new Error(`${label} 返回格式不正确`);
  }
  return response.result;
}
