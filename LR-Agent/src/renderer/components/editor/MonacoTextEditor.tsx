import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { useTheme } from '../../context/ThemeContext';
import {
  attachDocumentToEditor,
  getDocumentModel,
  getSavedText,
  hasDocument,
  markDocumentSaved,
  openDocument,
} from './editorDocumentStore';
import {
  scheduleEditorLayout,
  waitForEditorContainer,
} from './monacoEditorHelpers';
import {
  consumeChangedPath,
  peekChangedPath,
} from '../../services/agentFilePreviewStore';
import './MonacoTextEditor.css';

/** Align with --vscode-font-size (15px) in annotation preview. */
const EDITOR_FONT_SIZE = 15;
const EDITOR_LINE_HEIGHT = 22;

interface MonacoTextEditorProps {
  filePath: string;
  tabId: string;
  /** Used only on first open when no cached model exists in the document store. */
  bootstrapContent?: string;
  /** When set, force this content into the model (Agent 提案预览，可覆盖已缓存磁盘内容). */
  previewContent?: string;
  dirty?: boolean;
  readOnly?: boolean;
  visible?: boolean;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
}

export default function MonacoTextEditor({
  filePath,
  tabId,
  bootstrapContent,
  previewContent,
  dirty = false,
  readOnly = false,
  visible = true,
  onDirtyChange,
}: MonacoTextEditorProps) {
  const { effectiveTheme } = useTheme();
  const [loading, setLoading] = useState(false);
  const [diskEpoch, setDiskEpoch] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const currentPathRef = useRef('');
  const currentTabIdRef = useRef(tabId);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const bootstrapContentRef = useRef(bootstrapContent);
  const previewContentRef = useRef(previewContent);
  const diskEpochRef = useRef(0);
  const disposablesRef = useRef<monaco.IDisposable[]>([]);
  const loadGenerationRef = useRef(0);
  const readOnlyRef = useRef(readOnly);
  const themeRef = useRef(effectiveTheme);

  currentTabIdRef.current = tabId;
  onDirtyChangeRef.current = onDirtyChange;
  bootstrapContentRef.current = bootstrapContent;
  previewContentRef.current = previewContent;
  readOnlyRef.current = readOnly;
  themeRef.current = effectiveTheme;

  const ensureEditor =
    useCallback(async (): Promise<monaco.editor.IStandaloneCodeEditor | null> => {
      if (editorRef.current) return editorRef.current;
      const container = containerRef.current;
      if (!container) return null;

      const ready = await waitForEditorContainer(
        container,
        () => !containerRef.current,
      );
      if (!ready || !containerRef.current) return null;
      if (editorRef.current) return editorRef.current;

      const editorInstance = monaco.editor.create(containerRef.current, {
        readOnly: readOnlyRef.current,
        minimap: { enabled: false },
        fontSize: EDITOR_FONT_SIZE,
        lineHeight: EDITOR_LINE_HEIGHT,
        wordWrap: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        tabSize: 2,
        theme: themeRef.current === 'dark' ? 'lr-agent-dark' : 'lr-agent-light',
      });
      editorRef.current = editorInstance;

      const changeDisposable = editorInstance.onDidChangeModelContent(() => {
        const path = currentPathRef.current;
        const currentTabId = currentTabIdRef.current;
        const model = editorInstance.getModel();
        if (!path || !currentTabId || !model) return;
        if (readOnlyRef.current) {
          onDirtyChangeRef.current(currentTabId, false);
          return;
        }

        const next = model.getValue();
        const saved = getSavedText(path);
        onDirtyChangeRef.current(currentTabId, next !== saved);
      });
      disposablesRef.current.push(changeDisposable);

      scheduleEditorLayout(editorInstance);
      return editorInstance;
    }, []);

  useEffect(() => {
    return () => {
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
      editorRef.current?.dispose();
      editorRef.current = null;
      currentPathRef.current = '';
    };
  }, []);

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    editorInstance.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    monaco.editor.setTheme(
      effectiveTheme === 'dark' ? 'lr-agent-dark' : 'lr-agent-light',
    );
  }, [effectiveTheme]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const paths = (event as CustomEvent<{ paths?: string[] }>).detail?.paths;
      if (!filePath || !Array.isArray(paths) || paths.length === 0) return;
      const matched = paths.some((relative) => {
        const normalized = relative.replace(/\\/g, '/').toLowerCase();
        return filePath.replace(/\\/g, '/').toLowerCase().endsWith(normalized);
      });
      if (matched) setDiskEpoch((value) => value + 1);
    };
    window.addEventListener('lr-agent:workspace-text-files-changed', onChanged);
    return () => {
      window.removeEventListener(
        'lr-agent:workspace-text-files-changed',
        onChanged,
      );
    };
  }, [filePath]);

  useEffect(() => {
    if (!visible || !filePath) {
      setLoading(false);
      return undefined;
    }

    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    let cancelled = false;
    setLoading(true);

    const isStale = () => cancelled || generation !== loadGenerationRef.current;
    const previewText = previewContentRef.current;

    const run = async () => {
      const editorInstance = await ensureEditor();
      if (isStale() || !editorInstance) return;

      // Keep All 落盘后强制重读磁盘：事件可能在 filePath prop 为 ''（diff
      // 预览期间）时被吞掉，此处兜底探测待处理变更。加载成功后才消费标记，
      // 被作废的加载会把标记留给下次激活。
      const diskChanged = peekChangedPath(filePath);
      const forceReload =
        previewText !== undefined ||
        diskEpoch !== diskEpochRef.current ||
        diskChanged;

      const previousPath = currentPathRef.current;
      const existingModel = getDocumentModel(filePath);

      if (
        !forceReload &&
        existingModel &&
        editorInstance.getModel() === existingModel &&
        previousPath === filePath
      ) {
        setLoading(false);
        return;
      }

      let text: string | undefined;
      if (previewText !== undefined) {
        text = previewText;
      } else if (!forceReload && hasDocument(filePath)) {
        text = existingModel?.getValue();
      } else {
        text = bootstrapContentRef.current;
        if (text === undefined) {
          text = (await window.electron.fileSystem?.readFile(filePath)) ?? '';
        }
      }
      if (isStale() || text === undefined) return;

      const model = openDocument(filePath, text);
      if (isStale()) return;

      attachDocumentToEditor(editorInstance, filePath, model, previousPath);
      // 磁盘重载后同步 savedText，否则 openDocument 复用旧 savedText 会把
      // tab 误标为有未保存修改
      if (
        diskChanged ||
        (previewText === undefined && diskEpoch !== diskEpochRef.current)
      ) {
        markDocumentSaved(filePath, text);
      }
      if (diskChanged) {
        consumeChangedPath(filePath);
      }
      if (previewText !== undefined) {
        markDocumentSaved(filePath, text);
        onDirtyChangeRef.current(currentTabIdRef.current, false);
      }
      currentPathRef.current = filePath;
      diskEpochRef.current = diskEpoch;
      scheduleEditorLayout(editorInstance);
      setLoading(false);
    };

    run().catch((error: unknown) => {
      if (isStale()) return;
      // eslint-disable-next-line no-console
      console.warn('[MonacoTextEditor] load failed:', filePath, error);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [diskEpoch, ensureEditor, filePath, previewContent, visible]);

  useEffect(() => {
    if (!visible || !editorRef.current) return;
    scheduleEditorLayout(editorRef.current);
  }, [visible]);

  useEffect(() => {
    if (!filePath || dirty) return;
    markDocumentSaved(filePath);
  }, [dirty, filePath]);

  return (
    <div className="monaco-text-editor">
      <div ref={containerRef} className="monaco-text-editor-container" />
      {loading ? (
        <div className="monaco-text-editor-loading">加载中…</div>
      ) : null}
    </div>
  );
}
