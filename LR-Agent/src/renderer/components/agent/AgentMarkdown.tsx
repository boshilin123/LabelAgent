import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { createMarkdownCodeComponents } from '../markdown/markdownCodeComponents';
import './AgentMarkdown.css';

interface AgentMarkdownProps {
  content: string;
}

export default function AgentMarkdown({ content }: AgentMarkdownProps) {
  const components = useMemo(
    () => createMarkdownCodeComponents({ overlayHorizontalScroll: true }),
    [],
  );

  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
