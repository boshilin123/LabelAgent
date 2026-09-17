import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createMarkdownCodeComponents } from '../markdown/markdownCodeComponents';
import { resolveReportImageAbsolutePath } from '../../services/annotationQuality/reportImageResolver';
import '../agent/AgentMarkdown.css';
import './ReportPreviewPanel.css';

interface ReportPreviewPanelProps {
  markdown: string;
  /** 报告 run 根目录（含 report.md 与 charts/），非 charts 子目录 */
  reportRootPath?: string | null;
}

export default function ReportPreviewPanel({
  markdown,
  reportRootPath,
}: ReportPreviewPanelProps) {
  const components = useMemo(
    () =>
      createMarkdownCodeComponents({
        overlayHorizontalScroll: true,
        imageBaseDir: reportRootPath,
        imageClassName: 'quality-report-preview__img',
        resolveImagePath: resolveReportImageAbsolutePath,
      }),
    [reportRootPath],
  );

  if (!markdown.trim()) {
    return null;
  }

  return (
    <div className="quality-report-preview agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
