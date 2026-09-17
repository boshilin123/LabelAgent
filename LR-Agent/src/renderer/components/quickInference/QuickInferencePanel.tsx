import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  VscodeButton,
  VscodeProgressRing,
} from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { useApp } from '../../context/AppContext';
import { useLlmProviders } from '../../context/LlmProvidersContext';
import { usePretrainedModels } from '../../context/PretrainedModelsContext';
import { useToast } from '../../context/ToastContext';
import { useWorkMode } from '../../context/WorkModeContext';
import { getAnnotationTypeLabel } from '../../types/annotation';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import type { AnnotationPipelineStep } from '../../types/agent';
import { basename } from '../../types/file';
import { applyAnnotationProposalWithGuards } from '../../services/agentProposalApply';
import { syncWorkspaceFactMemory } from '../../services/workspaceFactMemory';
import { runQuickInferenceJob } from '../../services/quickInference/quickInferenceJob';
import {
  evaluateQuickInferenceReadiness,
  isQuickInferenceSupported,
} from '../../services/quickInference/quickInferenceSupport';
import AgentAnnotationChangeBlock from '../agent/AgentAnnotationChangeBlock';
import AgentAnnotationPipelineBlock from '../agent/AgentAnnotationPipelineBlock';
import AgentModelPicker from '../agent/AgentModelPicker';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import './QuickInferencePanel.css';

const PROVIDER_STORAGE_KEY = 'quickInference.providerId';

type QuickInferencePhase =
  'idle' | 'running' | 'proposal' | 'applied' | 'dismissed' | 'error';

function loadSavedProviderId(): string | null {
  try {
    return localStorage.getItem(PROVIDER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveProviderId(providerId: string): void {
  try {
    localStorage.setItem(PROVIDER_STORAGE_KEY, providerId);
  } catch {
    // ignore quota errors
  }
}

export default function QuickInferencePanel() {
  const { workMode } = useWorkMode();
  const { activeProject } = useAnnotation();
  const { activeFilePath } = useApp();
  const { providers, defaultProvider } = useLlmProviders();
  const { models: detectionModels } = usePretrainedModels();
  const { showToast } = useToast();
  const { projectRootMatched, relativeFilePath, activeTemplateId } =
    useAnnotationWorkspace();

  const enabledProviders = useMemo(
    () => providers.filter((item) => item.enabled),
    [providers],
  );

  const [selectedProviderId, setSelectedProviderId] = useState(() => {
    const saved = loadSavedProviderId();
    if (saved && enabledProviders.some((item) => item.id === saved)) {
      return saved;
    }
    return defaultProvider?.id ?? enabledProviders[0]?.id ?? '';
  });

  const [phase, setPhase] = useState<QuickInferencePhase>('idle');
  const [proposal, setProposal] = useState<AnnotationBatchProposal | null>(
    null,
  );
  const [progressMessage, setProgressMessage] = useState('');
  const [pipelineSteps, setPipelineSteps] = useState<AnnotationPipelineStep[]>(
    [],
  );
  const [summaryText, setSummaryText] = useState('');
  const [pipelineCollapsed, setPipelineCollapsed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!selectedProviderId && defaultProvider?.id) {
      setSelectedProviderId(defaultProvider.id);
    }
  }, [defaultProvider?.id, selectedProviderId]);

  useEffect(() => {
    if (
      selectedProviderId &&
      !enabledProviders.some((item) => item.id === selectedProviderId)
    ) {
      setSelectedProviderId(
        defaultProvider?.id ?? enabledProviders[0]?.id ?? '',
      );
    }
  }, [defaultProvider?.id, enabledProviders, selectedProviderId]);

  const selectedProvider = useMemo(
    () =>
      enabledProviders.find((item) => item.id === selectedProviderId) ??
      defaultProvider,
    [defaultProvider, enabledProviders, selectedProviderId],
  );

  const annotationModeActive = workMode === 'annotation';

  const { canRun, disabledReason } = useMemo(
    () =>
      evaluateQuickInferenceReadiness({
        annotationModeActive,
        project: activeProject,
        projectRootMatched,
        relativeFilePath,
        provider: selectedProvider,
        detectionModels,
        keypointTemplateId: activeTemplateId,
        running: phase === 'running',
      }),
    [
      annotationModeActive,
      activeProject,
      projectRootMatched,
      relativeFilePath,
      selectedProvider,
      detectionModels,
      activeTemplateId,
      phase,
    ],
  );

  const resetState = useCallback(() => {
    setPhase('idle');
    setProposal(null);
    setProgressMessage('');
    setPipelineSteps([]);
    setSummaryText('');
    setPipelineCollapsed(false);
    setErrorMessage(null);
  }, []);

  const abortRunning = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    abortRunning();
    resetState();
  }, [relativeFilePath, abortRunning, resetState]);

  useEffect(
    () => () => {
      abortRunning();
    },
    [abortRunning],
  );

  const handleProviderSelect = useCallback((providerId: string) => {
    setSelectedProviderId(providerId);
    saveProviderId(providerId);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (
      !canRun ||
      !activeProject ||
      !selectedProvider ||
      !relativeFilePath ||
      !activeFilePath
    ) {
      return;
    }

    abortRunning();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('running');
    setProposal(null);
    setErrorMessage(null);
    setPipelineSteps([]);
    setSummaryText('');
    setPipelineCollapsed(false);
    setProgressMessage('正在准备…');

    const result = await runQuickInferenceJob({
      provider: selectedProvider,
      project: activeProject,
      detectionModels,
      currentFileAbsolutePath: activeFilePath,
      scopeHint: relativeFilePath,
      onProgress: setProgressMessage,
      onPipelineUpdate: setPipelineSteps,
      onSummaryUpdate: setSummaryText,
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      resetState();
      return;
    }

    abortRef.current = null;

    if (result.ok) {
      setProposal(result.proposal);
      setPipelineSteps(result.pipelineSteps);
      setSummaryText(result.summaryText);
      setPhase('proposal');
      setProgressMessage('');
      return;
    }

    if (result.cancelled) {
      resetState();
      return;
    }

    setPhase('error');
    setErrorMessage(result.error);
    showToast(result.error, { type: 'error' });
  }, [
    canRun,
    activeProject,
    selectedProvider,
    relativeFilePath,
    activeFilePath,
    detectionModels,
    abortRunning,
    resetState,
    showToast,
  ]);

  const handleApply = useCallback(async () => {
    if (!activeProject || !proposal || phase !== 'proposal') return;
    setApplying(true);
    try {
      await applyAnnotationProposalWithGuards(activeProject, proposal);
      await syncWorkspaceFactMemory(activeProject);
      setPhase('applied');
      showToast('标注提案已应用', { type: 'success' });
    } catch (err) {
      const message = err instanceof Error ? err.message : '应用失败';
      if (message !== '用户取消应用') {
        showToast(message, { type: 'error' });
      }
    } finally {
      setApplying(false);
    }
  }, [activeProject, proposal, phase, showToast]);

  const handleDismiss = useCallback(() => {
    resetState();
  }, [resetState]);

  const currentFileLabel = relativeFilePath
    ? basename(relativeFilePath)
    : '未打开文件';

  const taskTypeLabel = activeProject
    ? getAnnotationTypeLabel(
        activeProject.modality,
        activeProject.annotationType,
      )
    : '—';

  const showProposalBlock =
    proposal != null && (phase === 'proposal' || phase === 'applied');

  const blockStatus = phase === 'applied' ? 'applied' : 'pending';

  const showApplyBar = phase === 'proposal';

  const isBbox = activeProject?.annotationType === 'bbox';
  const isSupportedType =
    activeProject != null &&
    isQuickInferenceSupported(activeProject.annotationType);

  const showPipelineBlock = pipelineSteps.length > 0;
  const pipelineCompleted = phase === 'proposal' || phase === 'applied';

  return (
    <div className="quick-inference-root">
      {/* fillHost：宿主拿到 flex:1/min-height:0 才能给内层确定高度，否则内容溢出后滚不动 */}
      <OverlayVerticalScrollArea
        enabled
        fillHost
        className="quick-inference-scroll"
        contentClassName="quick-inference-scroll-content"
      >
        <section className="quick-inference-section">
          <div className="quick-inference-meta">
            <div className="quick-inference-meta-row">
              <span className="quick-inference-meta-label">当前文件</span>
              <span
                className="quick-inference-meta-value"
                title={relativeFilePath ?? undefined}
              >
                {currentFileLabel}
              </span>
            </div>
            <div className="quick-inference-meta-row">
              <span className="quick-inference-meta-label">任务类型</span>
              <span className="quick-inference-meta-value">
                {taskTypeLabel}
              </span>
            </div>
          </div>
        </section>

        <section className="quick-inference-section">
          <h4 className="quick-inference-heading">大模型</h4>
          <AgentModelPicker
            providers={enabledProviders}
            selectedId={selectedProviderId}
            disabled={phase === 'running'}
            inline
            menuPlacement="below"
            onSelect={handleProviderSelect}
          />
        </section>

        <section className="quick-inference-section quick-inference-actions">
          <VscodeButton
            icon="sparkle"
            className="quick-inference-generate-btn"
            disabled={!canRun}
            title={disabledReason ?? undefined}
            onClick={() => {
              void handleGenerate();
            }}
          >
            生成标注
          </VscodeButton>

          {phase === 'running' ? (
            <div className="quick-inference-progress">
              <VscodeProgressRing />
              <span className="quick-inference-progress-text">
                {progressMessage || '正在生成…'}
              </span>
              <VscodeButton
                secondary
                icon="close"
                className="quick-inference-cancel-btn"
                onClick={() => {
                  abortRunning();
                  resetState();
                }}
              >
                取消
              </VscodeButton>
            </div>
          ) : null}

          {phase === 'error' && errorMessage ? (
            <p className="quick-inference-error">{errorMessage}</p>
          ) : null}

          {!isSupportedType && activeProject ? (
            <p className="quick-inference-muted">
              {disabledReason ?? '当前标注类型暂不支持快捷推理'}
            </p>
          ) : null}

          {isBbox && isSupportedType ? (
            <p className="quick-inference-muted">
              bbox
              快捷推理需配置检测预训练模型并完成云端登录；大模型用于标签映射与复核。
            </p>
          ) : null}
        </section>

        {showPipelineBlock ? (
          <section className="quick-inference-section quick-inference-pipeline">
            <AgentAnnotationPipelineBlock
              steps={pipelineSteps}
              collapsed={pipelineCollapsed}
              streaming={phase === 'running'}
              pipelineCompleted={pipelineCompleted}
              batchCompleted={pipelineCompleted}
              pipelineKind="batch"
              onToggle={() => setPipelineCollapsed((value) => !value)}
            />
          </section>
        ) : null}

        {summaryText.trim() && (phase === 'proposal' || phase === 'applied') ? (
          <section className="quick-inference-section">
            <p className="quick-inference-summary">{summaryText.trim()}</p>
          </section>
        ) : null}

        {showProposalBlock && proposal ? (
          <section className="quick-inference-section quick-inference-proposal">
            <AgentAnnotationChangeBlock
              messageId="quick-inference"
              blockIndex={0}
              proposal={proposal}
              status={blockStatus}
            />
          </section>
        ) : null}
      </OverlayVerticalScrollArea>

      {showApplyBar ? (
        <footer className="quick-inference-apply-bar">
          <VscodeButton
            icon="check"
            className="quick-inference-apply-btn"
            disabled={applying}
            onClick={() => {
              void handleApply();
            }}
          >
            {applying ? '应用中…' : '应用到当前文件'}
          </VscodeButton>
          <VscodeButton
            secondary
            icon="discard"
            disabled={applying}
            onClick={handleDismiss}
          >
            放弃
          </VscodeButton>
        </footer>
      ) : null}
    </div>
  );
}
