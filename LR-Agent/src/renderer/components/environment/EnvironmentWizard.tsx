import { useEffect, useState, type ReactElement } from 'react';
import {
  VscodeButton,
  VscodeIcon,
  VscodeProgressRing,
} from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import type {
  InstallProgress,
  InstallStage,
  InstallTarget,
  ModelGroupStatus,
  PythonValidationResult,
} from '../../../shared/envTypes';
import { MODEL_GROUP_META } from '../../../shared/envTypes';
import { useEnvironment } from '../../context/EnvironmentContext';
import {
  cancelEnvironmentInstall,
  DEFAULT_BACKEND_BASE_URL,
  loadInstallProgress,
  pickPythonInterpreter,
  showItemInFolder,
  validatePythonInterpreter,
} from '../../services/environmentService';
import './EnvironmentWizard.css';

type WizardStep = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<WizardStep, string> = {
  1: '后端连接',
  2: 'Agent 编排',
  3: '推理服务',
  4: '模型清单',
};

const STAGE_LABELS: Record<InstallStage, string> = {
  pending: '等待开始',
  'prepare-runtime': '准备运行时',
  'create-venv': '创建虚拟环境',
  'install-deps': '安装依赖',
  verify: '验证环境',
  done: '安装完成',
  failed: '安装失败',
  cancelled: '已取消',
};

function isInstallActive(progress: InstallProgress | null): boolean {
  return Boolean(
    progress &&
    progress.stage !== 'done' &&
    progress.stage !== 'failed' &&
    progress.stage !== 'cancelled',
  );
}

function StatusBadge({
  ok,
  label,
}: {
  ok: boolean;
  label: string;
}): ReactElement {
  return (
    <span
      className={`env-wizard-badge ${ok ? 'env-wizard-badge-ok' : 'env-wizard-badge-bad'}`}
    >
      {label}
    </span>
  );
}

/** 手动指定 Python 解释器（可选配置）：保存后写入 environment.json 覆盖 */
function PythonOverrideField({
  id,
  value,
  placeholder,
  saving,
  onChange,
  onSave,
}: {
  id: string;
  value: string;
  placeholder: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
}): ReactElement {
  const [validation, setValidation] = useState<PythonValidationResult | null>(
    null,
  );
  const [validating, setValidating] = useState(false);

  const runValidation = async (path: string): Promise<void> => {
    const trimmed = path.trim();
    if (!trimmed) {
      setValidation({ state: 'empty' });
      return;
    }
    setValidating(true);
    const result = await validatePythonInterpreter(trimmed);
    setValidation(result ?? null);
    setValidating(false);
  };

  // 挂载时若已有覆盖值，自动校验一次，让用户进入即看到当前解释器是否可用
  useEffect(() => {
    if (value.trim()) {
      void runValidation(value);
    }
    // 仅需在首次挂载时读取初始 value，刻意不随后续输入变化重复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBrowse = async (): Promise<void> => {
    const picked = await pickPythonInterpreter();
    if (!picked) return;
    onChange(picked);
    await runValidation(picked);
  };

  const handleSave = async (): Promise<void> => {
    await onSave();
    await runValidation(value);
  };

  return (
    <div className="env-wizard-override">
      <div className="env-wizard-field">
        <label className="env-wizard-label" htmlFor={id}>
          手动指定 Python 解释器（可选）
        </label>
        <div className="env-wizard-python-row">
          <input
            id={id}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(event) => {
              onChange(event.target.value);
              setValidation(null);
            }}
            onBlur={() => void runValidation(value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleSave();
              }
            }}
            spellCheck={false}
          />
          <VscodeButton
            secondary
            icon="folder-opened"
            type="button"
            onClick={handleBrowse}
          >
            浏览
          </VscodeButton>
          <VscodeButton
            secondary
            icon="save"
            type="button"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? '保存中…' : '保存'}
          </VscodeButton>
        </div>
        {value.trim() !== '' &&
          (validating ? (
            <span className="env-wizard-hint">正在检测解释器…</span>
          ) : validation?.state === 'valid' ? (
            <span className="env-wizard-badge env-wizard-badge-ok">
              可用{validation.version ? ` · Python ${validation.version}` : ''}
            </span>
          ) : validation?.state === 'invalid' ? (
            <span className="env-wizard-badge env-wizard-badge-bad">
              {validation.reason ?? '不可用'}
            </span>
          ) : null)}
        <span className="env-wizard-hint">
          自动检测失败时在此指定解释器路径；留空并保存则恢复自动检测。
        </span>
      </div>
    </div>
  );
}

function InstallPanel({
  progress,
  onCancel,
}: {
  progress: InstallProgress;
  onCancel: () => void;
}): ReactElement {
  const active = isInstallActive(progress);
  return (
    <div className="env-wizard-install">
      <div className="env-wizard-install-head">
        <span>
          阶段：{STAGE_LABELS[progress.stage]}
          {progress.variant
            ? `（${progress.variant === 'gpu' ? 'CUDA/GPU' : 'CPU'}）`
            : ''}
        </span>
        {active && (
          <span className="env-wizard-install-running">
            <VscodeProgressRing />
            安装进行中，可关闭向导后台继续
          </span>
        )}
      </div>
      {progress.lines.length > 0 && (
        <pre className="env-wizard-install-log">
          {progress.lines.join('\n')}
        </pre>
      )}
      {progress.stage === 'done' && (
        <div className="env-wizard-install-result env-wizard-install-result-ok">
          安装完成。关闭并重新使用相关功能即可生效。
        </div>
      )}
      {progress.stage === 'failed' && (
        <div className="env-wizard-install-result env-wizard-install-result-bad">
          安装失败：{progress.error ?? '未知错误'}
        </div>
      )}
      {progress.stage === 'cancelled' && (
        <div className="env-wizard-install-result">
          安装已取消，可随时重新开始。
        </div>
      )}
      {active && (
        <div className="env-wizard-install-actions">
          <VscodeButton secondary icon="close" type="button" onClick={onCancel}>
            取消安装
          </VscodeButton>
        </div>
      )}
    </div>
  );
}

function ModelGroupList({
  groups,
}: {
  groups: ModelGroupStatus[];
}): ReactElement {
  return (
    <div className="env-wizard-models">
      {MODEL_GROUP_META.map((meta) => {
        const group = groups.find((g) => g.modelType === meta.modelType);
        const registered = group?.registered ?? 0;
        return (
          <div key={meta.modelType} className="env-wizard-model-group">
            <div className="env-wizard-model-head">
              <span className="env-wizard-model-name">{meta.label}</span>
              {registered > 0 ? (
                <StatusBadge ok label={`已配置 ${registered} 个`} />
              ) : (
                <StatusBadge ok={false} label="未配置" />
              )}
            </div>
            <div className="env-wizard-model-hint">{meta.hint}</div>
            {group?.checkpointPaths.map((p: string) => (
              <div key={p} className="env-wizard-model-path-row">
                <span className="env-wizard-model-path" title={p}>
                  {p}
                </span>
                <VscodeButton
                  secondary
                  icon="folder"
                  iconOnly
                  type="button"
                  title="打开目录"
                  aria-label={`打开目录：${p}`}
                  className="env-wizard-icon-btn"
                  onClick={() => showItemInFolder(p)}
                />
              </div>
            ))}
          </div>
        );
      })}
      <div className="env-wizard-models-note">
        添加权重后，可在左侧「预训练模型」面板扫描注册，再点标题栏刷新图标刷新状态。
      </div>
    </div>
  );
}

function InstallActionButton({
  installed,
  disabled,
  onClick,
}: {
  installed: boolean;
  disabled: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <VscodeButton
      secondary={installed}
      icon="desktop-download"
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      {installed ? '重新安装' : '一键安装'}
    </VscodeButton>
  );
}

export default function EnvironmentWizard(): ReactElement | null {
  const {
    status,
    loading,
    refresh,
    wizardOpen,
    closeWizard,
    completeFirstRun,
    dismissFirstRun,
    saveBackendUrl,
    savePythonOverride,
    startInstall,
  } = useEnvironment();

  const [step, setStep] = useState<WizardStep>(1);
  const [backendUrl, setBackendUrl] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallProgress | null>(null);
  const [overrideLocal, setOverrideLocal] = useState('');
  const [overrideInference, setOverrideInference] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);

  useEffect(() => {
    if (!wizardOpen) return;
    setStep(1);
    setError(null);
    setConnecting(false);
    loadInstallProgress()
      .then(setInstall)
      .catch(() => undefined);
  }, [wizardOpen]);

  useEffect(() => {
    if (status) {
      setBackendUrl(
        status.settings.backendBaseUrl.trim() || DEFAULT_BACKEND_BASE_URL,
      );
      setOverrideLocal(status.settings.localAgentPythonOverride);
      setOverrideInference(status.settings.inferencePythonOverride);
    }
  }, [status]);

  useEffect(() => {
    const unsubscribe = window.electron?.env?.onInstallProgress?.((progress) =>
      setInstall(progress),
    );
    return () => unsubscribe?.();
  }, []);

  if (!wizardOpen) return null;

  const handleClose = () => {
    closeWizard();
  };

  const handleTestBackend = async () => {
    setConnecting(true);
    setError(null);
    try {
      if (backendUrl.trim()) {
        await saveBackendUrl(backendUrl.trim());
      }
      await refresh();
    } finally {
      setConnecting(false);
    }
  };

  const handleNext = async () => {
    setError(null);
    if (step === 1) {
      setSavingUrl(true);
      try {
        await saveBackendUrl(backendUrl.trim());
      } finally {
        setSavingUrl(false);
      }
    }
    setStep((current) => Math.min(4, current + 1) as WizardStep);
  };

  const handleBack = () => {
    setError(null);
    setStep((current) => Math.max(1, current - 1) as WizardStep);
  };

  const handleInstall = async (target: InstallTarget) => {
    setError(null);
    setInstall(null);
    const result = await startInstall(target);
    if (!result.ok) {
      setError(result.error ?? '安装启动失败');
    }
  };

  const handleCancelInstall = async () => {
    await cancelEnvironmentInstall();
  };

  const handleSaveOverride = async (target: InstallTarget) => {
    setSavingOverride(true);
    setError(null);
    try {
      await savePythonOverride(
        target,
        target === 'local-agent' ? overrideLocal : overrideInference,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSavingOverride(false);
    }
  };

  const handleSkip = async () => {
    await dismissFirstRun();
    handleClose();
  };

  const handleFinish = async () => {
    await completeFirstRun();
    handleClose();
  };

  const installFor = (target: InstallTarget): InstallProgress | null =>
    install && install.target === target ? install : null;

  const installActive = isInstallActive(install);

  const localInfo = status
    ? {
        pythonPath: status.localAgent.pythonPath,
        pythonOk: status.localAgent.pythonOk,
        pythonFromVenv: status.localAgent.pythonFromVenv,
        depsInstalled: status.localAgent.depsInstalled,
      }
    : null;
  const inference = status?.inference ?? null;

  return (
    <ModalMotion
      open
      onClose={handleClose}
      closeOnBackdropClick={false}
      dialogClassName="env-wizard"
      dialogRole="form"
      labelledBy="env-wizard-title"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="env-wizard-header">
        <h3 id="env-wizard-title">环境检测与安装</h3>
        <div className="env-wizard-header-actions">
          <VscodeButton
            secondary
            icon="refresh"
            iconOnly
            iconSpin={loading}
            type="button"
            title={loading ? '正在重新检测…' : '重新检测'}
            aria-label={loading ? '正在重新检测' : '重新检测'}
            aria-busy={loading}
            className="env-wizard-icon-btn"
            disabled={loading}
            onClick={() => {
              void refresh();
            }}
          />
          <button
            type="button"
            className="env-wizard-close"
            aria-label="关闭"
            onClick={handleClose}
          >
            <VscodeIcon name="close" size={16} />
          </button>
        </div>
      </div>

      <div className="env-wizard-steps" aria-label="引导步骤">
        {([1, 2, 3, 4] as WizardStep[]).map((item) => (
          <span
            key={item}
            className={`env-wizard-step${
              step === item ? ' env-wizard-step-active' : ''
            }${step > item ? ' env-wizard-step-done' : ''}`}
          >
            {item}. {STEP_TITLES[item]}
          </span>
        ))}
      </div>

      {error && <div className="env-wizard-error">{error}</div>}

      {step === 1 && (
        <div className="env-wizard-body">
          <div className="env-wizard-field">
            <label className="env-wizard-label" htmlFor="env-backend-url">
              后端服务地址（含 /api/v1）
            </label>
            <input
              id="env-backend-url"
              type="text"
              value={backendUrl}
              onChange={(event) => setBackendUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleTestBackend();
                }
              }}
              placeholder={DEFAULT_BACKEND_BASE_URL}
            />
            <span className="env-wizard-hint">
              云端账户服务地址。后端不可达时可离线使用本地功能；更换地址后需重新登录。
            </span>
          </div>

          <div className="env-wizard-connect-row">
            <VscodeButton
              secondary
              icon="plug"
              type="button"
              disabled={connecting || savingUrl}
              onClick={handleTestBackend}
            >
              {connecting ? '测试中…' : '测试连接'}
            </VscodeButton>
            {status && !connecting && (
              <span className="env-wizard-connect-result">
                {status.backend.reachable ? (
                  <StatusBadge
                    ok
                    label={`可达（${status.backend.latencyMs ?? '?'} ms）`}
                  />
                ) : (
                  <StatusBadge ok={false} label="不可达" />
                )}
                {!status.backend.reachable && (
                  <span className="env-wizard-hint">
                    {status.backend.error}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      )}

      {step !== 1 && !status && (
        <div className="env-wizard-body">
          <div className="env-wizard-loading">
            <VscodeProgressRing />
            环境检测中…
          </div>
        </div>
      )}

      {step === 2 && localInfo && (
        <div className="env-wizard-body">
          <div className="env-wizard-status-row">
            <span className="env-wizard-status-label">Python 解释器</span>
            {localInfo.pythonOk ? (
              <StatusBadge ok label="已找到" />
            ) : (
              <StatusBadge ok={false} label="未找到" />
            )}
          </div>
          {localInfo.pythonPath && (
            <div className="env-wizard-mono" title={localInfo.pythonPath}>
              {localInfo.pythonPath}
            </div>
          )}
          <PythonOverrideField
            id="env-local-python-override"
            value={overrideLocal}
            placeholder="例如 D:\\anaconda3\\envs\\lr-agent-local\\python.exe"
            saving={savingOverride}
            onChange={setOverrideLocal}
            onSave={() => handleSaveOverride('local-agent')}
          />
          <div className="env-wizard-status-row">
            <span className="env-wizard-status-label">依赖环境</span>
            {!localInfo.pythonOk ? (
              <StatusBadge ok={false} label="未检测到" />
            ) : localInfo.pythonFromVenv ? (
              localInfo.depsInstalled ? (
                <StatusBadge ok label="已安装（嵌入式运行时）" />
              ) : (
                <StatusBadge ok={false} label="未安装" />
              )
            ) : (
              <StatusBadge ok label="由当前解释器提供" />
            )}
          </div>
          <div className="env-wizard-status-row">
            <span className="env-wizard-status-label">服务状态</span>
            {status?.localAgent.serviceRunning ? (
              <StatusBadge ok label="运行中" />
            ) : (
              <StatusBadge ok={false} label="未运行" />
            )}
          </div>

          <div className="env-wizard-hint">
            Agent 编排服务（Assist 工具循环 / 标注与质量报告编排）由本机 Python
            环境运行。检测到开发用 conda
            环境时无需安装；缺失时可一键安装到内置运行时
            （约几分钟，不影响现有开发环境）。
          </div>

          {installFor('local-agent') && (
            <InstallPanel
              progress={installFor('local-agent')!}
              onCancel={handleCancelInstall}
            />
          )}
          {!isInstallActive(installFor('local-agent')) && (
            <div className="env-wizard-actions-inline">
              <InstallActionButton
                installed={localInfo.depsInstalled}
                disabled={installActive}
                onClick={() => handleInstall('local-agent')}
              />
            </div>
          )}
        </div>
      )}

      {step === 3 && inference && (
        <div className="env-wizard-body">
          <div className="env-wizard-status-row">
            <span className="env-wizard-status-label">Python 解释器</span>
            {inference.pythonOk ? (
              <StatusBadge ok label="已找到" />
            ) : (
              <StatusBadge ok={false} label="未找到" />
            )}
          </div>
          {inference.pythonPath && (
            <div className="env-wizard-mono" title={inference.pythonPath}>
              {inference.pythonPath}
            </div>
          )}
          <PythonOverrideField
            id="env-inference-python-override"
            value={overrideInference}
            placeholder="例如 D:\\anaconda3\\envs\\lr-agent-inference\\python.exe"
            saving={savingOverride}
            onChange={setOverrideInference}
            onSave={() => handleSaveOverride('inference')}
          />

          <div className="env-wizard-status-row">
            <span className="env-wizard-status-label">依赖环境</span>
            {!inference.pythonOk ? (
              <StatusBadge ok={false} label="未检测到" />
            ) : inference.pythonFromVenv ? (
              inference.depsInstalled ? (
                <StatusBadge ok label="已安装（嵌入式运行时）" />
              ) : (
                <StatusBadge ok={false} label="未安装" />
              )
            ) : (
              <StatusBadge ok label="由当前解释器提供" />
            )}
          </div>

          {inference.runtime?.pythonVersion && (
            <div className="env-wizard-runtime-grid">
              <span>Python {inference.runtime.pythonVersion}</span>
              <span>torch {inference.runtime.torchVersion ?? '未安装'}</span>
              <span>
                CUDA {inference.runtime.cudaAvailable ? '可用' : '不可用'}
              </span>
              <span>
                ultralytics {inference.runtime.ultralytics ? '✓' : '✗'}
              </span>
              <span>sam2 {inference.runtime.sam2 ? '✓' : '✗'}</span>
              <span>mediapipe {inference.runtime.mediapipe ? '✓' : '✗'}</span>
            </div>
          )}

          <div className="env-wizard-hint">
            推理服务（预标注 YOLO/SAM2/关键点）依赖较重：安装时自动探测 NVIDIA
            GPU， 有 GPU 装 CUDA 版（约 3 GB），否则装 CPU 版（约 200
            MB）。全程可取消。
          </div>

          {installFor('inference') && (
            <InstallPanel
              progress={installFor('inference')!}
              onCancel={handleCancelInstall}
            />
          )}
          {!isInstallActive(installFor('inference')) && (
            <div className="env-wizard-actions-inline">
              <InstallActionButton
                installed={inference.depsInstalled}
                disabled={installActive}
                onClick={() => handleInstall('inference')}
              />
            </div>
          )}
        </div>
      )}

      {step === 4 && status && (
        <div className="env-wizard-body">
          <ModelGroupList groups={status.models} />
        </div>
      )}

      <div className="env-wizard-footer">
        <div className="env-wizard-footer-left">
          {!status?.settings.firstRunCompleted && (
            <VscodeButton
              secondary
              icon="debug-step-over"
              type="button"
              onClick={handleSkip}
            >
              跳过引导
            </VscodeButton>
          )}
        </div>
        <div className="env-wizard-footer-right">
          {step > 1 && (
            <VscodeButton
              secondary
              icon="chevron-left"
              type="button"
              onClick={handleBack}
            >
              上一步
            </VscodeButton>
          )}
          {step < 4 ? (
            <VscodeButton
              iconAfter="chevron-right"
              type="button"
              disabled={savingUrl}
              onClick={handleNext}
            >
              下一步
            </VscodeButton>
          ) : (
            <VscodeButton icon="check" type="button" onClick={handleFinish}>
              完成
            </VscodeButton>
          )}
        </div>
      </div>
    </ModalMotion>
  );
}
