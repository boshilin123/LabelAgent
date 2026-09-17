import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import ActivityBar, { type LeftPanel, type RightPanel } from './ActivityBar';
import AnnotationRightPanel from './annotation/AnnotationRightPanel';
import AgentPanel from './agent/AgentPanel';
import QualityDashboardPanel from './quality/QualityDashboardPanel';
import QuickInferencePanel from './quickInference/QuickInferencePanel';
import OfflineConnectivityNotifier from './OfflineConnectivityNotifier';
import EnvironmentBanner from './environment/EnvironmentBanner';
import EnvironmentWizard from './environment/EnvironmentWizard';
import FileTree from './FileTree';
import EditorTabBar from './editor/EditorTabBar';
import EditorFileSiblingNav from './editor/EditorFileSiblingNav';
import EditorWorkspace from './editor/EditorWorkspace';
import LlmProvidersPanel from './llmProviders/LlmProvidersPanel';
import McpPanel from './mcp/McpPanel';
import SkillsPanel from './skills/SkillsPanel';
import PretrainedModelsPanel from './pretrainedModels/PretrainedModelsPanel';
import SettingsPanel from './SettingsPanel';
import Sidebar from './Sidebar';
import PanelTransition from '../motion/PanelTransition';
import WorkModeContentTransition from '../motion/WorkModeContentTransition';
import { motionDuration, motionEase } from '../motion/tokens';
import AnnotationProjectPanel from './annotation/AnnotationProjectPanel';
import CreateAnnotationProjectWizard from './annotation/CreateAnnotationProjectWizard';
import EditAnnotationProjectModal from './annotation/EditAnnotationProjectModal';
import ExportAnnotationWizard from './annotation/ExportAnnotationWizard';
import WorkspaceMemoryPanel from './annotation/WorkspaceMemoryPanel';
import RightPanelToolbar from './RightPanelToolbar';
import { useAnnotation } from '../context/AnnotationContext';
import { useWorkMode, type WorkMode } from '../context/WorkModeContext';
import { useEnvironment } from '../context/EnvironmentContext';
import './Layout.css';

const ACTIVITY_BAR_WIDTH = 48;
const RESIZER_WIDTH = 4;

const LEFT_PANEL_TITLES: Record<LeftPanel, string> = {
  explorer: '资源管理器',
  annotations: '标注任务',
  models: '预训练模型',
  llmProviders: '大模型配置',
  mcp: 'MCP 工具',
  skills: 'Agent Skills',
  settings: '账户设置',
};

function renderLeftPanel(panel: LeftPanel, onProjectOpened: () => void) {
  if (panel === 'settings') return <SettingsPanel />;
  if (panel === 'llmProviders') return <LlmProvidersPanel />;
  if (panel === 'mcp') return <McpPanel />;
  if (panel === 'skills') return <SkillsPanel />;
  if (panel === 'models') return <PretrainedModelsPanel />;
  if (panel === 'annotations') {
    return <AnnotationProjectPanel onProjectOpened={onProjectOpened} />;
  }
  return <FileTree />;
}

export default function Layout() {
  const {
    layout,
    minSidebarWidth,
    maxSidebarWidth,
    minMainContentWidth,
    setLeftWidth,
    setRightWidth,
    toggleLeftSidebar,
    expandLeftSidebar,
    openTabs,
    activeTabId,
    activeFilePath,
    selectFile,
    setActiveTab,
    closeTab,
    pinTab,
  } = useApp();
  const { refreshUser } = useAuth();
  const {
    createWizardOpen,
    closeCreateWizard,
    editingProject,
    closeEditProject,
    exportingProject,
    closeExportProject,
    memoryProject,
    closeWorkspaceMemory,
    activeProject,
  } = useAnnotation();
  const { workMode } = useWorkMode();
  const { status: envStatus, openWizard } = useEnvironment();
  const reducedMotion = useReducedMotion();

  const resizeSideRef = useRef<'left' | 'right' | null>(null);
  const resizeDraftRef = useRef<number | null>(null);
  const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(
    null,
  );
  const [resizeDraft, setResizeDraft] = useState<{
    side: 'left' | 'right';
    width: number;
  } | null>(null);
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('explorer');

  const [rightPanelByMode, setRightPanelByMode] = useState<
    Record<WorkMode, RightPanel>
  >({
    editor: 'agent',
    annotation: 'annotation',
  });
  const annotationModeActive =
    workMode === 'annotation' && Boolean(activeProject);
  const showRightPanelToolbar = workMode === 'editor' || annotationModeActive;
  const annotationTabDisabled = workMode === 'editor';
  const qualityTabDisabled = !annotationModeActive;
  const quickInferenceTabDisabled = workMode === 'editor';
  const rightPanel = rightPanelByMode[workMode];

  const setRightPanelForMode = useCallback(
    (panel: RightPanel) => {
      if (workMode === 'editor' && panel === 'annotation') return;
      if (workMode === 'editor' && panel === 'quality') return;
      if (workMode === 'editor' && panel === 'quickInference') return;
      setRightPanelByMode((prev) => ({ ...prev, [workMode]: panel }));
    },
    [workMode],
  );

  useEffect(() => {
    refreshUser().catch(() => undefined);
  }, [refreshUser]);

  // 首次登录后一次性自动拉起环境向导（跳过/完成后由横幅接管提示）
  const firstRunWizardTriggered = useRef(false);
  useEffect(() => {
    if (!envStatus || firstRunWizardTriggered.current) return;
    if (
      !envStatus.settings.firstRunCompleted &&
      !envStatus.settings.firstRunSeenAt
    ) {
      firstRunWizardTriggered.current = true;
      window.electron?.env?.markFirstRunSeen().catch(() => undefined);
      openWizard();
    }
  }, [envStatus, openWizard]);

  const { leftWidth, rightWidth, leftCollapsed, rightCollapsed } = layout;

  const displayLeftWidth =
    resizeDraft?.side === 'left' ? resizeDraft.width : leftWidth;
  const displayRightWidth =
    resizeDraft?.side === 'right' ? resizeDraft.width : rightWidth;

  const getMaxLeftWidth = useCallback(() => {
    const rightOccupied = rightCollapsed ? 0 : rightWidth + RESIZER_WIDTH;
    const spaceMax =
      window.innerWidth -
      ACTIVITY_BAR_WIDTH -
      RESIZER_WIDTH -
      minMainContentWidth -
      rightOccupied;
    return Math.max(minSidebarWidth, Math.min(maxSidebarWidth, spaceMax));
  }, [
    rightCollapsed,
    rightWidth,
    maxSidebarWidth,
    minMainContentWidth,
    minSidebarWidth,
  ]);

  const getMaxRightWidth = useCallback(() => {
    const leftOccupied = leftCollapsed
      ? ACTIVITY_BAR_WIDTH
      : ACTIVITY_BAR_WIDTH + leftWidth + RESIZER_WIDTH;
    const spaceMax =
      window.innerWidth - leftOccupied - RESIZER_WIDTH - minMainContentWidth;
    const ratioMax = Math.floor(window.innerWidth * 0.6);
    return Math.max(minSidebarWidth, Math.min(ratioMax, spaceMax));
  }, [leftCollapsed, leftWidth, minMainContentWidth, minSidebarWidth]);

  const clampLeftWidth = useCallback(
    (width: number) =>
      Math.min(Math.max(width, minSidebarWidth), getMaxLeftWidth()),
    [minSidebarWidth, getMaxLeftWidth],
  );

  const clampRightWidth = useCallback(
    (width: number) =>
      Math.min(Math.max(width, minSidebarWidth), getMaxRightWidth()),
    [minSidebarWidth, getMaxRightWidth],
  );

  useEffect(() => {
    if (resizingSide) return;

    if (!rightCollapsed) {
      const nextRight = clampRightWidth(rightWidth);
      if (nextRight !== rightWidth) {
        setRightWidth(nextRight);
        return;
      }
    }

    if (!leftCollapsed) {
      const nextLeft = clampLeftWidth(leftWidth);
      if (nextLeft !== leftWidth) {
        setLeftWidth(nextLeft);
      }
    }
  }, [
    resizingSide,
    leftCollapsed,
    rightCollapsed,
    leftWidth,
    rightWidth,
    clampLeftWidth,
    clampRightWidth,
    setLeftWidth,
    setRightWidth,
  ]);

  useEffect(() => {
    const onResize = () => {
      if (resizingSide) return;
      if (!leftCollapsed) {
        setLeftWidth(clampLeftWidth(leftWidth));
      }
      if (!rightCollapsed) {
        setRightWidth(clampRightWidth(rightWidth));
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [
    resizingSide,
    leftCollapsed,
    rightCollapsed,
    leftWidth,
    rightWidth,
    clampLeftWidth,
    clampRightWidth,
    setLeftWidth,
    setRightWidth,
  ]);

  const startResize = useCallback(
    (side: 'left' | 'right') => (e: ReactMouseEvent) => {
      if (side === 'left' && leftCollapsed) return;
      if (side === 'right' && rightCollapsed) return;

      e.preventDefault();
      const initialWidth =
        side === 'left'
          ? clampLeftWidth(leftWidth)
          : clampRightWidth(rightWidth);

      resizeSideRef.current = side;
      resizeDraftRef.current = initialWidth;
      setResizingSide(side);
      setResizeDraft({ side, width: initialWidth });

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.body.classList.add('is-resizing', `is-resizing-${side}`);

      let resizeRafId: number | null = null;

      const flushResizeDraft = () => {
        resizeRafId = null;
        const side = resizeSideRef.current;
        const width = resizeDraftRef.current;
        if (side == null || width == null) return;
        setResizeDraft({ side, width });
      };

      const onMove = (ev: { clientX: number }) => {
        if (resizeSideRef.current === 'left') {
          resizeDraftRef.current = clampLeftWidth(
            ev.clientX - ACTIVITY_BAR_WIDTH,
          );
        } else if (resizeSideRef.current === 'right') {
          resizeDraftRef.current = clampRightWidth(
            window.innerWidth - ev.clientX,
          );
        } else {
          return;
        }

        if (resizeRafId != null) return;
        resizeRafId = requestAnimationFrame(flushResizeDraft);
      };

      const onUp = () => {
        if (resizeRafId != null) {
          cancelAnimationFrame(resizeRafId);
          resizeRafId = null;
        }
        const activeSide = resizeSideRef.current;
        const finalWidth = resizeDraftRef.current;
        resizeSideRef.current = null;
        resizeDraftRef.current = null;
        setResizingSide(null);
        setResizeDraft(null);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.classList.remove(
          'is-resizing',
          'is-resizing-left',
          'is-resizing-right',
        );

        if (activeSide === 'left' && finalWidth != null) {
          setLeftWidth(finalWidth);
        }
        if (activeSide === 'right' && finalWidth != null) {
          setRightWidth(finalWidth);
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [
      leftCollapsed,
      rightCollapsed,
      leftWidth,
      rightWidth,
      clampLeftWidth,
      clampRightWidth,
      setLeftWidth,
      setRightWidth,
    ],
  );

  const openLeftPanel = useCallback(
    (panel: LeftPanel) => {
      if (!leftCollapsed && leftPanel === panel) {
        toggleLeftSidebar();
        return;
      }
      setLeftPanel(panel);
      if (leftCollapsed) {
        expandLeftSidebar();
      }
    },
    [leftCollapsed, leftPanel, toggleLeftSidebar, expandLeftSidebar],
  );

  const handleProjectOpened = useCallback(() => {
    setLeftPanel('explorer');
    if (leftCollapsed) {
      expandLeftSidebar();
    }
  }, [leftCollapsed, expandLeftSidebar]);

  const leftPanelActive = !leftCollapsed ? leftPanel : null;
  const leftSidebarTitle = LEFT_PANEL_TITLES[leftPanel];
  const showEditorTabStrip = openTabs.length > 0;
  /** 仅图片标注且已选文件时 ImageAnnotationToolbar 才会挂载 */
  const showImageAnnotationToolbarBand =
    workMode === 'annotation' &&
    activeProject?.modality === 'image' &&
    Boolean(activeFilePath);

  return (
    <div
      className={`layout${resizingSide ? ` is-resizing is-resizing-${resizingSide}` : ''}${workMode === 'editor' ? ' layout--editor-work-mode' : ''}${showImageAnnotationToolbarBand ? ' layout--image-annotation-toolbar' : ''} layout--editor-top-band`}
    >
      <OfflineConnectivityNotifier />
      <ActivityBar
        activePanel={leftPanelActive}
        onExplorerClick={() => openLeftPanel('explorer')}
        onAnnotationsClick={() => openLeftPanel('annotations')}
        onModelsClick={() => openLeftPanel('models')}
        onLlmProvidersClick={() => openLeftPanel('llmProviders')}
        onMcpClick={() => openLeftPanel('mcp')}
        onSkillsClick={() => openLeftPanel('skills')}
        onSettingsClick={() => openLeftPanel('settings')}
      />

      <Sidebar
        side="left"
        width={displayLeftWidth}
        collapsed={leftCollapsed}
        isResizing={resizingSide === 'left'}
        title={leftSidebarTitle}
      >
        <PanelTransition panelKey={leftPanel} className="sidebar-panel-motion">
          {renderLeftPanel(leftPanel, handleProjectOpened)}
        </PanelTransition>
      </Sidebar>

      <div className="editor-center">
        <div
          className={`editor-tab-strip${showEditorTabStrip ? '' : ' editor-tab-strip--empty'}`}
        >
          {!leftCollapsed ? (
            <div className="editor-tab-strip-sash" aria-hidden />
          ) : null}
          {showEditorTabStrip ? (
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                key="editor-tab-bar"
                className={`editor-tab-strip-tabs${
                  workMode === 'annotation' && activeFilePath
                    ? ' editor-tab-strip-tabs--annotation'
                    : ''
                }`}
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={{
                  duration: reducedMotion ? 0.1 : motionDuration.tab,
                  ease: motionEase,
                }}
              >
                <EditorTabBar
                  tabs={openTabs}
                  activeTabId={activeTabId}
                  onSelectTab={setActiveTab}
                  onCloseTab={closeTab}
                  onPinTab={pinTab}
                />
                {workMode === 'annotation' && activeFilePath ? (
                  <>
                    <EditorFileSiblingNav
                      filePath={activeFilePath}
                      onSelectFile={selectFile}
                    />
                    <div className="editor-tab-strip-spacer" aria-hidden />
                  </>
                ) : null}
              </motion.div>
            </AnimatePresence>
          ) : (
            <div className="editor-tab-strip-fill" aria-hidden="true" />
          )}
        </div>
        <div className="editor-center-body">
          {!leftCollapsed ? (
            <button
              type="button"
              className="resizer resizer-left"
              onMouseDown={startResize('left')}
              aria-label="调整左侧栏宽度"
            />
          ) : null}
          <main className="main-content">
            <EnvironmentBanner />
            <div className="main-content-body">
              <WorkModeContentTransition workMode={workMode}>
                <EditorWorkspace />
              </WorkModeContentTransition>
            </div>
          </main>
          {!rightCollapsed ? (
            <button
              type="button"
              className="resizer resizer-right"
              onMouseDown={startResize('right')}
              aria-label="调整右侧栏宽度"
            />
          ) : null}
        </div>
      </div>

      <Sidebar
        side="right"
        width={displayRightWidth}
        collapsed={rightCollapsed}
        isResizing={resizingSide === 'right'}
        showHeader={false}
      >
        {showRightPanelToolbar ? (
          <>
            <RightPanelToolbar
              activePanel={rightPanel}
              annotationTabDisabled={annotationTabDisabled}
              qualityTabDisabled={qualityTabDisabled}
              quickInferenceTabDisabled={quickInferenceTabDisabled}
              onAnnotationClick={() => {
                if (!annotationTabDisabled) {
                  setRightPanelForMode('annotation');
                }
              }}
              onAgentClick={() => setRightPanelForMode('agent')}
              onQuickInferenceClick={() => {
                if (!quickInferenceTabDisabled) {
                  setRightPanelForMode('quickInference');
                }
              }}
              onQualityClick={() => {
                if (!qualityTabDisabled) {
                  setRightPanelForMode('quality');
                }
              }}
            />
            <PanelTransition
              panelKey={rightPanel}
              className="sidebar-panel-motion"
              direction="up"
            >
              {rightPanel === 'annotation' && !annotationTabDisabled ? (
                <AnnotationRightPanel />
              ) : rightPanel === 'quickInference' &&
                !quickInferenceTabDisabled ? (
                <QuickInferencePanel />
              ) : rightPanel === 'quality' && !qualityTabDisabled ? (
                <QualityDashboardPanel />
              ) : (
                <AgentPanel />
              )}
            </PanelTransition>
          </>
        ) : (
          <div className="sidebar-panel-motion">
            <AgentPanel />
          </div>
        )}
      </Sidebar>

      <CreateAnnotationProjectWizard
        open={createWizardOpen}
        onClose={closeCreateWizard}
        onCreated={handleProjectOpened}
      />

      <EnvironmentWizard />

      {editingProject && (
        <EditAnnotationProjectModal
          project={editingProject}
          onClose={closeEditProject}
        />
      )}

      {memoryProject && (
        <WorkspaceMemoryPanel
          project={memoryProject}
          onClose={closeWorkspaceMemory}
        />
      )}

      <ExportAnnotationWizard
        project={exportingProject}
        onClose={closeExportProject}
      />
    </div>
  );
}
