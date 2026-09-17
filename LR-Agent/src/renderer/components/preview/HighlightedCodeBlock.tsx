import { useMemo } from 'react';
import { highlightCode } from '../../utils/syntaxHighlight';
import { sanitizeHighlightHtml } from '../../utils/sanitizeHtml';
import './HighlightedCodeBlock.css';

interface HighlightedCodeBlockProps {
  content: string;
  filePath: string;
}

export default function HighlightedCodeBlock({
  content,
  filePath,
}: HighlightedCodeBlockProps) {
  const html = useMemo(
    () => sanitizeHighlightHtml(highlightCode(content, filePath)),
    [content, filePath],
  );

  return (
    <pre className="hljs code-block highlighted-code-block">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
