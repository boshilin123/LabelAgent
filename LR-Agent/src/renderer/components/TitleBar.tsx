import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useAnnotation } from '../context/AnnotationContext';
import appIconDark from '../../../assets/icon-dark.png';
import appIconLight from '../../../assets/icon-light.png';
import {
  FullScreenToggle,
  LeftSidebarToggle,
  RightSidebarToggle,
} from './LayoutControls';
import { useTheme } from '../context/ThemeContext';
import PopoverMotion from '../motion/PopoverMotion';
import './TitleBar.css';

const IS_DEV =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

type MenuId = 'file' | 'view' | 'help';

interface MenuItemConfig {
  label: string;
  accelerator?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

function acceleratorLabel(acc: string): string {
  const isMac = window.electron?.platform === 'darwin';
  return acc
    .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/Command/g, '⌘')
    .replace(/Ctrl/g, 'Ctrl')
    .replace(/Shift/g, 'Shift')
    .replace(/Alt/g, isMac ? '⌥' : 'Alt')
    .replace(/\+/g, '+');
}

function MenuDropdown({
  open,
  items,
  onClose,
}: {
  open: boolean;
  items: MenuItemConfig[];
  onClose: () => void;
}) {
  return (
    <PopoverMotion
      open={open}
      className="title-bar-menu-dropdown"
      origin="top"
      role="menu"
    >
      {items.map((item, index) => {
        if (item.separator) {
          return (
            <div
              key={`sep-${index}`}
              className="title-bar-menu-separator"
              role="separator"
            />
          );
        }
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="title-bar-menu-item"
            disabled={item.disabled}
            onClick={() => {
              item.action?.();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.accelerator && (
              <span className="title-bar-menu-accelerator">
                {acceleratorLabel(item.accelerator)}
              </span>
            )}
          </button>
        );
      })}
    </PopoverMotion>
  );
}

export default function TitleBar() {
  const { openFolder, toggleLeftSidebar, toggleRightSidebar } = useApp();
  const { openCreateWizard, clearActiveProject, activeProject } =
    useAnnotation();
  const { effectiveTheme } = useTheme();
  const appIcon = effectiveTheme === 'dark' ? appIconDark : appIconLight;
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const barRef = useRef<HTMLElement>(null);
  const platform = window.electron?.platform ?? 'win32';
  const windowApi = window.electron?.window;
  const showWindowControls = Boolean(windowApi) && platform !== 'darwin';
  const showRestore = isFullScreen || isMaximized;

  useEffect(() => {
    if (!window.electron) return undefined;
    window.electron.window.isMaximized().then(setIsMaximized);
    window.electron.window.isFullScreen().then(setIsFullScreen);
    const unsubMaximize =
      window.electron.window.onMaximizeChange(setIsMaximized);
    const unsubFullScreen =
      window.electron.window.onFullScreenChange(setIsFullScreen);
    return () => {
      unsubMaximize();
      unsubFullScreen();
    };
  }, []);

  useEffect(() => {
    if (!openMenu) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      if (barRef.current?.contains(event.target as Node)) return;
      setOpenMenu(null);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [openMenu]);

  const runMenuAction = useCallback((action: () => void) => {
    action();
    setOpenMenu(null);
  }, []);

  const handleOpenFolder = useCallback(() => {
    clearActiveProject();
    openFolder();
  }, [clearActiveProject, openFolder]);

  const fileItems: MenuItemConfig[] = [
    {
      label: '打开文件夹…',
      accelerator: 'CommandOrControl+O',
      action: () => runMenuAction(handleOpenFolder),
    },
    {
      label: '新建标注任务…',
      action: () => runMenuAction(openCreateWizard),
    },
    { separator: true, label: '' },
    {
      label: '关闭窗口',
      accelerator: 'CommandOrControl+W',
      action: () => window.electron.window.close(),
    },
  ];

  const viewItems: MenuItemConfig[] = [
    {
      label: '切换主侧栏',
      accelerator: 'CommandOrControl+B',
      action: () => runMenuAction(toggleLeftSidebar),
    },
    {
      label: '切换 Agent 侧栏',
      accelerator: 'CommandOrControl+Shift+B',
      action: () => runMenuAction(toggleRightSidebar),
    },
    { separator: true, label: '' },
    ...(IS_DEV
      ? [
          {
            label: '重新加载',
            accelerator: 'CommandOrControl+R',
            action: () => window.electron.window.reload(),
          } as MenuItemConfig,
          {
            label: '切换全屏',
            accelerator: 'F11',
            action: () => window.electron.window.toggleFullScreen(),
          } as MenuItemConfig,
          {
            label: '切换开发者工具',
            accelerator: 'Alt+CommandOrControl+I',
            action: () => window.electron.window.toggleDevTools(),
          } as MenuItemConfig,
        ]
      : [
          {
            label: '切换全屏',
            accelerator: 'F11',
            action: () => window.electron.window.toggleFullScreen(),
          } as MenuItemConfig,
        ]),
  ];

  const helpItems: MenuItemConfig[] = [
    {
      label: '了解更多',
      action: () =>
        window.electron.window.openExternal(
          'https://github.com/MarisaMagic/LR-Agent',
        ),
    },
    {
      label: '文档',
      action: () =>
        window.electron.window.openExternal(
          'https://github.com/MarisaMagic/LR-Agent#readme',
        ),
    },
    {
      label: '搜索问题',
      action: () =>
        window.electron.window.openExternal(
          'https://github.com/MarisaMagic/LR-Agent/issues',
        ),
    },
  ];

  useEffect(() => {
    if (!window.electron) return undefined;
    const mod = window.electron.platform === 'darwin' ? 'metaKey' : 'ctrlKey';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F11') {
        event.preventDefault();
        window.electron.window.toggleFullScreen();
        return;
      }

      const modPressed = mod === 'metaKey' ? event.metaKey : event.ctrlKey;
      if (!modPressed) return;

      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        handleOpenFolder();
      } else if (key === 'b' && event.shiftKey) {
        event.preventDefault();
        toggleRightSidebar();
      } else if (key === 'b') {
        event.preventDefault();
        toggleLeftSidebar();
      } else if (key === 'w') {
        event.preventDefault();
        window.electron.window.close();
      } else if (IS_DEV && key === 'r') {
        event.preventDefault();
        window.electron.window.reload();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleOpenFolder, toggleLeftSidebar, toggleRightSidebar]);

  const toggleMenu = (menu: MenuId) => {
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  const handleDragRegionDoubleClick = () => {
    windowApi?.maximize();
  };

  return (
    <header ref={barRef} className={`title-bar title-bar-${platform}`}>
      <div className="title-bar-left">
        <img src={appIcon} alt="" className="title-bar-app-icon" />
        <nav className="title-bar-menus" aria-label="应用菜单">
          {(
            [
              ['file', 'File', fileItems],
              ['view', 'View', viewItems],
              ['help', 'Help', helpItems],
            ] as const
          ).map(([id, label, items]) => (
            <div key={id} className="title-bar-menu-wrap">
              <button
                type="button"
                className={`title-bar-menu-trigger${
                  openMenu === id ? ' title-bar-menu-trigger-active' : ''
                }`}
                aria-haspopup="menu"
                aria-expanded={openMenu === id}
                onClick={() => toggleMenu(id)}
              >
                {label}
              </button>
              <MenuDropdown
                open={openMenu === id}
                items={items}
                onClose={() => setOpenMenu(null)}
              />
            </div>
          ))}
        </nav>
        <div className="layout-controls layout-controls-left">
          <LeftSidebarToggle />
        </div>
      </div>

      <div
        className="title-bar-drag-region"
        onDoubleClick={handleDragRegionDoubleClick}
      >
        <span className="title-bar-title">
          {activeProject?.name ?? 'LR-Agent'}
        </span>
      </div>

      <div className="title-bar-right">
        <div className="layout-controls layout-controls-right">
          <FullScreenToggle />
          <RightSidebarToggle />
        </div>
        {showWindowControls && (
          <div className="title-bar-controls">
            <button
              type="button"
              className="title-bar-control title-bar-control-minimize"
              aria-label="最小化"
              onClick={() => windowApi?.minimize()}
            >
              <span
                className="codicon codicon-chrome-minimize"
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              className="title-bar-control title-bar-control-maximize"
              aria-label={showRestore ? '还原' : '最大化'}
              onClick={() => windowApi?.maximize()}
            >
              <span
                className={`codicon ${
                  showRestore
                    ? 'codicon-chrome-restore'
                    : 'codicon-chrome-maximize'
                }`}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              className="title-bar-control title-bar-control-close"
              aria-label="关闭"
              onClick={() => windowApi?.close()}
            >
              <span
                className="codicon codicon-chrome-close"
                aria-hidden="true"
              />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
