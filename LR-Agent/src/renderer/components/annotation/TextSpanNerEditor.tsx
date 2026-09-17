import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import type { SpanAnnotation } from '../../types/annotationDocument';
import type { LabelDefinition } from '../../types/annotation';
import { getLabelChipStyle } from '../../utils/labelColor';
import { realTextOffsetInContainer } from '../../utils/textSpanOffsets';
import AnnotationDrawLabelPicker from './AnnotationDrawLabelPicker';
import './TextSpanNerEditor.css';

interface SpanHighlight {
  ann: SpanAnnotation;
  label: LabelDefinition | undefined;
}

interface TextSelection {
  start: number;
  end: number;
  text: string;
}

function buildSpanHighlights(
  spans: SpanAnnotation[],
  labels: LabelDefinition[],
): SpanHighlight[] {
  return spans.map((ann) => ({
    ann,
    label: labels.find((l) => l.id === ann.labelId),
  }));
}

export default function TextSpanNerEditor() {
  const { activeProject } = useAnnotation();
  const {
    workspaceEnabled,
    relativeFilePath,
    textContent,
    textContentLoading,
    spanAnnotations,
    activeLabelId,
    setActiveLabelId,
    labelUsage,
    addSpanAnnotation,
    updateAnnotationLabel,
    deleteAnnotation,
  } = useAnnotationWorkspace();

  const labels = activeProject?.labels ?? [];
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const textContainerRef = useRef<HTMLDivElement>(null);

  const highlights = useMemo(
    () => buildSpanHighlights(spanAnnotations, labels),
    [spanAnnotations, labels],
  );

  // 按 start 排序的 spans
  const sortedSpans = useMemo(
    () => [...spanAnnotations].sort((a, b) => a.start - b.start),
    [spanAnnotations],
  );

  // 读取文本选中内容
  const captureSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !textContainerRef.current) {
      setSelection(null);
      return;
    }
    const container = textContainerRef.current;
    if (
      !container.contains(sel.anchorNode) ||
      !container.contains(sel.focusNode)
    ) {
      setSelection(null);
      return;
    }

    const range = sel.getRangeAt(0);
    // 通过遍历纯文本节点计算真实 offset，排除渲染时嵌入的标签名文本
    const start = realTextOffsetInContainer(
      container,
      range.startContainer,
      range.startOffset,
    );
    const end = realTextOffsetInContainer(
      container,
      range.endContainer,
      range.endOffset,
    );
    const text = textContent
      ? textContent.slice(Math.min(start, end), Math.max(start, end))
      : range.toString();

    if (text.trim()) {
      setSelection({
        start: Math.min(start, end),
        end: Math.max(start, end),
        text,
      });
    } else {
      setSelection(null);
    }
  }, [textContent]);

  // 监听选区变化
  useEffect(() => {
    const onSelectionChange = () => {
      // 延迟读取，确保 selection 已稳定
      requestAnimationFrame(captureSelection);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', onSelectionChange);
  }, [captureSelection]);

  // 创建 span 标注
  const handleAddSpan = useCallback(() => {
    if (!selection || !activeLabelId) return;
    // 检查是否与已有 span 重叠
    const overlapping = spanAnnotations.some(
      (s) => !(selection.end <= s.start || selection.start >= s.end),
    );
    if (overlapping) return; // 或者可以提示用户
    addSpanAnnotation(selection.start, selection.end, activeLabelId);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, activeLabelId, spanAnnotations, addSpanAnnotation]);

  // 键盘快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        handleAddSpan();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleAddSpan]);

  // 切换标签
  const handleLabelChange = useCallback(
    (annId: string, newLabelId: string) => {
      updateAnnotationLabel(annId, newLabelId);
    },
    [updateAnnotationLabel],
  );

  // 点击已标注 span
  const handleSpanClick = useCallback((annId: string, e: ReactMouseEvent) => {
    e.stopPropagation();
    // 可以在此添加选中逻辑
  }, []);

  // 渲染带高亮的文本
  const renderHighlightedText = useMemo(() => {
    if (!textContent) return null;

    const parts: React.ReactNode[] = [];
    let cursor = 0;

    sortedSpans.forEach((span) => {
      const label = labels.find((l) => l.id === span.labelId);
      // 前置文本
      if (span.start > cursor) {
        parts.push(
          <span key={`txt-${cursor}`}>
            {textContent.slice(cursor, span.start)}
          </span>,
        );
      }
      // 标注文本
      parts.push(
        <span
          key={span.id}
          className="text-span-ner-highlight"
          style={{
            background: label?.color
              ? `${label.color}33`
              : 'rgba(100, 150, 255, 0.2)',
            borderBottom: `2px solid ${label?.color ?? '#6496ff'}`,
          }}
          title={`${label?.name ?? '未标注'} [${span.start}-${span.end}]`}
          data-span-id={span.id}
          onClick={(e) => handleSpanClick(span.id, e)}
        >
          {textContent.slice(span.start, span.end)}
          <span
            className="text-span-ner-label-tag"
            style={
              label
                ? { background: label.color, color: '#fff' }
                : { background: '#888', color: '#fff' }
            }
          >
            {label?.name ?? '未标注'}
          </span>
        </span>,
      );
      cursor = span.end;
    });

    // 剩余文本
    if (cursor < textContent.length) {
      parts.push(
        <span key={`txt-${cursor}`}>{textContent.slice(cursor)}</span>,
      );
    }

    return parts;
  }, [textContent, sortedSpans, labels, handleSpanClick]);

  if (!workspaceEnabled) {
    return (
      <div className="text-span-ner-editor">
        <div className="text-span-ner-empty">
          <VscodeIcon name="info" size={36} />
          <p>请在资源管理器中选择项目内的文本文件。</p>
        </div>
      </div>
    );
  }

  if (textContentLoading) {
    return (
      <div className="text-span-ner-editor">
        <div className="text-span-ner-empty">
          <p>加载文本内容…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="text-span-ner-editor">
      {/* 工具栏 */}
      <div className="text-span-ner-toolbar">
        <div className="text-span-ner-toolbar-left">
          <span
            className="text-span-ner-file-path"
            title={relativeFilePath ?? ''}
          >
            {relativeFilePath ?? '无文件'}
          </span>
          <span className="text-span-ner-stats">
            {spanAnnotations.length} 个实体标注
          </span>
        </div>
        <div className="text-span-ner-toolbar-right">
          {selection && activeLabelId ? (
            <VscodeButton onClick={handleAddSpan}>
              标注选中文本 (Ctrl+E)
            </VscodeButton>
          ) : null}
          {selection && !activeLabelId ? (
            <span className="text-span-ner-toolbar-hint">先选择标签</span>
          ) : null}
        </div>
      </div>

      {/* 标签选择器 */}
      <div className="text-span-ner-label-bar">
        <span className="text-span-ner-label-bar-title">标注标签：</span>
        {labels.length === 0 ? (
          <span className="text-span-ner-label-bar-empty">未定义标签</span>
        ) : (
          <AnnotationDrawLabelPicker
            className="text-span-ner-label-picker"
            variant="panel"
            labels={labels}
            labelUsage={labelUsage}
            activeLabelId={activeLabelId}
            onSelect={setActiveLabelId}
          />
        )}
      </div>

      {/* 文本主体 */}
      <div className="text-span-ner-body">
        <div
          ref={textContainerRef}
          className="text-span-ner-text"
          onMouseUp={captureSelection}
        >
          {textContent ? (
            renderHighlightedText
          ) : (
            <p className="text-span-ner-muted">无文本内容</p>
          )}
        </div>
      </div>

      {/* 当前选区提示 */}
      {selection && (
        <div className="text-span-ner-selection-bar">
          已选中: "{selection.text.slice(0, 50)}
          {selection.text.length > 50 ? '…' : ''}" ({selection.start}-
          {selection.end})
        </div>
      )}
    </div>
  );
}
