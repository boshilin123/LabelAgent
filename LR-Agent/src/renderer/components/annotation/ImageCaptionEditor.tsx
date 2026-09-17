import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import type { CaptionGranularity } from '../../types/annotationDocument';
import ImageAnnotationToolbar from './ImageAnnotationToolbar';
import './ImageCaptionEditor.css';

interface ImageCaptionEditorProps {
  imageUrl: string;
  imagePath: string;
}

const GRANULARITY_OPTIONS: { value: CaptionGranularity; label: string }[] = [
  { value: 'brief', label: '简要' },
  { value: 'detailed', label: '详细' },
  { value: 'dense', label: '密集' },
];

const DEFAULT_PANEL_HEIGHT = 200;
const MIN_PANEL_HEIGHT = 100;
const MAX_PANEL_RATIO = 0.6;

type CaptionTab = 'input' | 'history';

export default function ImageCaptionEditor({
  imageUrl,
  imagePath,
}: ImageCaptionEditorProps) {
  const { activeProject } = useAnnotation();
  const {
    captionAnnotations,
    addCaptionAnnotation,
    updateCaptionAnnotation,
    deleteAnnotation,
  } = useAnnotationWorkspace();

  const [text, setText] = useState('');
  const [granularity, setGranularity] =
    useState<CaptionGranularity>('detailed');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [activeTab, setActiveTab] = useState<CaptionTab>('input');
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const dragHeightRef = useRef(DEFAULT_PANEL_HEIGHT);
  const resizeRAFRef = useRef<number | null>(null);
  const prevExpandedHeightRef = useRef(DEFAULT_PANEL_HEIGHT);

  // ── 水平拖拽调整面板高度 ──
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = panelCollapsed ? MIN_PANEL_HEIGHT : panelHeight;
      dragHeightRef.current = startHeightRef.current;
      if (panelCollapsed) setPanelCollapsed(false);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.body.classList.add('is-resizing-row');
    },
    [panelCollapsed, panelHeight],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = startYRef.current - e.clientY;
      const containerH = containerRef.current?.clientHeight ?? 600;
      const maxH = Math.max(
        MIN_PANEL_HEIGHT,
        Math.round(containerH * MAX_PANEL_RATIO),
      );
      dragHeightRef.current = Math.max(
        MIN_PANEL_HEIGHT,
        Math.min(maxH, startHeightRef.current + delta),
      );

      if (resizeRAFRef.current != null) return;
      resizeRAFRef.current = requestAnimationFrame(() => {
        resizeRAFRef.current = null;
        setPanelHeight(Math.round(dragHeightRef.current));
      });
    };

    const onUp = () => {
      if (resizeRAFRef.current != null) {
        cancelAnimationFrame(resizeRAFRef.current);
        resizeRAFRef.current = null;
      }
      dragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.classList.remove('is-resizing-row');
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.classList.remove('is-resizing-row');
    };
  }, []);

  // ── 面板折叠/展开 ──
  const toggleCollapse = useCallback(() => {
    setPanelCollapsed((prev) => {
      if (prev) {
        // 展开：恢复到折叠前的高度
        setPanelHeight(prevExpandedHeightRef.current);
      } else {
        // 折叠：记住当前高度
        prevExpandedHeightRef.current = panelHeight;
      }
      return !prev;
    });
  }, [panelHeight]);

  // ── Caption 增删改 ──
  const handleAdd = useCallback(() => {
    if (!text.trim()) return;
    addCaptionAnnotation({ text: text.trim(), granularity });
    setText('');
  }, [text, granularity, addCaptionAnnotation]);

  const handleStartEdit = useCallback((id: string, currentText: string) => {
    setEditingId(id);
    setEditText(currentText);
    setActiveTab('history');
  }, []);

  const handleSaveEdit = useCallback(
    (id: string) => {
      if (!editText.trim()) return;
      updateCaptionAnnotation(id, { text: editText.trim() });
      setEditingId(null);
      setEditText('');
    },
    [editText, updateCaptionAnnotation],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditText('');
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      deleteAnnotation(id);
      if (editingId === id) {
        setEditingId(null);
        setEditText('');
      }
    },
    [deleteAnnotation, editingId],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleAdd();
      }
    },
    [handleAdd],
  );

  if (!activeProject) return null;

  return (
    <div className="image-caption-editor">
      <ImageAnnotationToolbar mode="caption" imagePath={imagePath} />

      <div className="image-caption-view" ref={containerRef}>
        {/* 图片预览：全宽 */}
        <div className="image-caption-preview">
          <img
            src={imageUrl}
            alt="标注图片预览"
            className="image-caption-preview-img"
          />
        </div>

        {/* 可拖拽分割线 */}
        <button
          type="button"
          className="image-caption-resizer"
          aria-label="拖拽调整面板高度"
          onMouseDown={onResizeStart}
        >
          <span className="image-caption-resizer-handle" />
        </button>

        {/* 底部面板 */}
        <div
          className={`image-caption-drawer${panelCollapsed ? ' image-caption-drawer--collapsed' : ''}`}
          style={panelCollapsed ? { height: 0 } : { height: panelHeight }}
        >
          {/* Tab 栏 */}
          <div className="image-caption-tabs">
            <div className="image-caption-tabs-left">
              <button
                type="button"
                className={`image-caption-tab${activeTab === 'input' ? ' image-caption-tab--active' : ''}`}
                onClick={() => setActiveTab('input')}
              >
                输入
              </button>
              <button
                type="button"
                className={`image-caption-tab${activeTab === 'history' ? ' image-caption-tab--active' : ''}`}
                onClick={() => setActiveTab('history')}
              >
                已有描述
                {captionAnnotations.length > 0 && (
                  <span className="image-caption-tab-badge">
                    {captionAnnotations.length}
                  </span>
                )}
              </button>
            </div>
            <VscodeButton
              secondary
              className="image-caption-collapse-btn"
              title={panelCollapsed ? '展开面板' : '收起面板'}
              aria-label={panelCollapsed ? '展开面板' : '收起面板'}
              onClick={toggleCollapse}
            >
              <span
                className={`codicon codicon-chevron-${panelCollapsed ? 'up' : 'down'}`}
                aria-hidden
              />
            </VscodeButton>
          </div>

          {/* Tab 内容区 */}
          <div className="image-caption-drawer-body">
            {activeTab === 'input' ? (
              <div className="image-caption-input-tab">
                <div className="image-caption-granularity-row">
                  <label className="image-caption-label">粒度：</label>
                  <div
                    className="image-caption-granularity-group"
                    role="radiogroup"
                  >
                    {GRANULARITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`image-caption-granularity-btn${granularity === opt.value ? ' image-caption-granularity-btn--active' : ''}`}
                        role="radio"
                        aria-checked={granularity === opt.value}
                        onClick={() => setGranularity(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <textarea
                  className="image-caption-textarea"
                  placeholder="输入图片描述文本…&#10;提示：Ctrl+Enter 快速添加"
                  value={text}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                    setText(e.target.value)
                  }
                  onKeyDown={handleKeyDown}
                  rows={3}
                />

                <div className="image-caption-input-actions">
                  <VscodeButton
                    className="image-caption-add-btn"
                    disabled={!text.trim()}
                    onClick={handleAdd}
                  >
                    添加描述
                  </VscodeButton>
                </div>
              </div>
            ) : (
              <div className="image-caption-history-tab">
                {captionAnnotations.length === 0 ? (
                  <p className="image-caption-empty">
                    暂无描述。切换到「输入」标签页添加描述。
                  </p>
                ) : (
                  <div className="image-caption-list">
                    {captionAnnotations.map((ann) => (
                      <div key={ann.id} className="image-caption-item">
                        {editingId === ann.id ? (
                          <div className="image-caption-edit-form">
                            <textarea
                              className="image-caption-textarea image-caption-textarea--edit"
                              value={editText}
                              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                                setEditText(e.target.value)
                              }
                              rows={3}
                            />
                            <div className="image-caption-edit-actions">
                              <VscodeButton
                                secondary
                                disabled={!editText.trim()}
                                onClick={() => handleSaveEdit(ann.id)}
                              >
                                保存
                              </VscodeButton>
                              <VscodeButton
                                secondary
                                onClick={handleCancelEdit}
                              >
                                取消
                              </VscodeButton>
                            </div>
                          </div>
                        ) : (
                          <div className="image-caption-item-display">
                            <span className="image-caption-item-granularity-tag">
                              {GRANULARITY_OPTIONS.find(
                                (o) => o.value === ann.granularity,
                              )?.label ?? ann.granularity}
                            </span>
                            <span
                              className="image-caption-item-text"
                              title={ann.text}
                            >
                              {ann.text}
                            </span>
                            <div className="image-caption-item-actions">
                              <VscodeButton
                                secondary
                                onClick={() =>
                                  handleStartEdit(ann.id, ann.text)
                                }
                              >
                                编辑
                              </VscodeButton>
                              <VscodeButton
                                secondary
                                onClick={() => handleDelete(ann.id)}
                              >
                                删除
                              </VscodeButton>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
