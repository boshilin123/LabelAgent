import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DirectoryItem } from '../../main/preload';
import { FileNode } from '../types/file';
import { getRelativeProjectPath } from '../utils/projectPaths';
import { isMonacoEditableFile } from '../utils/editorFileTypes';
import {
  getDocumentModel,
  markDocumentSaved,
  syncDocumentRefCounts,
} from '../components/editor/editorDocumentStore';
import {
  clearFilePreviewIfPathChanged,
  pathsEqual,
} from '../services/agentFilePreviewStore';
import { getWorkModeExternal } from './workModeBridge';

const STORAGE_KEYS = {
  leftWidth: 'lr-agent:leftWidth',
  rightWidth: 'lr-agent:rightWidth',
  leftCollapsed: 'lr-agent:leftCollapsed',
  rightCollapsed: 'lr-agent:rightCollapsed',
  lastWorkspace: 'lr-agent:lastWorkspace',
};

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 500;
const MIN_MAIN_CONTENT_WIDTH = 480;
const DEFAULT_LEFT_WIDTH = 250;
const DEFAULT_RIGHT_WIDTH = 350;
const ACTIVITY_BAR_WIDTH = 48;

function readNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === 'true';
}

function itemsToNodes(items: DirectoryItem[]): FileNode[] {
  const nodes: FileNode[] = items.map((item) => ({
    name: item.name,
    path: item.path,
    type: item.isDirectory ? 'folder' : 'file',
  }));
  return nodes.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'folder' ? -1 : 1;
  });
}

function patchNodeChildren(
  nodes: FileNode[],
  targetPath: string,
  children: FileNode[],
): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children, isLoading: false };
    }
    if (node.children) {
      return {
        ...node,
        children: patchNodeChildren(node.children, targetPath, children),
      };
    }
    return node;
  });
}

function setNodeLoading(
  nodes: FileNode[],
  targetPath: string,
  isLoading: boolean,
): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, isLoading };
    }
    if (node.children) {
      return {
        ...node,
        children: setNodeLoading(node.children, targetPath, isLoading),
      };
    }
    return node;
  });
}

function collectFolderPaths(nodes: FileNode[]): Set<string> {
  const paths = new Set<string>();
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === 'folder') {
        paths.add(node.path);
        if (node.children) walk(node.children);
      }
    }
  };
  walk(nodes);
  return paths;
}

function pruneExpandedPaths(
  expandedPaths: Set<string>,
  tree: FileNode[],
  rootPath: string,
): Set<string> {
  const validFolders = collectFolderPaths(tree);
  validFolders.add(rootPath);
  const next = new Set<string>();
  for (const path of expandedPaths) {
    if (validFolders.has(path)) next.add(path);
  }
  return next;
}

function nodeMetaEqual(a: FileNode, b: FileNode): boolean {
  return a.path === b.path && a.name === b.name && a.type === b.type;
}

function childrenSameReferences(
  next: FileNode[] | undefined,
  prev: FileNode[] | undefined,
): boolean {
  if (!next && !prev) return true;
  if (!next || !prev || next.length !== prev.length) return false;
  return next.every((node, index) => node === prev[index]);
}

async function refreshNodesAtLevel(
  oldNodes: FileNode[] | undefined,
  freshNodes: FileNode[],
  expandedPaths: Set<string>,
  loadDirectory: (dirPath: string) => Promise<FileNode[]>,
): Promise<FileNode[]> {
  return Promise.all(
    freshNodes.map(async (fresh) => {
      const oldNode = oldNodes?.find((node) => node.path === fresh.path);

      if (fresh.type !== 'folder' || !expandedPaths.has(fresh.path)) {
        // Drop cached children for collapsed folders so the next expand re-reads disk.
        if (fresh.type === 'folder') {
          return { ...fresh, isLoading: false };
        }
        if (oldNode && nodeMetaEqual(oldNode, fresh)) {
          return oldNode;
        }
        return fresh;
      }

      const childFresh = await loadDirectory(fresh.path);
      const children = await refreshNodesAtLevel(
        oldNode?.children,
        childFresh,
        expandedPaths,
        loadDirectory,
      );

      if (
        oldNode &&
        nodeMetaEqual(oldNode, fresh) &&
        childrenSameReferences(children, oldNode.children)
      ) {
        return oldNode;
      }

      const base = oldNode && nodeMetaEqual(oldNode, fresh) ? oldNode : fresh;
      return { ...base, children, isLoading: false };
    }),
  );
}

interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftLastWidth: number;
  rightLastWidth: number;
}

type LayoutAction =
  | { type: 'SET_LEFT_WIDTH'; width: number }
  | { type: 'SET_RIGHT_WIDTH'; width: number }
  | { type: 'TOGGLE_LEFT' }
  | { type: 'TOGGLE_RIGHT' };

function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case 'SET_LEFT_WIDTH':
      return { ...state, leftWidth: action.width, leftLastWidth: action.width };
    case 'SET_RIGHT_WIDTH':
      return {
        ...state,
        rightWidth: action.width,
        rightLastWidth: action.width,
      };
    case 'TOGGLE_LEFT':
      if (!state.leftCollapsed) {
        return {
          ...state,
          leftCollapsed: true,
          leftLastWidth: state.leftWidth,
        };
      }
      return {
        ...state,
        leftCollapsed: false,
        leftWidth: state.leftLastWidth || DEFAULT_LEFT_WIDTH,
      };
    case 'TOGGLE_RIGHT':
      if (!state.rightCollapsed) {
        return {
          ...state,
          rightCollapsed: true,
          rightLastWidth: state.rightWidth,
        };
      }
      return {
        ...state,
        rightCollapsed: false,
        rightWidth: state.rightLastWidth || DEFAULT_RIGHT_WIDTH,
      };
    default:
      return state;
  }
}

interface WorkspaceState {
  rootPath: string | null;
  tree: FileNode[];
  expandedPaths: Set<string>;
  activeFilePath: string | null;
}

export interface EditorTab {
  id: string;
  filePath: string;
  dirty: boolean;
  /** Preview tabs are replaced by the next single-click file selection. */
  preview: boolean;
  /** Save-time snapshot; not fed back into Monaco during editing. */
  content?: string;
}

export interface FileClipboard {
  action: 'cut' | 'copy';
  paths: string[];
}

interface AppContextValue {
  layout: LayoutState;
  activityBarWidth: number;
  minMainContentWidth: number;
  minSidebarWidth: number;
  maxSidebarWidth: number;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  expandLeftSidebar: () => void;
  expandRightSidebar: () => void;
  rootPath: string | null;
  tree: FileNode[];
  expandedPaths: Set<string>;
  activeFilePath: string | null;
  openTabs: EditorTab[];
  activeTabId: string | null;
  openFolder: (dirPath?: string) => Promise<void>;
  toggleFolder: (folderPath: string) => Promise<void>;
  selectFile: (filePath: string) => void;
  previewFileInEditor: (filePath: string) => void;
  openFileInEditor: (filePath: string) => void;
  setActiveTab: (tabId: string) => void;
  pinTab: (tabId: string) => void;
  closeTab: (tabId: string) => boolean;
  markTabDirty: (tabId: string, dirty: boolean, content?: string) => void;
  saveActiveTab: () => Promise<boolean>;
  refreshTree: () => Promise<void>;
  fileClipboard: FileClipboard | null;
  setFileClipboard: (clipboard: FileClipboard | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [layout, dispatchLayout] = useReducer(layoutReducer, {
    leftWidth: readNumber(STORAGE_KEYS.leftWidth, DEFAULT_LEFT_WIDTH),
    rightWidth: readNumber(STORAGE_KEYS.rightWidth, DEFAULT_RIGHT_WIDTH),
    leftCollapsed: readBool(STORAGE_KEYS.leftCollapsed, false),
    rightCollapsed: readBool(STORAGE_KEYS.rightCollapsed, false),
    leftLastWidth: readNumber(STORAGE_KEYS.leftWidth, DEFAULT_LEFT_WIDTH),
    rightLastWidth: readNumber(STORAGE_KEYS.rightWidth, DEFAULT_RIGHT_WIDTH),
  });

  type WorkspaceAction =
    | { type: 'SET'; payload: Partial<WorkspaceState> }
    | {
        type: 'PATCH_CHILDREN';
        folderPath: string;
        children: FileNode[];
        expandedPaths: Set<string>;
      }
    | { type: 'SET_LOADING'; folderPath: string; isLoading: boolean };

  const [workspace, dispatchWorkspace] = useReducer(
    (state: WorkspaceState, action: WorkspaceAction): WorkspaceState => {
      switch (action.type) {
        case 'SET':
          return { ...state, ...action.payload };
        case 'SET_LOADING':
          return {
            ...state,
            tree: setNodeLoading(
              state.tree,
              action.folderPath,
              action.isLoading,
            ),
          };
        case 'PATCH_CHILDREN':
          return {
            ...state,
            expandedPaths: action.expandedPaths,
            tree: patchNodeChildren(
              state.tree,
              action.folderPath,
              action.children,
            ),
          };
        default:
          return state;
      }
    },
    {
      rootPath: null,
      tree: [],
      expandedPaths: new Set<string>(),
      activeFilePath: null,
    },
  );

  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const editorTabsRef = useRef(editorTabs);
  const activeTabIdRef = useRef(activeTabId);
  const prevEditorTabsRef = useRef<EditorTab[]>([]);
  editorTabsRef.current = editorTabs;
  activeTabIdRef.current = activeTabId;

  useEffect(() => {
    syncDocumentRefCounts(prevEditorTabsRef.current, editorTabs);
    prevEditorTabsRef.current = editorTabs;
  }, [editorTabs]);

  const syncActiveFilePath = useCallback(
    (tabs: EditorTab[], tabId: string | null) => {
      const tab = tabs.find((item) => item.id === tabId);
      setWorkspace({ activeFilePath: tab?.filePath ?? null });
    },
    [],
  );

  const setWorkspace = (partial: Partial<WorkspaceState>) => {
    dispatchWorkspace({ type: 'SET', payload: partial });
  };

  const loadDirectory = useCallback(async (dirPath: string) => {
    const items = await window.electron.fileSystem?.readDirectory(dirPath);
    if (!items) return [];
    return itemsToNodes(items);
  }, []);

  const loadWorkspace = useCallback(
    async (dirPath: string) => {
      const tree = await loadDirectory(dirPath);
      const expanded = new Set<string>([dirPath]);
      setWorkspace({
        rootPath: dirPath,
        tree,
        expandedPaths: expanded,
        activeFilePath: null,
      });
      setEditorTabs([]);
      setActiveTabId(null);
      localStorage.setItem(STORAGE_KEYS.lastWorkspace, dirPath);
      window.electron.workspace.startWatch(dirPath).catch(() => undefined);
    },
    [loadDirectory],
  );

  const openFolder = useCallback(
    async (dirPath?: string) => {
      let path = dirPath;
      if (!path) {
        path = (await window.electron.fileSystem?.openDirectory()) ?? undefined;
      }
      if (!path) return;
      await loadWorkspace(path);
    },
    [loadWorkspace],
  );

  const toggleFolder = useCallback(
    async (folderPath: string) => {
      const expanded = new Set(workspace.expandedPaths);
      if (expanded.has(folderPath)) {
        expanded.delete(folderPath);
        setWorkspace({ expandedPaths: expanded });
        return;
      }

      expanded.add(folderPath);

      const findInTree = (nodes: FileNode[]): FileNode | undefined =>
        nodes.reduce<FileNode | undefined>((found, node) => {
          if (found) return found;
          if (node.path === folderPath) return node;
          if (node.children) return findInTree(node.children);
          return undefined;
        }, undefined);

      const node = findInTree(workspace.tree);
      const isRoot = folderPath === workspace.rootPath;

      if (!isRoot && node?.type === 'folder') {
        if (node.children !== undefined) {
          setWorkspace({ expandedPaths: expanded });
          return;
        }

        dispatchWorkspace({
          type: 'SET',
          payload: { expandedPaths: expanded },
        });
        dispatchWorkspace({
          type: 'SET_LOADING',
          folderPath,
          isLoading: true,
        });
        const childNodes = await loadDirectory(folderPath);
        dispatchWorkspace({
          type: 'PATCH_CHILDREN',
          folderPath,
          children: childNodes,
          expandedPaths: expanded,
        });
        return;
      }

      setWorkspace({ expandedPaths: expanded });
    },
    [
      workspace.expandedPaths,
      workspace.tree,
      workspace.rootPath,
      loadDirectory,
    ],
  );

  const openFileInEditor = useCallback(
    (filePath: string) => {
      clearFilePreviewIfPathChanged(filePath);
      setEditorTabs((prev) => {
        // 按归一化路径匹配：文件树打开的是反斜杠路径，提案点击解析出的
        // 是正斜杠路径，精确比较会开出完全同名的重复 tab。
        const existing = prev.find((tab) => pathsEqual(tab.filePath, filePath));
        if (existing) {
          setActiveTabId(existing.id);
          const next = prev.map((tab) =>
            tab.id === existing.id ? { ...tab, preview: false } : tab,
          );
          syncActiveFilePath(next, existing.id);
          return next;
        }

        if (getWorkModeExternal() === 'annotation') {
          const id = crypto.randomUUID();
          const next = [{ id, filePath, dirty: false, preview: false }];
          setActiveTabId(id);
          syncActiveFilePath(next, id);
          return next;
        }

        const id = crypto.randomUUID();
        const next = [...prev, { id, filePath, dirty: false, preview: false }];
        setActiveTabId(id);
        syncActiveFilePath(next, id);
        return next;
      });
    },
    [syncActiveFilePath],
  );

  const previewFileInEditor = useCallback(
    (filePath: string) => {
      clearFilePreviewIfPathChanged(filePath);
      setEditorTabs((prev) => {
        const existing = prev.find((tab) => pathsEqual(tab.filePath, filePath));
        if (existing) {
          setActiveTabId(existing.id);
          syncActiveFilePath(prev, existing.id);
          return prev;
        }

        if (getWorkModeExternal() === 'annotation') {
          const id = crypto.randomUUID();
          const next = [{ id, filePath, dirty: false, preview: false }];
          setActiveTabId(id);
          syncActiveFilePath(next, id);
          return next;
        }

        const previewTab = prev.find((tab) => tab.preview && !tab.dirty);
        if (previewTab) {
          const next = prev.map((tab) =>
            tab.id === previewTab.id
              ? {
                  ...tab,
                  filePath,
                  dirty: false,
                  preview: true,
                  content: undefined,
                }
              : tab,
          );
          setActiveTabId(previewTab.id);
          syncActiveFilePath(next, previewTab.id);
          return next;
        }

        const id = crypto.randomUUID();
        const next = [...prev, { id, filePath, dirty: false, preview: true }];
        setActiveTabId(id);
        syncActiveFilePath(next, id);
        return next;
      });
    },
    [syncActiveFilePath],
  );

  const selectFile = useCallback(
    (filePath: string) => {
      previewFileInEditor(filePath);
    },
    [previewFileInEditor],
  );

  const setActiveTab = useCallback(
    (tabId: string) => {
      const tab = editorTabsRef.current.find((item) => item.id === tabId);
      if (tab) clearFilePreviewIfPathChanged(tab.filePath);
      setActiveTabId(tabId);
      syncActiveFilePath(editorTabsRef.current, tabId);
    },
    [syncActiveFilePath],
  );

  const pinTab = useCallback((tabId: string) => {
    setEditorTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, preview: false } : tab)),
    );
  }, []);

  const closeTab = useCallback(
    (tabId: string): boolean => {
      const tab = editorTabsRef.current.find((item) => item.id === tabId);
      if (!tab) return true;
      if (
        tab.dirty &&
        !window.confirm(
          `「${tab.filePath.split(/[/\\]/).pop()}」有未保存的更改，确定关闭？`,
        )
      ) {
        return false;
      }
      const nextTabs = editorTabsRef.current.filter(
        (item) => item.id !== tabId,
      );
      let nextActiveId = activeTabIdRef.current;
      if (activeTabIdRef.current === tabId) {
        const closedIndex = editorTabsRef.current.findIndex(
          (item) => item.id === tabId,
        );
        const fallback =
          nextTabs[closedIndex] ?? nextTabs[closedIndex - 1] ?? null;
        nextActiveId = fallback?.id ?? null;
      }
      setEditorTabs(nextTabs);
      setActiveTabId(nextActiveId);
      syncActiveFilePath(nextTabs, nextActiveId);
      return true;
    },
    [syncActiveFilePath],
  );

  const markTabDirty = useCallback(
    (tabId: string, dirty: boolean, content?: string) => {
      setEditorTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                dirty,
                preview: dirty ? false : tab.preview,
                content: content !== undefined ? content : tab.content,
              }
            : tab,
        ),
      );
    },
    [],
  );

  const saveActiveTab = useCallback(async (): Promise<boolean> => {
    const { rootPath } = workspace;
    const tabId = activeTabIdRef.current;
    if (!rootPath || !tabId) return false;
    const tab = editorTabsRef.current.find((item) => item.id === tabId);
    if (!tab || !tab.dirty) return false;
    if (!isMonacoEditableFile(tab.filePath)) return false;

    const relativePath = getRelativeProjectPath(rootPath, tab.filePath);
    if (!relativePath) return false;

    let content = getDocumentModel(tab.filePath)?.getValue();
    if (content === undefined) {
      content = tab.content;
    }
    if (content === undefined) {
      content =
        (await window.electron.fileSystem?.readFile(tab.filePath)) ?? '';
    }

    const result = await window.electron.workspace?.writeTextFile({
      rootDir: rootPath,
      relativePath,
      content,
    });
    if (!result?.success) return false;

    markDocumentSaved(tab.filePath, content);
    markTabDirty(tabId, false, content);
    return true;
  }, [workspace.rootPath, markTabDirty]);

  const [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(
    null,
  );

  const refreshTree = useCallback(async () => {
    const { rootPath, expandedPaths, activeFilePath, tree } = workspace;
    if (!rootPath) return;

    const freshRoot = await loadDirectory(rootPath);
    const newTree = await refreshNodesAtLevel(
      tree,
      freshRoot,
      expandedPaths,
      loadDirectory,
    );
    const nextExpanded = pruneExpandedPaths(expandedPaths, newTree, rootPath);

    let nextActive = activeFilePath;
    if (nextActive) {
      const stats = await window.electron.fileSystem?.getFileStats(nextActive);
      if (!stats) nextActive = null;
    }

    let nextTabs = editorTabsRef.current;
    if (nextActive !== activeFilePath) {
      nextTabs = editorTabsRef.current.filter(
        (tab) => tab.filePath !== activeFilePath,
      );
      const nextActiveId =
        activeTabIdRef.current &&
        nextTabs.some((tab) => tab.id === activeTabIdRef.current)
          ? activeTabIdRef.current
          : (nextTabs[nextTabs.length - 1]?.id ?? null);
      setEditorTabs(nextTabs);
      setActiveTabId(nextActiveId);
    }

    const treeUnchanged = childrenSameReferences(newTree, tree);
    setWorkspace({
      tree: treeUnchanged ? tree : newTree,
      expandedPaths: nextExpanded,
      activeFilePath: nextActive,
    });
  }, [workspace, loadDirectory]);

  // ── 防抖刷新 + 文件变更监听 ──

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTree();
    }, 300);
  }, [refreshTree]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!window.electron) return undefined;
    const unsub = window.electron.fileSystem?.onChanged(() => {
      debouncedRefresh();
    });
    return () => unsub?.();
  }, [debouncedRefresh]);

  const setLeftWidth = useCallback((width: number) => {
    const clamped = Math.max(width, MIN_SIDEBAR_WIDTH);
    dispatchLayout({ type: 'SET_LEFT_WIDTH', width: clamped });
  }, []);

  const setRightWidth = useCallback((width: number) => {
    const clamped = Math.max(width, MIN_SIDEBAR_WIDTH);
    dispatchLayout({ type: 'SET_RIGHT_WIDTH', width: clamped });
  }, []);

  const toggleLeftSidebar = useCallback(() => {
    dispatchLayout({ type: 'TOGGLE_LEFT' });
  }, []);

  const toggleRightSidebar = useCallback(() => {
    dispatchLayout({ type: 'TOGGLE_RIGHT' });
  }, []);

  const expandLeftSidebar = useCallback(() => {
    if (layout.leftCollapsed) {
      dispatchLayout({ type: 'TOGGLE_LEFT' });
    }
  }, [layout.leftCollapsed]);

  const expandRightSidebar = useCallback(() => {
    if (layout.rightCollapsed) {
      dispatchLayout({ type: 'TOGGLE_RIGHT' });
    }
  }, [layout.rightCollapsed]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEYS.leftCollapsed,
      String(layout.leftCollapsed),
    );
    localStorage.setItem(
      STORAGE_KEYS.rightCollapsed,
      String(layout.rightCollapsed),
    );
  }, [layout.leftCollapsed, layout.rightCollapsed]);

  const persistSidebarWidths = useCallback((left: number, right: number) => {
    localStorage.setItem(STORAGE_KEYS.leftWidth, String(left));
    localStorage.setItem(STORAGE_KEYS.rightWidth, String(right));
  }, []);

  useEffect(() => {
    persistSidebarWidths(layout.leftWidth, layout.rightWidth);
  }, [layout.leftWidth, layout.rightWidth, persistSidebarWidths]);

  useEffect(() => {
    if (!window.electron) return;
    const last = localStorage.getItem(STORAGE_KEYS.lastWorkspace);
    if (last) {
      window.electron.fileSystem
        ?.getFileStats(last)
        .then((stats) => {
          if (stats?.isDirectory) {
            return loadWorkspace(last);
          }
          return undefined;
        })
        .catch(() => undefined);
    }
  }, [loadWorkspace]);

  const value = useMemo<AppContextValue>(
    () => ({
      layout,
      activityBarWidth: ACTIVITY_BAR_WIDTH,
      minMainContentWidth: MIN_MAIN_CONTENT_WIDTH,
      minSidebarWidth: MIN_SIDEBAR_WIDTH,
      maxSidebarWidth: MAX_SIDEBAR_WIDTH,
      setLeftWidth,
      setRightWidth,
      toggleLeftSidebar,
      toggleRightSidebar,
      expandLeftSidebar,
      expandRightSidebar,
      rootPath: workspace.rootPath,
      tree: workspace.tree,
      expandedPaths: workspace.expandedPaths,
      activeFilePath: workspace.activeFilePath,
      openTabs: editorTabs,
      activeTabId,
      openFolder,
      toggleFolder,
      selectFile,
      previewFileInEditor,
      openFileInEditor,
      setActiveTab,
      pinTab,
      closeTab,
      markTabDirty,
      saveActiveTab,
      refreshTree,
      fileClipboard,
      setFileClipboard,
    }),
    [
      layout,
      setLeftWidth,
      setRightWidth,
      toggleLeftSidebar,
      toggleRightSidebar,
      expandLeftSidebar,
      expandRightSidebar,
      workspace,
      editorTabs,
      activeTabId,
      openFolder,
      toggleFolder,
      selectFile,
      previewFileInEditor,
      openFileInEditor,
      setActiveTab,
      pinTab,
      closeTab,
      markTabDirty,
      saveActiveTab,
      refreshTree,
      fileClipboard,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used within AppProvider');
  }
  return ctx;
}
