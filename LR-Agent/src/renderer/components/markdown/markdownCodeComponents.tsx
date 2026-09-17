import type { ReactNode } from 'react';
import type { Components } from 'react-markdown';
import AgentScrollablePre from '../agent/AgentScrollablePre';
import { highlightMarkdownCode } from '../../utils/syntaxHighlight';
import {
  isSafeExternalUrl,
  sanitizeHighlightHtml,
} from '../../utils/sanitizeHtml';
import MarkdownLocalImage from './MarkdownLocalImage';

export interface MarkdownCodeComponentsOptions {
  overlayHorizontalScroll?: boolean;
  /** Markdown 文件所在目录，用于解析相对路径图片 */
  imageBaseDir?: string | null;
  imageClassName?: string;
  resolveImagePath?: (baseDir: string, src: string) => string | null;
}

function extractLanguage(className?: string): string | null {
  const match = /language-([\w-]+)/.exec(className ?? '');
  return match?.[1] ?? null;
}

function normalizeCodeContent(children: ReactNode): string {
  return String(children).replace(/\n$/, '');
}

export function createMarkdownCodeComponents(
  options: MarkdownCodeComponentsOptions = {},
): Components {
  const {
    overlayHorizontalScroll = false,
    imageBaseDir,
    imageClassName,
    resolveImagePath,
  } = options;

  const components: Components = {
    a({ href, children, ...props }) {
      return (
        <a
          href={href}
          {...props}
          rel="noopener noreferrer"
          onClick={(e) => {
            if (!href || href.startsWith('#')) return;
            e.preventDefault();
            // 仅 https 绝对链接交给系统浏览器；相对链接与其他协议（javascript:、
            // data:、file: 等）一律阻断，避免当前窗口被替换或脚本执行。
            if (isSafeExternalUrl(href)) {
              window.electron.window.openExternal(href).catch(() => undefined);
            }
          }}
        >
          {children}
        </a>
      );
    },
    pre({ children, ...props }) {
      if (overlayHorizontalScroll) {
        return <AgentScrollablePre {...props}>{children}</AgentScrollablePre>;
      }
      return <pre {...props}>{children}</pre>;
    },
    code({ className, children, ...props }) {
      const language = extractLanguage(className);
      const content = normalizeCodeContent(children);
      const isBlock = language != null || content.includes('\n');

      if (isBlock) {
        const html = sanitizeHighlightHtml(
          highlightMarkdownCode(content, language),
        );
        const hljsClassName = language ? `hljs language-${language}` : 'hljs';
        return (
          <code
            className={[hljsClassName, className].filter(Boolean).join(' ')}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }

      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };

  if (imageBaseDir !== undefined) {
    components.img = ({ src, alt }) => (
      <MarkdownLocalImage
        src={src}
        alt={alt}
        baseDir={imageBaseDir}
        className={imageClassName}
        resolveAbsolutePath={resolveImagePath}
      />
    );
  }

  return components;
}
