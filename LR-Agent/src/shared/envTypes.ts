import type { PreAnnotRuntimeInfo } from './preAnnotTypes';

/** 环境向导持久化配置（userData/environment.json） */
export interface EnvSettings {
  /** 后端 API base URL（含 /api/v1），空值表示使用构建期默认 */
  backendBaseUrl: string;
  /** 自定义 pip 镜像源（--index-url），空值表示官方源 */
  pipIndexUrl: string;
  /** 用户自定义 Python 解释器覆盖（可执行文件完整路径），空值表示未设置 */
  localAgentPythonOverride: string;
  inferencePythonOverride: string;
  firstRunCompleted: boolean;
  /** 首次跳过引导的时间戳（ISO），null 表示尚未跳过 */
  firstRunDismissedAt: string | null;
  firstRunSeenAt: string | null;
}

export interface BackendEnvStatus {
  configuredUrl: string;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

export interface LocalAgentEnvStatus {
  pythonPath: string | null;
  pythonOk: boolean;
  /** 解释器是否来自嵌入式运行时 venv（决定「依赖环境」是否按一键安装口径展示） */
  pythonFromVenv: boolean;
  depsInstalled: boolean;
  serviceRunning: boolean;
  serviceUrl: string | null;
  error?: string;
}

export interface InferenceEnvStatus {
  pythonPath: string | null;
  pythonOk: boolean;
  pythonFromVenv: boolean;
  depsInstalled: boolean;
  runtime: PreAnnotRuntimeInfo | null;
  error?: string;
}

export interface ModelGroupStatus {
  modelType: 'object_detection' | 'image_segmentation' | 'keypoint_estimation';
  registered: number;
  enabled: number;
  /** 已注册模型的权重路径（供「打开目录」使用） */
  checkpointPaths: string[];
}

export interface EnvironmentStatus {
  collectedAt: number;
  settings: EnvSettings;
  backend: BackendEnvStatus;
  localAgent: LocalAgentEnvStatus;
  inference: InferenceEnvStatus;
  models: ModelGroupStatus[];
}

export type InstallTarget = 'local-agent' | 'inference';
export type InferenceVariant = 'gpu' | 'cpu';

/** 「手动指定 Python 解释器」路径的真实校验结果（执行 --version 得到） */
export interface PythonValidationResult {
  state: 'empty' | 'valid' | 'invalid';
  /** 有效时的版本号，如 '3.12.10'；无效或未设置时无此字段 */
  version?: string;
  /** 无效时的中文原因，如「路径不存在」 */
  reason?: string;
}

export type InstallStage =
  | 'pending'
  | 'prepare-runtime'
  | 'create-venv'
  | 'install-deps'
  | 'verify'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface InstallProgress {
  target: InstallTarget;
  variant?: InferenceVariant;
  stage: InstallStage;
  /** 最近输出的日志尾部（最多 40 行） */
  lines: string[];
  error?: string;
  startedAt: number;
  finishedAt: number | null;
}

export interface InstallStartResult {
  ok: boolean;
  alreadyInstalled?: boolean;
  error?: string;
}

export type LocalAgentServiceState =
  'starting' | 'running' | 'stopped' | 'error';

export interface LocalAgentServiceStatus {
  state: LocalAgentServiceState;
  baseUrl: string | null;
  message?: string;
}

export const MODEL_GROUP_META: Array<{
  modelType: ModelGroupStatus['modelType'];
  label: string;
  hint: string;
}> = [
  {
    modelType: 'object_detection',
    label: '目标检测 (YOLO)',
    hint: '放置 *.pt 权重后在「预训练模型」设置页点击扫描',
  },
  {
    modelType: 'image_segmentation',
    label: '图像分割 (SAM2)',
    hint: '需要 configs/sam2.1/*.yaml 与 checkpoints/*.pt',
  },
  {
    modelType: 'keypoint_estimation',
    label: '关键点估计',
    hint: 'YOLO-pose / hand_landmarker.task / face-alignment 权重',
  },
];
