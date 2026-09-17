import {
  VscodeButton,
  VscodeIcon,
  VscodeLabel,
  VscodeProgressRing,
  VscodeScrollable,
} from '@vscode-elements/react-elements';
import mammoth from 'mammoth';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp } from '../context/AppContext';
import { useAnnotationWorkspace } from '../context/AnnotationWorkspaceContext';
import { basename, dirname, getExtension } from '../types/file';
import { resolveViewerType, type ViewerType } from '../utils/fileViewerType';
import { getLanguageForFile } from '../utils/syntaxHighlight';
import { isSafeExternalUrl, sanitizeDocxHtml } from '../utils/sanitizeHtml';
import { createMarkdownCodeComponents } from './markdown/markdownCodeComponents';
import {
  getAdjacentSiblingFile,
  listSiblingFiles,
} from '../utils/siblingFiles';
import HighlightedCodeBlock from './preview/HighlightedCodeBlock';
import PdfPreview from './preview/PdfPreview';
import ImageFabricAnnotationEditor from './annotation/ImageFabricAnnotationEditor';
import ImageFabricRotatedBboxAnnotationEditor from './annotation/ImageFabricRotatedBboxAnnotationEditor';
import ImageFabricPolygonAnnotationEditor from './annotation/ImageFabricPolygonAnnotationEditor';
import ImageFabricKeypointAnnotationEditor from './annotation/ImageFabricKeypointAnnotationEditor';
import ImageCaptionEditor from './annotation/ImageCaptionEditor';
import ImageClassificationEditor from './annotation/ImageClassificationEditor';
import TextSpanNerEditor from './annotation/TextSpanNerEditor';
import TextClassificationEditor from './annotation/TextClassificationEditor';
import TextInstructionEditor from './annotation/TextInstructionEditor';
import TextPreferenceEditor from './annotation/TextPreferenceEditor';
import TextConversationEditor from './annotation/TextConversationEditor';
import TextCotEditor from './annotation/TextCotEditor';
import FileTypeIcon from './FileTypeIcon';
import VscodeClickableToolbarButton from './VscodeClickableButton';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import './FileViewer.css';

function AgentPreviewBanner() {
  const { agentPreviewReadOnly } = useAnnotationWorkspace();
  if (!agentPreviewReadOnly) return null;
  return (
    <div className="agent-preview-banner" role="status">
      提案预览（未应用）— 当前为 Agent 提案合并结果，应用前不可编辑
    </div>
  );
}

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

const PREVIEW_BINARY_EXTENSIONS = new Set(['pdf', ...IMAGE_EXTENSIONS]);

/** 检查选区是否在 viewer-body 容器内 */
function isSelectionInsideViewer(containerEl: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const { anchorNode, focusNode } = sel;
  return (
    Boolean(anchorNode && containerEl.contains(anchorNode)) ||
    Boolean(focusNode && containerEl.contains(focusNode))
  );
}

/** 选中 viewer-body 内所有文本 */
function selectAllInViewer(containerEl: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(containerEl);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // 聚焦主区域确保接收后续键盘事件
  containerEl.closest<HTMLElement>('.file-viewer')?.focus();
}

function FileHeader({
  filePath,
  fileName,
  onSelectFile,
}: {
  filePath: string;
  fileName: string;
  onSelectFile: (filePath: string) => void;
}) {
  const [canNavigate, setCanNavigate] = useState(false);

  useEffect(() => {
    let cancelled = false;

    listSiblingFiles(filePath).then((siblings) => {
      if (!cancelled) {
        setCanNavigate(siblings.length > 1);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const navigateSibling = useCallback(
    async (direction: 'prev' | 'next') => {
      const nextPath = await getAdjacentSiblingFile(filePath, direction);
      if (nextPath) {
        onSelectFile(nextPath);
      }
    },
    [filePath, onSelectFile],
  );

  return (
    <div className="file-header">
      <div className="file-header-left">
        <FileTypeIcon path={filePath} size={16} className="file-header-icon" />
        <span className="file-header-name" title={filePath}>
          {fileName}
        </span>
      </div>
      <div
        className={`file-header-nav${canNavigate ? '' : ' file-header-nav--disabled'}`}
      >
        <VscodeClickableToolbarButton
          icon="chevron-left"
          label="上一个文件"
          onClick={() => {
            void navigateSibling('prev');
          }}
        />
        <VscodeClickableToolbarButton
          icon="chevron-right"
          label="下一个文件"
          onClick={() => {
            void navigateSibling('next');
          }}
        />
      </div>
      <div className="file-header-right" aria-hidden="true" />
    </div>
  );
}

interface FileViewerProps {
  filePath: string | null;
  embedded?: boolean;
  /** Hide the in-viewer file header (e.g. editor tabs already show the file name). */
  hideFileHeader?: boolean;
  /** When true, defer/cancel heavy file loads (inactive tabs). */
  loadPaused?: boolean;
  /** Override detected viewer type (e.g. binary guard in editor mode). */
  forceViewerType?: ViewerType;
}

export default function FileViewer({
  filePath,
  embedded = false,
  hideFileHeader = false,
  loadPaused = false,
  forceViewerType,
}: FileViewerProps) {
  const { selectFile } = useApp();
  const annotationWorkspace = useAnnotationWorkspace();
  const showImageAnnotator = annotationWorkspace.workspaceEnabled;
  const isPolygonAnnotator =
    annotationWorkspace.imageAnnotationType === 'polygon';
  const isRotatedBboxAnnotator =
    annotationWorkspace.imageAnnotationType === 'rotated_bbox';
  const isKeypointAnnotator =
    annotationWorkspace.imageAnnotationType === 'keypoint';
  const isCaptionAnnotator =
    annotationWorkspace.imageAnnotationType === 'caption';
  const isClassificationAnnotator =
    annotationWorkspace.imageAnnotationType === 'classification';
  const showTextAnnotator =
    annotationWorkspace.workspaceEnabled &&
    annotationWorkspace.textAnnotationType !== null;
  const viewerType = useMemo(
    () =>
      resolveViewerType(filePath, {
        forceViewerType,
        preferTextForMarkdown: showTextAnnotator,
      }),
    [filePath, forceViewerType, showTextAnnotator],
  );
  const markdownComponents = useMemo(
    () =>
      createMarkdownCodeComponents({
        imageBaseDir: filePath ? dirname(filePath) : null,
      }),
    [filePath],
  );
  const [textContent, setTextContent] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── 选区与右键菜单 ──
  const viewerRef = useRef<HTMLDivElement>(null);
  const viewerBodyRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // 监听选区变化
  useEffect(() => {
    const onSelectionChange = () => {
      const body = viewerBodyRef.current;
      if (!body) {
        setHasSelection(false);
        return;
      }
      setHasSelection(isSelectionInsideViewer(body));
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', onSelectionChange);
  }, [filePath]);

  // 点击时聚焦主区域（不抢夺 textarea/input/select/button/contentEditable 等已有焦点元素的焦点）
  const handleMainClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      tag === 'BUTTON' ||
      target.isContentEditable
    ) {
      return;
    }
    viewerRef.current?.focus();
  }, []);

  // 键盘处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const body = viewerBodyRef.current;
    if (!body) return;

    switch (e.key.toLowerCase()) {
      case 'a':
        e.preventDefault();
        selectAllInViewer(body);
        break;
      case 'c':
        e.preventDefault();
        document.execCommand('copy');
        break;
      case 'x':
        e.preventDefault();
        document.execCommand('cut');
        break;
      case 'v':
        e.preventDefault();
        document.execCommand('paste');
        break;
      default:
        break;
    }
  }, []);

  // 右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const sel = window.getSelection();
    const body = viewerBodyRef.current;
    if (!body || !sel || sel.isCollapsed || !isSelectionInsideViewer(body)) {
      return;
    }
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const prevShowImageAnnotatorRef = useRef(showImageAnnotator);
  const [imageViewGeneration, setImageViewGeneration] = useState(0);

  useEffect(() => {
    if (prevShowImageAnnotatorRef.current && !showImageAnnotator) {
      closeContextMenu();
      window.getSelection()?.removeAllRanges();
      setImageViewGeneration((generation) => generation + 1);
    }
    prevShowImageAnnotatorRef.current = showImageAnnotator;
  }, [showImageAnnotator, closeContextMenu]);

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    return [
      {
        id: 'cut',
        label: '剪切',
        shortcut: 'Ctrl+X',
        disabled: !hasSelection,
        onClick: () => {
          document.execCommand('cut');
        },
      },
      {
        id: 'copy',
        label: '复制',
        shortcut: 'Ctrl+C',
        disabled: !hasSelection,
        onClick: () => {
          document.execCommand('copy');
        },
      },
      {
        id: 'paste',
        label: '粘贴',
        shortcut: 'Ctrl+V',
        onClick: () => {
          document.execCommand('paste');
        },
      },
    ];
  }, [hasSelection]);

  const highlightLanguage = useMemo(
    () => (filePath ? getLanguageForFile(filePath) : null),
    [filePath],
  );

  useEffect(() => {
    if (loadPaused) {
      setBinaryUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setPdfData(null);
      setTextContent(null);
      setDocxHtml(null);
      setLoading(false);
      setError(null);
      return undefined;
    }

    setTextContent(null);
    setDocxHtml(null);
    setBinaryUrl(null);
    setPdfData(null);
    setError(null);

    if (!filePath) return undefined;

    if (viewerType === 'binary') {
      setLoading(false);
      return undefined;
    }

    let revoked = false;
    let objectUrl: string | null = null;

    const load = async () => {
      setLoading(true);
      try {
        if (viewerType === 'markdown' || viewerType === 'text') {
          const text = await window.electron.fileSystem?.readFile(filePath);
          if (revoked) return;
          if (text === null) {
            setError('无法读取文件');
          } else {
            setTextContent(text);
          }
          return;
        }

        if (viewerType === 'docx') {
          const buffer =
            await window.electron.fileSystem?.readFileBuffer(filePath);
          if (revoked) return;
          if (!buffer) {
            setError('无法读取文件');
            return;
          }
          const result = await mammoth.convertToHtml({
            arrayBuffer: buffer,
          });
          if (revoked) return;
          // mammoth 不消毒：docx 正文属不可信内容，必须净化后再注入 DOM
          setDocxHtml(sanitizeDocxHtml(result.value));
          return;
        }

        if (
          viewerType === 'pdf' ||
          viewerType === 'image' ||
          PREVIEW_BINARY_EXTENSIONS.has(getExtension(filePath))
        ) {
          const buffer =
            await window.electron.fileSystem?.readFileBuffer(filePath);
          if (revoked) return;
          if (!buffer) {
            setError('无法读取文件');
            return;
          }
          if (viewerType === 'pdf') {
            setPdfData(new Uint8Array(buffer));
            return;
          }
          const blob = new Blob([buffer]);
          objectUrl = URL.createObjectURL(blob);
          setBinaryUrl(objectUrl);
          return;
        }

        setError('暂不支持预览此文件类型');
      } catch {
        if (!revoked) setError('加载文件时出错');
      } finally {
        if (!revoked) setLoading(false);
      }
    };

    load();

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, viewerType, loadPaused]);

  const handleOpenExternal = async () => {
    if (!filePath) return;
    const err = await window.electron.fileSystem?.openPath(filePath);
    if (err) setError(`无法用系统打开: ${err}`);
  };

  // Word 预览中的超链接：阻止默认的当前窗口导航，改用系统浏览器打开
  const handleDocxLinkClick = useCallback((e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    // docx 内链接触发当前窗口导航或执行脚本都有风险：
    // 除 https 外一律阻断，仅 https 交给系统浏览器。
    e.preventDefault();
    const href = anchor.getAttribute('href');
    if (isSafeExternalUrl(href)) {
      window.electron.window.openExternal(href!).catch(() => undefined);
    }
  }, []);

  // ── 渲染内容区（body） ──

  const renderBody = () => {
    let body: React.ReactNode = null;
    if (loading) {
      body = (
        <div className="viewer-body loading">
          <VscodeProgressRing />
          <VscodeLabel>加载中...</VscodeLabel>
        </div>
      );
    } else if (error && viewerType !== 'unsupported') {
      body = (
        <div className="viewer-body error-state">
          <VscodeIcon name="warning" size={32} />
          <VscodeLabel>{error}</VscodeLabel>
          <VscodeButton icon="link-external" onClick={handleOpenExternal}>
            用系统应用打开
          </VscodeButton>
        </div>
      );
    } else if (viewerType === 'pdf' && pdfData) {
      body = (
        <PdfPreview
          pdfData={pdfData}
          onError={(message) => setError(message)}
        />
      );
    } else if (viewerType === 'image' && binaryUrl) {
      body = (
        <div
          key={`image-view-${imageViewGeneration}-${showImageAnnotator ? 'fabric' : 'preview'}`}
          className="viewer-body image-container image-container--fabric"
        >
          {showImageAnnotator ? (
            isKeypointAnnotator ? (
              <ImageFabricKeypointAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath!}
              />
            ) : isPolygonAnnotator ? (
              <ImageFabricPolygonAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath!}
              />
            ) : isRotatedBboxAnnotator ? (
              <ImageFabricRotatedBboxAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath!}
              />
            ) : isCaptionAnnotator ? (
              <ImageCaptionEditor imageUrl={binaryUrl} imagePath={filePath!} />
            ) : isClassificationAnnotator ? (
              <ImageClassificationEditor
                imageUrl={binaryUrl}
                imagePath={filePath!}
              />
            ) : (
              <ImageFabricAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath!}
              />
            )
          ) : (
            <img
              src={binaryUrl}
              alt={fileName}
              className="image-preview-only"
            />
          )}
        </div>
      );
    } else if (viewerType === 'markdown') {
      body = (
        <VscodeScrollable className="viewer-body markdown-content">
          {textContent ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {textContent}
            </ReactMarkdown>
          ) : (
            <div className="loading">
              <VscodeProgressRing />
            </div>
          )}
        </VscodeScrollable>
      );
    } else if (viewerType === 'docx' && docxHtml) {
      body = (
        <VscodeScrollable className="viewer-body docx-content">
          <div
            className="docx-html"
            onClick={handleDocxLinkClick}
            dangerouslySetInnerHTML={{ __html: docxHtml }}
          />
        </VscodeScrollable>
      );
    } else if (viewerType === 'binary') {
      body = (
        <div className="viewer-body error-state">
          <VscodeIcon name="file-binary" size={32} />
          <VscodeLabel>二进制文件，无法在编辑器中编辑</VscodeLabel>
          <VscodeButton icon="link-external" onClick={handleOpenExternal}>
            用系统应用打开
          </VscodeButton>
        </div>
      );
    } else if (viewerType === 'text' && textContent !== null) {
      // 文本标注路由
      const textType = annotationWorkspace.textAnnotationType;
      if (showTextAnnotator && textType) {
        switch (textType) {
          case 'span_ner':
            body = <TextSpanNerEditor />;
            break;
          case 'text_classification':
            body = <TextClassificationEditor />;
            break;
          case 'instruction':
            body = <TextInstructionEditor />;
            break;
          case 'preference':
            body = <TextPreferenceEditor />;
            break;
          case 'conversation':
            body = <TextConversationEditor />;
            break;
          case 'cot':
            body = <TextCotEditor />;
            break;
          default:
            body = (
              <VscodeScrollable className="viewer-body text-content">
                {highlightLanguage ? (
                  <HighlightedCodeBlock
                    content={textContent}
                    filePath={filePath!}
                  />
                ) : (
                  <pre className="code-block">{textContent}</pre>
                )}
              </VscodeScrollable>
            );
        }
      } else {
        body = (
          <VscodeScrollable className="viewer-body text-content">
            {highlightLanguage ? (
              <HighlightedCodeBlock
                content={textContent}
                filePath={filePath!}
              />
            ) : (
              <pre className="code-block">{textContent}</pre>
            )}
          </VscodeScrollable>
        );
      }
    } else {
      body = (
        <div className="viewer-body error-state">
          <VscodeIcon name="file-binary" size={32} />
          <VscodeLabel>{error || '暂不支持预览此文件类型'}</VscodeLabel>
          <VscodeButton icon="link-external" onClick={handleOpenExternal}>
            用系统应用打开
          </VscodeButton>
        </div>
      );
    }
    return (
      <div ref={viewerBodyRef} className="file-viewer-body-inner">
        {body}
      </div>
    );
  };

  if (!filePath) {
    // Freeform mode: LLM text annotation without a file
    const freeformTextType = annotationWorkspace.textAnnotationType;
    const freeformLLM =
      annotationWorkspace.freeformMode ||
      (freeformTextType &&
        (freeformTextType === 'instruction' ||
          freeformTextType === 'preference' ||
          freeformTextType === 'conversation' ||
          freeformTextType === 'cot') &&
        annotationWorkspace.workspaceEnabled);

    if (freeformLLM && freeformTextType) {
      switch (freeformTextType) {
        case 'instruction':
          return (
            <div className="file-viewer" tabIndex={0}>
              <AgentPreviewBanner />
              <TextInstructionEditor />
            </div>
          );
        case 'preference':
          return (
            <div className="file-viewer" tabIndex={0}>
              <AgentPreviewBanner />
              <TextPreferenceEditor />
            </div>
          );
        case 'conversation':
          return (
            <div className="file-viewer" tabIndex={0}>
              <AgentPreviewBanner />
              <TextConversationEditor />
            </div>
          );
        case 'cot':
          return (
            <div className="file-viewer" tabIndex={0}>
              <AgentPreviewBanner />
              <TextCotEditor />
            </div>
          );
      }
    }

    if (embedded) return null;
    return (
      <div className="file-viewer-empty">
        <VscodeIcon name="files" size={48} />
        <VscodeLabel>在左侧选择文件以预览</VscodeLabel>
      </div>
    );
  }

  const fileName = basename(filePath);
  const fileHeaderProps = {
    filePath,
    fileName,
    onSelectFile: selectFile,
  };

  return (
    <div
      ref={viewerRef}
      className="file-viewer"
      tabIndex={0}
      onClick={handleMainClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      {!hideFileHeader ? <FileHeader {...fileHeaderProps} /> : null}
      <AgentPreviewBanner />
      {renderBody()}
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
