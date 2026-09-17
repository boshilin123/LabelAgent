import { useCallback, useRef, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import './TextSourcePreviewPanel.css';

interface TextSourcePreviewPanelProps {
  /** 将选中文本填入目标字段 */
  onQuoteSelection?: (text: string) => void;
  /** 将全文填入目标字段 */
  onQuoteFull?: (text: string) => void;
  quoteSelectionLabel?: string;
  quoteFullLabel?: string;
}

export default function TextSourcePreviewPanel({
  onQuoteSelection,
  onQuoteFull,
  quoteSelectionLabel = '引用选中',
  quoteFullLabel = '引用全文',
}: TextSourcePreviewPanelProps) {
  const { freeformMode, relativeFilePath, textContent, textContentLoading } =
    useAnnotationWorkspace();

  const containerRef = useRef<HTMLDivElement>(null);
  const [selectionText, setSelectionText] = useState('');

  const captureSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) {
      setSelectionText('');
      return;
    }
    const container = containerRef.current;
    if (
      !container.contains(sel.anchorNode) ||
      !container.contains(sel.focusNode)
    ) {
      setSelectionText('');
      return;
    }
    const text = sel.toString().trim();
    setSelectionText(text);
  }, []);

  if (freeformMode) return null;

  return (
    <div className="text-source-preview">
      <div className="text-source-preview-header">
        <span className="text-source-preview-title">源文件</span>
        {relativeFilePath ? (
          <span className="text-source-preview-path" title={relativeFilePath}>
            {relativeFilePath}
          </span>
        ) : null}
      </div>

      <div className="text-source-preview-actions">
        {onQuoteSelection && (
          <VscodeButton
            secondary
            disabled={!selectionText}
            onClick={() => {
              if (selectionText) onQuoteSelection(selectionText);
            }}
          >
            {quoteSelectionLabel}
          </VscodeButton>
        )}
        {onQuoteFull && textContent && (
          <VscodeButton secondary onClick={() => onQuoteFull(textContent)}>
            {quoteFullLabel}
          </VscodeButton>
        )}
      </div>

      <div
        className="text-source-preview-scroll"
        ref={containerRef}
        onMouseUp={captureSelection}
      >
        {textContentLoading ? (
          <p className="text-source-preview-muted">加载中…</p>
        ) : textContent ? (
          <pre className="text-source-preview-content">{textContent}</pre>
        ) : (
          <p className="text-source-preview-muted">
            请在资源管理器中选择文本文件以预览内容。
          </p>
        )}
      </div>
    </div>
  );
}
