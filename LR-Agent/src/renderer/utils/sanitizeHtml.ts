/**
 * 渲染层 HTML 消毒工具。
 *
 * 所有 `dangerouslySetInnerHTML` 的输入都必须先经过这里，避免不可信内容
 * （docx 正文、markdown 代码高亮、远程 MCP 返回值等）直接进入 DOM 形成 XSS。
 *
 * 依赖 DOMPurify：默认即剥离 script / 事件属性 / 危险协议（javascript:、data: 等），
 * 这里再按用途收窄允许的标签与属性。
 */
import DOMPurify from 'dompurify';

/** docx 预览允许的标签（mammoth 常见输出 + 基础排版） */
const DOCX_ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'span',
  'div',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'small',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'a',
  'img',
];

/** docx 预览允许的属性（不含任何事件属性与 style） */
const DOCX_ALLOWED_ATTR = [
  'class',
  'href',
  'src',
  'alt',
  'title',
  'colspan',
  'rowspan',
  'id',
  'align',
  'valign',
  'width',
  'height',
];

/**
 * 消毒 docx 预览 HTML。
 * 显式禁止 style 标签/属性与嵌入类标签，避免 CSS 注入与外部资源加载。
 */
export function sanitizeDocxHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: DOCX_ALLOWED_TAGS,
    ALLOWED_ATTR: DOCX_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'style',
      'script',
      'iframe',
      'frame',
      'frameset',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'select',
      'textarea',
      'link',
      'meta',
      'base',
      'svg',
      'math',
    ],
    FORBID_ATTR: ['style'],
  });
}

/**
 * 消毒代码高亮 HTML。
 * highlight.js 正常只输出 `<span class="hljs-*">`，因此收窄到 span + class 即可。
 */
export function sanitizeHighlightHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['span'],
    ALLOWED_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * 判断 URL 是否可交给系统浏览器打开。
 * 仅允许 https（文档内链接）；其余协议（javascript:、data:、file:、smb: 等）一律拒绝。
 */
export function isSafeExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
