import { useCallback, useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { useTheme } from '../../context/ThemeContext';
import { getMonacoLanguageForFile } from '../../utils/syntaxHighlight';
import { waitForEditorContainer } from './monacoEditorHelpers';
import './MonacoDiffView.css';

/** 与 MonacoTextEditor 保持一致，统一渲染观感 */
const EDITOR_FONT_SIZE = 15;
const EDITOR_LINE_HEIGHT = 22;
/** 自适应高度模式下容器高度上限（行），超出走编辑器内部滚动 */
const MAX_VISIBLE_LINES = 24;
const MIN_VISIBLE_LINES = 3;
/** 流式内容更新的节流 */
const MODEL_UPDATE_THROTTLE = 120;

interface MonacoDiffViewProps {
  relativePath: string;
  oldContent: string;
  newContent: string;
  /** 折叠未变更区域（Monaco hideUnchangedRegions，默认开启） */
  collapseUnchanged?: boolean;
  /** 由外层 flex 撑满固定高度（编辑器预览）；默认按内容自适应并封顶 */
  fill?: boolean;
  /** 首次 diff 计算完成后滚动到第一处变更 */
  revealFirstChange?: boolean;
  /**
   * 是否显示行号。内联 diff 是 unified 风格，改动行会同时出现新旧两个
   * 行号列（类似 GitHub）；窄卡片下默认关闭。
   */
  showLineNumbers?: boolean;
}

/**
 * 只读 Monaco DiffEditor（单栏内联 diff）。
 * 统一聊天卡片与编辑器预览的 diff 渲染：与编辑视图同字体、同主题；
 * 未变更区域的折叠由 Monaco 原生 hideUnchangedRegions 承担。
 * 模型为游离 model（无 URI），不与 editorDocumentStore 的文件模型池冲突。
 */
export default function MonacoDiffView({
  relativePath,
  oldContent,
  newContent,
  collapseUnchanged = true,
  fill = false,
  revealFirstChange = false,
  showLineNumbers = true,
}: MonacoDiffViewProps) {
  const { effectiveTheme } = useTheme();
  const outerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(
    null,
  );
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const modelsPathRef = useRef<string | null>(null);
  const disposablesRef = useRef<monaco.IDisposable[]>([]);
  const fillRef = useRef(fill);
  const revealRef = useRef(revealFirstChange);
  const revealedRef = useRef(false);
  const collapseRef = useRef(collapseUnchanged);
  const lineNumbersRef = useRef(showLineNumbers);
  const pathRef = useRef(relativePath);
  const oldRef = useRef(oldContent);
  const newRef = useRef(newContent);
  const pendingRef = useRef<{ old: string; new: string } | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  fillRef.current = fill;
  revealRef.current = revealFirstChange;
  collapseRef.current = collapseUnchanged;
  lineNumbersRef.current = showLineNumbers;
  pathRef.current = relativePath;
  oldRef.current = oldContent;
  newRef.current = newContent;

  const updateHeight = useCallback(() => {
    const diffEditor = diffEditorRef.current;
    const outer = outerRef.current;
    if (!diffEditor || !outer || fillRef.current) return;
    const contentHeight = diffEditor.getModifiedEditor().getScrollHeight() + 8;
    const capped = Math.min(
      contentHeight,
      MAX_VISIBLE_LINES * EDITOR_LINE_HEIGHT + 8,
    );
    outer.style.height = `${Math.max(
      capped,
      MIN_VISIBLE_LINES * EDITOR_LINE_HEIGHT,
    )}px`;
  }, []);

  /** 双 rAF 布局：等容器尺寸生效后再 layout（对齐 monacoEditorHelpers 的节奏） */
  const scheduleDiffLayout = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        diffEditorRef.current?.layout();
        updateHeight();
      });
    });
  }, [updateHeight]);

  const applyModels = useCallback(() => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) return;
    const path = pathRef.current;
    if (modelsPathRef.current === path) return;
    originalModelRef.current?.dispose();
    modifiedModelRef.current?.dispose();
    const language = getMonacoLanguageForFile(path);
    originalModelRef.current = monaco.editor.createModel(
      oldRef.current,
      language,
    );
    modifiedModelRef.current = monaco.editor.createModel(
      newRef.current,
      language,
    );
    diffEditor.setModel({
      original: originalModelRef.current,
      modified: modifiedModelRef.current,
    });
    modelsPathRef.current = path;
    revealedRef.current = false;
    updateHeight();
  }, [updateHeight]);

  const revealFirstDiff = useCallback(() => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor || revealedRef.current) return;
    revealedRef.current = true;
    const changes = diffEditor.getLineChanges();
    const first = changes && changes.length > 0 ? changes[0] : null;
    const line =
      first && first.modifiedStartLineNumber > 0
        ? first.modifiedStartLineNumber
        : first?.originalStartLineNumber;
    if (line) {
      diffEditor.getModifiedEditor().revealLineInCenter(line);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return undefined;

    const run = async () => {
      const ready = await waitForEditorContainer(
        container,
        () => !containerRef.current,
      );
      if (!ready || cancelled || !containerRef.current) return;
      if (diffEditorRef.current) return;

      const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
        readOnly: true,
        renderSideBySide: false,
        originalEditable: false,
        // 内联模式下隐藏原文编辑器残留条（其行号装饰区会露出第二列原文行号）
        compactMode: true,
        minimap: { enabled: false },
        fontSize: EDITOR_FONT_SIZE,
        lineHeight: EDITOR_LINE_HEIGHT,
        wordWrap: 'on',
        diffWordWrap: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
        overviewRulerLanes: 0,
        // 关闭行号槽里的 +/- 指示符与条纹，只保留整行浅色底
        renderIndicators: false,
        lineNumbers: lineNumbersRef.current ? 'on' : 'off',
        lineNumbersMinChars: 3,
        glyphMargin: false,
        folding: false,
        renderLineHighlight: 'none',
        occurrencesHighlight: 'off',
        selectionHighlight: false,
        matchBrackets: 'never',
        stickyScroll: { enabled: false },
        guides: {
          indentation: false,
          highlightActiveIndentation: false,
          bracketPairs: false,
        },
        bracketPairColorization: { enabled: false },
        unicodeHighlight: {
          ambiguousCharacters: false,
          invisibleCharacters: false,
        },
        stopRenderingLineAfter: 1000,
        hideUnchangedRegions: {
          enabled: collapseRef.current,
          minimumLineCount: 3,
          contextLineCount: 2,
          revealLineCount: 20,
        },
        scrollbar: { alwaysConsumeMouseWheel: false },
        theme: effectiveTheme === 'dark' ? 'lr-agent-dark' : 'lr-agent-light',
      });
      diffEditorRef.current = diffEditor;

      const diffDisposable = diffEditor.onDidUpdateDiff(() => {
        if (revealRef.current) revealFirstDiff();
        updateHeight();
      });
      disposablesRef.current.push(diffDisposable);

      applyModels();
      scheduleDiffLayout();
      updateHeight();
    };
    run();

    return () => {
      cancelled = true;
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
      diffEditorRef.current?.dispose();
      diffEditorRef.current = null;
      originalModelRef.current?.dispose();
      originalModelRef.current = null;
      modifiedModelRef.current?.dispose();
      modifiedModelRef.current = null;
      modelsPathRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    applyModels();
  }, [applyModels, relativePath]);

  // 内容更新（流式）节流后 setValue，触发重算 diff 并自适应高度
  useEffect(() => {
    const diffEditor = diffEditorRef.current;
    const original = originalModelRef.current;
    const modified = modifiedModelRef.current;
    if (!diffEditor || !original || !modified) return;
    if (modelsPathRef.current !== relativePath) return;

    pendingRef.current = { old: oldContent, new: newContent };
    if (pendingTimerRef.current) return;
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = null;
      if (original.getValue() !== pending.old) {
        original.setValue(pending.old);
      }
      if (modified.getValue() !== pending.new) {
        modified.setValue(pending.new);
      }
    }, MODEL_UPDATE_THROTTLE);
  }, [newContent, oldContent, relativePath]);

  useEffect(() => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) return;
    diffEditor.updateOptions({
      hideUnchangedRegions: {
        enabled: collapseUnchanged,
        minimumLineCount: 3,
        contextLineCount: 2,
        revealLineCount: 20,
      },
    });
    scheduleDiffLayout();
  }, [collapseUnchanged, scheduleDiffLayout]);

  useEffect(() => {
    monaco.editor.setTheme(
      effectiveTheme === 'dark' ? 'lr-agent-dark' : 'lr-agent-light',
    );
  }, [effectiveTheme]);

  return (
    <div
      ref={outerRef}
      className={`monaco-diff-view${fill ? ' monaco-diff-view--fill' : ''}`}
    >
      <div ref={containerRef} className="monaco-diff-view__container" />
    </div>
  );
}
