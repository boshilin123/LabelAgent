import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  VscodeButton,
  VscodeProgressRing,
} from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { buildAnnotationProjectSnapshot } from '../../services/buildProjectSnapshot';
import { deriveCurrentFolderPath } from '../../services/annotationQuality/buildQualitySnapshot';
import { loadQualityDashboard } from '../../services/annotationQuality/reportGenerationRunner';
import type {
  QualityDashboardViewModel,
  QualityScope,
} from '../../services/annotationQuality/types';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import QualityFindingList from './QualityFindingList';
import QualityMetricCard from './QualityMetricCard';
import QualityScopeToggle from './QualityScopeToggle';
import ReportGenerationSection from './ReportGenerationSection';
import ReportHistoryList from './ReportHistoryList';
import './QualityDashboardPanel.css';

export default function QualityDashboardPanel() {
  const { activeProject } = useAnnotation();
  const { relativeFilePath } = useAnnotationWorkspace();
  const [scope, setScope] = useState<QualityScope>('full_project');
  const [viewModel, setViewModel] = useState<QualityDashboardViewModel | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [collectProgress, setCollectProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  const scopePath = useMemo(
    () => deriveCurrentFolderPath(relativeFilePath),
    [relativeFilePath],
  );

  const isSupported =
    activeProject?.modality === 'image' &&
    activeProject.annotationType === 'bbox';

  const projectSnapshot = useMemo(
    () =>
      activeProject ? buildAnnotationProjectSnapshot(activeProject, []) : null,
    [activeProject],
  );

  const refresh = useCallback(async () => {
    if (!projectSnapshot || !isSupported) return;
    setLoading(true);
    setError(null);
    setCollectProgress(null);
    try {
      const result = await loadQualityDashboard({
        project: projectSnapshot,
        scope,
        scopePath: scope === 'current_folder' ? scopePath : undefined,
        relativeFilePath,
        onCollectProgress: (processed, total) => {
          setCollectProgress(`${processed}/${total}`);
        },
      });
      setViewModel(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载质量看板失败');
      setViewModel(null);
    } finally {
      setLoading(false);
      setCollectProgress(null);
    }
  }, [isSupported, projectSnapshot, relativeFilePath, scope, scopePath]);

  useEffect(() => {
    if (isSupported) {
      refresh().catch(() => undefined);
    }
  }, [isSupported, refresh]);

  if (!activeProject) {
    return (
      <div className="quality-dashboard quality-dashboard--empty">
        <p>请先打开标注项目</p>
      </div>
    );
  }

  if (!isSupported) {
    return (
      <div className="quality-dashboard quality-dashboard--empty">
        <p>当前标注类型暂不支持质量看板</p>
        <p className="quality-dashboard-hint">
          P0 仅支持图片矩形框（bbox）项目
        </p>
      </div>
    );
  }

  const chartMetrics =
    viewModel?.metrics.filter((m) => m.chartBindings.length > 0) ?? [];

  return (
    <div className="quality-dashboard">
      <header className="quality-dashboard__header">
        <div className="quality-dashboard__header-main">
          <h2 className="quality-dashboard__title">质量看板</h2>
          <QualityScopeToggle
            scope={scope}
            scopePath={scopePath}
            onChange={setScope}
          />
        </div>
        <VscodeButton
          secondary
          icon="refresh"
          type="button"
          disabled={loading}
          title="刷新"
          onClick={() => refresh()}
        >
          刷新
        </VscodeButton>
      </header>

      {loading ? (
        <p className="quality-dashboard-status">
          <VscodeProgressRing />
          正在加载…{collectProgress ? ` (${collectProgress})` : ''}
        </p>
      ) : null}
      {error ? <p className="quality-error">{error}</p> : null}

      <OverlayVerticalScrollArea
        enabled
        fillHost
        className="quality-dashboard-scroll-host"
        contentClassName="quality-dashboard-scrollable"
        observeKey={`${scope}-${viewModel?.snapshot.totalFiles ?? 0}`}
      >
        {viewModel ? (
          <>
            <div className="quality-summary">
              <span>{viewModel.snapshot.totalFiles} 张图</span>
              <span>{viewModel.snapshot.annotatedFiles} 已标注</span>
              <span>{viewModel.snapshot.totalBoxes} 个框</span>
              <span>{viewModel.findings.length} 条发现</span>
            </div>

            <div className="quality-metrics-grid">
              {chartMetrics.map((metric) => (
                <QualityMetricCard key={metric.id} metric={metric} />
              ))}
            </div>

            <section className="quality-findings-section">
              <h3 className="quality-section-title">一致性问题</h3>
              <QualityFindingList findings={viewModel.findings} />
            </section>

            {projectSnapshot ? (
              <ReportGenerationSection
                project={projectSnapshot}
                scope={scope}
                scopePath={scope === 'current_folder' ? scopePath : undefined}
                relativeFilePath={relativeFilePath}
                onComplete={() => setHistoryRefreshKey((k) => k + 1)}
              />
            ) : null}

            <ReportHistoryList
              projectDir={activeProject.directoryPath}
              refreshKey={historyRefreshKey}
            />
          </>
        ) : null}
      </OverlayVerticalScrollArea>
    </div>
  );
}
