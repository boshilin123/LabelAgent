import { useCallback, useEffect, useMemo, useState } from 'react';
import { VscodeIcon, VscodeLabel } from '@vscode-elements/react-elements';
import { useApp } from '../../context/AppContext';
import { useWorkMode } from '../../context/WorkModeContext';
import { useAgentFilePreview } from '../../hooks/useAgentFilePreview';
import { pathsEqual } from '../../services/agentFilePreviewStore';
import { checkBinaryFile } from '../../utils/binaryFileDetect';
import { isMonacoEditableFile } from '../../utils/editorFileTypes';
import EditorPane from './EditorPane';
import MonacoTextEditor from './MonacoTextEditor';
import MonacoDiffView from './MonacoDiffView';
import './EditorWorkspace.css';

export default function EditorWorkspace() {
  const { workMode } = useWorkMode();
  const { openTabs, activeTabId, markTabDirty, saveActiveTab, refreshTree } =
    useApp();
  const { filePreview } = useAgentFilePreview();

  const activeTab = useMemo(
    () => openTabs.find((tab) => tab.id === activeTabId) ?? null,
    [openTabs, activeTabId],
  );

  const previewForActiveTab = Boolean(
    filePreview &&
    activeTab &&
    pathsEqual(filePreview.absolutePath, activeTab.filePath),
  );

  // 预览默认只显示变更区域（Monaco hideUnchangedRegions），避免小改动也要滚完整份文件
  const [previewCollapsed, setPreviewCollapsed] = useState(true);
  useEffect(() => {
    setPreviewCollapsed(true);
  }, [filePreview]);

  const hasTabs = openTabs.length > 0;
  const [activeTabBinary, setActiveTabBinary] = useState(false);

  useEffect(() => {
    if (
      workMode !== 'editor' ||
      !activeTab ||
      !isMonacoEditableFile(activeTab.filePath)
    ) {
      setActiveTabBinary(false);
      return undefined;
    }

    let cancelled = false;
    checkBinaryFile(activeTab.filePath)
      .then((binary) => {
        if (!cancelled) setActiveTabBinary(binary);
      })
      .catch(() => {
        if (!cancelled) setActiveTabBinary(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, workMode]);

  /** 仅编辑器模式下、当前激活 tab 是文本且非二进制时才显示 Monaco 浮层 */
  const showSharedMonaco = Boolean(
    workMode === 'editor' &&
    activeTab &&
    isMonacoEditableFile(activeTab.filePath) &&
    !activeTabBinary &&
    !previewForActiveTab,
  );
  const showFileDiffPreview = Boolean(
    workMode === 'editor' && previewForActiveTab && filePreview,
  );
  const showOverlay = showSharedMonaco || showFileDiffPreview;

  const handleDirtyChange = useCallback(
    (tabId: string, dirty: boolean) => {
      markTabDirty(tabId, dirty);
    },
    [markTabDirty],
  );

  const handleSave = useCallback(async () => {
    if (previewForActiveTab) return;
    const saved = await saveActiveTab();
    if (saved) {
      await refreshTree();
    }
  }, [previewForActiveTab, saveActiveTab, refreshTree]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      handleSave().catch(() => undefined);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave]);

  return (
    <div className="editor-workspace">
      <div className="editor-workspace-body">
        {hasTabs ? (
          <div className="editor-workspace-pane">
            {openTabs.map((tab) => (
              <div
                key={tab.id}
                className={`editor-workspace-tab-pane${
                  tab.id === activeTabId
                    ? ' editor-workspace-tab-pane--active'
                    : ''
                }`}
              >
                <EditorPane
                  filePath={tab.filePath}
                  isActive={tab.id === activeTabId}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="editor-workspace-empty">
            <VscodeIcon name="files" size={48} />
            <VscodeLabel>在左侧选择文件以打开</VscodeLabel>
          </div>
        )}
        {/* Monaco 单例始终存在于 DOM 中，避免首次打开文件时重新初始化 */}
        <div
          className={`shared-monaco-layer${showOverlay ? '' : ' shared-monaco-layer--hidden'}`}
          aria-hidden={!showOverlay}
        >
          {/* 编辑器实例保持挂载，预览只是在其上层叠 diff 视图，切换不重建 */}
          <div
            className={`shared-monaco-host${
              showSharedMonaco ? '' : ' shared-monaco-host--hidden'
            }`}
          >
            <MonacoTextEditor
              filePath={showSharedMonaco ? (activeTab?.filePath ?? '') : ''}
              tabId={activeTab?.id ?? ''}
              dirty={activeTab?.dirty ?? false}
              readOnly={false}
              visible={showSharedMonaco}
              onDirtyChange={handleDirtyChange}
            />
          </div>
          {showFileDiffPreview && filePreview ? (
            <>
              <div
                className={`agent-preview-banner${
                  filePreview.operation === 'delete'
                    ? ' agent-preview-banner--delete'
                    : ''
                }`}
                role="status"
              >
                {filePreview.operation === 'delete'
                  ? '删除预览（未应用）— 红色为将删除的内容'
                  : '提案预览（未应用）— 绿色为新增，红色为删除'}
                <button
                  type="button"
                  className="editor-workspace__diff-toggle"
                  onClick={() => setPreviewCollapsed((full) => !full)}
                >
                  {previewCollapsed ? '展开全部变更' : '收起为变更区域'}
                </button>
              </div>
              <MonacoDiffView
                fill
                relativePath={filePreview.relativePath}
                oldContent={filePreview.oldContent}
                newContent={filePreview.newContent}
                collapseUnchanged={previewCollapsed}
                revealFirstChange
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
