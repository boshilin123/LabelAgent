import {
  VscodeLabel,
  VscodeToolbarContainer,
  VscodeTree,
  VscodeTreeItem,
} from '@vscode-elements/react-elements';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { m, AnimatePresence } from 'framer-motion';
import VscodeClickableToolbarButton from './VscodeClickableButton';
import { useApp } from '../context/AppContext';
import { useAnnotation } from '../context/AnnotationContext';
import { basename, relativePath } from '../types/file';
import {
  clearAncestorIndentGuides,
  clearTreeSelections,
  getPathFromTreeItem,
  getTreeFromItem,
  handleTreeSelect,
  isTreeItemBranch,
  type VscTreeSelectEvent,
  syncActiveFileSelection,
  syncTreeOpenState,
} from '../utils/tree-select';
import FileTreeVscItem from './FileTree/FileTreeVscItem';
import VscodeScrollHost from './VscodeScrollHost';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import './FileTree.css';

// ── 内联 Prompt 弹窗组件 ──

function PromptDialog({
  title,
  defaultValue,
  onConfirm,
  onCancel,
}: {
  title: string;
  defaultValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onConfirm(value);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <AnimatePresence>
      <m.div
        className="lr-prompt-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
      >
        <m.div
          className="lr-prompt-dialog"
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.92 }}
          transition={{ duration: 0.12 }}
        >
          <div className="lr-prompt-title">{title}</div>
          <input
            ref={inputRef}
            className="lr-prompt-input"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="lr-prompt-buttons">
            <button
              type="button"
              className="lr-prompt-btn lr-prompt-btn--primary"
              onClick={() => onConfirm(value)}
            >
              确定
            </button>
            <button type="button" className="lr-prompt-btn" onClick={onCancel}>
              取消
            </button>
          </div>
        </m.div>
      </m.div>
    </AnimatePresence>
  );
}

// ── 辅助函数 ──

function findContextTarget(
  el: HTMLElement,
): { filePath: string; isFolder: boolean } | null {
  let current: HTMLElement | null = el;
  while (current) {
    if (current.tagName === 'VSCODE-TREE-ITEM') {
      const label = current.querySelector<HTMLElement>('.file-tree-item-label');
      const path =
        label?.dataset?.filePath ??
        current.querySelector<HTMLElement>('[data-file-path]')?.dataset
          ?.filePath;
      if (path) {
        return { filePath: path, isFolder: current.hasAttribute('branch') };
      }
    }
    const dataPath = (current as HTMLElement)?.dataset?.filePath;
    if (dataPath && current.tagName === 'SPAN') {
      const parent = current.closest('vscode-tree-item');
      return {
        filePath: dataPath,
        isFolder: parent ? parent.hasAttribute('branch') : false,
      };
    }
    current = current.parentElement;
  }
  return null;
}

function isInsideFileTree(el: HTMLElement): boolean {
  let current: HTMLElement | null = el;
  while (current) {
    if (current.classList.contains('file-tree-scroll-host')) return true;
    current = current.parentElement;
  }
  return false;
}

// ── FileTree 主组件 ──

type PromptAction =
  | { type: 'new-file'; parentDir: string }
  | { type: 'new-folder'; parentDir: string }
  | { type: 'rename'; oldPath: string; oldName: string };

export default function FileTree() {
  const {
    rootPath,
    tree,
    expandedPaths,
    activeFilePath,
    openFolder,
    toggleFolder,
    selectFile,
    openFileInEditor,
    refreshTree,
    fileClipboard,
    setFileClipboard,
  } = useApp();
  const { clearActiveProject } = useAnnotation();

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetPath: string;
    isFolder: boolean;
    isRoot: boolean;
  } | null>(null);

  const [promptAction, setPromptAction] = useState<PromptAction | null>(null);

  const handleOpenFolder = useCallback(() => {
    clearActiveProject();
    openFolder();
  }, [clearActiveProject, openFolder]);

  const scrollableRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const treeEl = scrollableRef.current?.querySelector('vscode-tree');
    if (!treeEl) return undefined;

    const sync = () => {
      syncTreeOpenState(treeEl, expandedPaths, rootPath ?? '');
      syncActiveFileSelection(treeEl, activeFilePath);
    };

    sync();
    const frameId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frameId);
  }, [activeFilePath, expandedPaths, tree, rootPath]);

  const rootOpen = expandedPaths.has(rootPath ?? '');
  const onTreeSelect = useCallback(
    (event: VscTreeSelectEvent) => {
      const item = Array.isArray(event.detail)
        ? event.detail[0]
        : event.detail?.selectedItems?.[0];
      const itemTree = item ? getTreeFromItem(item) : null;

      if (item && isTreeItemBranch(item) && itemTree) {
        clearTreeSelections(itemTree);
      }

      const folderPath =
        item && isTreeItemBranch(item) ? getPathFromTreeItem(item) : null;
      const willExpand =
        folderPath !== null ? !expandedPaths.has(folderPath) : false;

      handleTreeSelect(event, toggleFolder, selectFile);

      if (item && isTreeItemBranch(item) && folderPath) {
        (item as HTMLElement & { open?: boolean }).open = willExpand;
        queueMicrotask(() => clearAncestorIndentGuides(item));
      }
    },
    [toggleFolder, selectFile, expandedPaths],
  );

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      const found = findContextTarget(target);
      if (!found || found.isFolder) return;

      event.preventDefault();
      openFileInEditor(found.filePath);
    },
    [openFileInEditor],
  );

  // ── 右键菜单 ──

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!isInsideFileTree(target)) return;

      const found = findContextTarget(target);
      if (!found) {
        if (rootPath) {
          e.preventDefault();
          setContextMenu({
            x: e.clientX,
            y: e.clientY,
            targetPath: rootPath,
            isFolder: true,
            isRoot: true,
          });
        }
        return;
      }

      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        targetPath: found.filePath,
        isFolder: found.isFolder,
        isRoot: found.filePath === rootPath,
      });
    },
    [rootPath],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // ── Prompt 回调 ──

  const handlePromptConfirm = useCallback(
    async (value: string) => {
      const action = promptAction;
      setPromptAction(null);
      if (!action || !value.trim()) return;

      const name = value.trim();

      switch (action.type) {
        case 'new-file':
          await window.electron.workspace.createFile(action.parentDir, name);
          refreshTree();
          break;
        case 'new-folder':
          await window.electron.workspace.createFolder(action.parentDir, name);
          refreshTree();
          break;
        case 'rename': {
          if (name === action.oldName) break;
          const result = await window.electron.workspace.renameEntry(
            action.oldPath,
            name,
          );
          if (result.success) refreshTree();
          break;
        }
        default:
          break;
      }
    },
    [promptAction, refreshTree],
  );

  const handlePromptCancel = useCallback(() => {
    setPromptAction(null);
  }, []);

  // ── 构建菜单项 ──

  const contextMenuItems: ContextMenuItem[] = (() => {
    if (!contextMenu || !rootPath) return [];
    const { targetPath, isFolder, isRoot } = contextMenu;
    const canPaste =
      isFolder && fileClipboard !== null && fileClipboard.paths.length > 0;

    const items: ContextMenuItem[] = [];

    // New File / New Folder
    if (isFolder) {
      items.push({
        id: 'new-file',
        label: '新建文件',
        onClick: () => {
          setPromptAction({
            type: 'new-file',
            parentDir: targetPath,
          });
        },
      });
      items.push({
        id: 'new-folder',
        label: '新建文件夹',
        separatorAfter: true,
        onClick: () => {
          setPromptAction({
            type: 'new-folder',
            parentDir: targetPath,
          });
        },
      });
    }

    // Cut / Copy / Paste
    const isEditable = !isRoot || isFolder;
    items.push({
      id: 'cut',
      label: '剪切',
      shortcut: 'Ctrl+X',
      disabled: !isEditable,
      onClick: () => {
        setFileClipboard({ action: 'cut', paths: [targetPath] });
      },
    });
    items.push({
      id: 'copy',
      label: '复制',
      shortcut: 'Ctrl+C',
      onClick: () => {
        setFileClipboard({ action: 'copy', paths: [targetPath] });
      },
    });
    items.push({
      id: 'paste',
      label: '粘贴',
      shortcut: 'Ctrl+V',
      disabled: !canPaste,
      separatorAfter: true,
      onClick: async () => {
        if (!fileClipboard) return;
        for (const srcPath of fileClipboard.paths) {
          try {
            if (fileClipboard.action === 'cut') {
              await window.electron.workspace.moveEntry(srcPath, targetPath);
            }
          } catch {
            // ignore
          }
        }
        if (fileClipboard.action === 'cut') {
          setFileClipboard(null);
          refreshTree();
        }
      },
    });

    // Copy Path / Copy Relative Path
    items.push({
      id: 'copy-path',
      label: '复制路径',
      onClick: async () => {
        await navigator.clipboard.writeText(targetPath);
      },
    });
    items.push({
      id: 'copy-relative-path',
      label: '复制相对路径',
      separatorAfter: true,
      onClick: async () => {
        let rel = relativePath(rootPath, targetPath);
        if (!rel) rel = basename(targetPath);
        await navigator.clipboard.writeText(rel);
      },
    });

    // Rename
    items.push({
      id: 'rename',
      label: '重命名',
      disabled: isRoot,
      onClick: () => {
        const oldName = basename(targetPath);
        setPromptAction({
          type: 'rename',
          oldPath: targetPath,
          oldName,
        });
      },
    });

    // Delete
    items.push({
      id: 'delete',
      label: '删除',
      disabled: isRoot,
      onClick: async () => {
        const entryName = basename(targetPath);
        const result = await window.electron.dialog.confirm(
          `确定要删除「${entryName}」吗？`,
        );
        if (!result.confirmed) return;
        await window.electron.workspace.deleteEntry(targetPath);
        refreshTree();
      },
    });

    return items;
  })();

  const promptTitle =
    promptAction?.type === 'rename'
      ? '请输入新名称：'
      : promptAction?.type === 'new-folder'
        ? '请输入文件夹名：'
        : '请输入文件名：';

  return (
    <div
      className="file-tree"
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
    >
      <VscodeToolbarContainer className="file-tree-toolbar">
        <VscodeClickableToolbarButton
          icon="folder-opened"
          label="打开文件夹"
          onClick={handleOpenFolder}
        />
        <VscodeClickableToolbarButton
          icon="refresh"
          label="刷新"
          onClick={() => refreshTree()}
        />
      </VscodeToolbarContainer>

      <VscodeScrollHost
        className="file-tree-scroll-host"
        scrollableClassName="file-tree-scrollable"
        scrollRef={scrollableRef}
      >
        {rootPath ? (
          <VscodeTree
            expandMode="doubleClick"
            indentGuides="onHover"
            indent={8}
            onVscTreeSelect={onTreeSelect}
          >
            <VscodeTreeItem
              branch
              open={expandedPaths.has(rootPath)}
              selected={activeFilePath === rootPath}
            >
              <span className="file-tree-item-label" data-file-path={rootPath}>
                {basename(rootPath)}
              </span>
              {tree.map((node) => (
                <FileTreeVscItem
                  key={node.path}
                  node={node}
                  expandedPaths={expandedPaths}
                  activeFilePath={activeFilePath}
                  parentOpen={rootOpen}
                />
              ))}
            </VscodeTreeItem>
          </VscodeTree>
        ) : (
          <div className="file-tree-empty">
            <VscodeLabel>点击「打开文件夹」选择工作区</VscodeLabel>
          </div>
        )}
      </VscodeScrollHost>

      {contextMenu && contextMenuItems.length > 0 && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}

      {promptAction && (
        <PromptDialog
          title={promptTitle}
          defaultValue={
            promptAction.type === 'rename' ? promptAction.oldName : undefined
          }
          onConfirm={handlePromptConfirm}
          onCancel={handlePromptCancel}
        />
      )}
    </div>
  );
}
