/**
 * 工作区文件策略。
 *
 * - 预览路由使用「二进制/富媒体黑名单」（只有明确的非文本类型才走特殊预览）。
 * - 写盘与 Monaco 编辑使用「文本扩展名白名单」：默认不可写，仅白名单内的
 *   纯文本/代码类型允许写盘，从根上阻断“写入脚本/可执行文件再触发执行”。
 *
 * 需与 LR-Agent-backend/app/agent/tools/workspace_text_extensions.py 保持同步。
 */

function fileBaseName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath;
}

function fileExtension(filePath: string): string {
  const name = fileBaseName(filePath);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  if (dot === 0) {
    return name.slice(1).toLowerCase();
  }
  return name.slice(dot + 1).toLowerCase();
}

/** 明确的二进制/富媒体类型：不参与文本预览与编辑。 */
const BINARY_OR_RICH_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
  '.pdf',
  '.docx',
  '.doc',
  '.zip',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

/** FileViewer 专用特殊预览扩展名（明确的二进制/富媒体）。 */
export const SPECIAL_PREVIEW_EXTENSIONS = BINARY_OR_RICH_EXTENSIONS;

/**
 * 允许写盘/编辑的文本与代码扩展名白名单（不含点，全小写）。
 * 刻意排除 .bat/.cmd/.ps1/.psm1/.vbs/.wsf/.hta/.scr/.com/.msi/.jar/.reg/.lnk
 * 等可执行/脚本类型。
 */
const TEXT_WRITE_WHITELIST = new Set([
  // 文档
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'log',
  'rst',
  'adoc',
  'csv',
  'tsv',
  // 数据 / 配置
  'json',
  'jsonl',
  'ndjson',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'config',
  'properties',
  'env',
  'gitignore',
  'gitattributes',
  'dockerignore',
  'editorconfig',
  'npmrc',
  'nvmrc',
  'lock',
  // 代码
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'py',
  'pyw',
  'pyi',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'hxx',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'm',
  'mm',
  'lua',
  'r',
  'pl',
  'pm',
  'scala',
  'dart',
  'groovy',
  'gradle',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'html',
  'htm',
  'xml',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  'astro',
  'graphql',
  'gql',
  'proto',
  'tf',
  'hcl',
  'dockerfile',
  'makefile',
  'cmake',
  'mk',
]);

function getDottedExtension(filePath: string): string {
  const ext = fileExtension(filePath);
  if (!ext) return '';
  return `.${ext.toLowerCase()}`;
}

/**
 * 扩展名是否允许写盘/编辑。
 * 无扩展名的文件（LICENSE、Makefile 等）视为文本放行。
 */
export function isAllowedTextWriteExtension(ext: string): boolean {
  const normalized = ext.replace(/^\./, '').toLowerCase();
  if (!normalized) return true;
  return TEXT_WRITE_WHITELIST.has(normalized);
}

/** 是否禁止写盘/编辑（白名单之外一律禁止）。 */
export function isBlockedTextExtension(ext: string): boolean {
  return !isAllowedTextWriteExtension(ext);
}

export function isSpecialPreviewFile(filePath: string): boolean {
  const dotted = getDottedExtension(filePath);
  if (!dotted) return false;
  return SPECIAL_PREVIEW_EXTENSIONS.has(dotted);
}

/** 仅白名单内的文本/代码文件可写、可 Monaco 编辑。 */
export function isTextEditableFile(filePath: string): boolean {
  return isAllowedTextWriteExtension(fileExtension(filePath));
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

export function isMarkdownExtension(ext: string): boolean {
  return MARKDOWN_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ''));
}

export function isMarkdownFile(filePath: string): boolean {
  return isMarkdownExtension(fileExtension(filePath));
}

/** 图片扩展名（不含点），供 FileViewer 路由。 */
export const IMAGE_PREVIEW_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

export function isImagePreviewFile(filePath: string): boolean {
  return IMAGE_PREVIEW_EXTENSIONS.has(fileExtension(filePath));
}

export function isPdfPreviewFile(filePath: string): boolean {
  return fileExtension(filePath) === 'pdf';
}

export function isDocxPreviewFile(filePath: string): boolean {
  const ext = fileExtension(filePath);
  return ext === 'docx' || ext === 'doc';
}
