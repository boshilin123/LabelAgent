import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import './LayoutControls.css';

export function LeftSidebarToggle() {
  const {
    layout: { leftCollapsed },
    toggleLeftSidebar,
  } = useApp();

  return (
    <button
      type="button"
      className="layout-control-btn"
      aria-label={leftCollapsed ? '显示主侧栏' : '隐藏主侧栏'}
      aria-pressed={!leftCollapsed}
      onClick={toggleLeftSidebar}
    >
      <span
        className={`codicon ${
          leftCollapsed
            ? 'codicon-layout-sidebar-left-off'
            : 'codicon-layout-sidebar-left'
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

export function FullScreenToggle() {
  const [isFullScreen, setIsFullScreen] = useState(false);

  useEffect(() => {
    if (!window.electron) return undefined;
    window.electron.window.isFullScreen().then(setIsFullScreen);
    return window.electron.window.onFullScreenChange(setIsFullScreen);
  }, []);

  const label = isFullScreen ? '退出全屏' : '切换全屏';

  return (
    <button
      type="button"
      className="layout-control-btn"
      aria-label={label}
      title={`${label} (F11)`}
      aria-pressed={isFullScreen}
      onClick={() => window.electron.window.toggleFullScreen()}
    >
      <span
        className={`codicon ${
          isFullScreen ? 'codicon-screen-normal' : 'codicon-screen-full'
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

export function RightSidebarToggle() {
  const {
    layout: { rightCollapsed },
    toggleRightSidebar,
  } = useApp();

  return (
    <button
      type="button"
      className="layout-control-btn"
      aria-label={rightCollapsed ? '显示 Agent 侧栏' : '隐藏 Agent 侧栏'}
      aria-pressed={!rightCollapsed}
      onClick={toggleRightSidebar}
    >
      <span
        className={`codicon ${
          rightCollapsed
            ? 'codicon-layout-sidebar-right-off'
            : 'codicon-layout-sidebar-right'
        }`}
        aria-hidden="true"
      />
    </button>
  );
}
