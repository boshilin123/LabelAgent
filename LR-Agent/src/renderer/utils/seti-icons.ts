import { themeIcons } from 'seti-icons';
import { basename } from '../types/file';

/** Seti 冷色调配色 */
const SETI_COLD_THEME: Record<string, string> = {
  blue: '#4a9ec4',
  grey: '#6d8a9a',
  'grey-light': '#8aa8b8',
  green: '#4db6ac',
  orange: '#6a9eb8',
  pink: '#90a4c4',
  purple: '#7986cb',
  red: '#c46a6a',
  white: '#b0bec5',
  yellow: '#81d4fa',
  ignore: '#546e7a',
};

const FOLDER_BLUE = SETI_COLD_THEME.blue;

const getThemedIcon = themeIcons(SETI_COLD_THEME);

/** 扩展名统一小写，保证 .MD / .TSX 等能命中 Seti 映射 */
function normalizeFileNameForSeti(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return fileName;
  return fileName.slice(0, dot) + fileName.slice(dot).toLowerCase();
}

function resolveThemeColor(color: string): string {
  if (color.startsWith('#')) return color;
  return SETI_COLD_THEME[color] ?? SETI_COLD_THEME.white;
}

/** Seti 默认文件图标使用 1200×1000 画布，需裁剪才能在 16px 槽位内正常显示 */
const SETI_WIDE_ICON_VIEWBOX = 'viewBox="0 0 1200 1000"';
const SETI_WIDE_ICON_CROP = 'viewBox="394 268 416 424"';

function normalizeSetiSvg(svg: string): string {
  let normalized = svg.trim();
  if (!normalized.includes('xmlns=')) {
    normalized = normalized.replace(
      '<svg',
      '<svg xmlns="http://www.w3.org/2000/svg"',
    );
  }
  if (normalized.includes(SETI_WIDE_ICON_VIEWBOX)) {
    normalized = normalized.replace(
      SETI_WIDE_ICON_VIEWBOX,
      SETI_WIDE_ICON_CROP,
    );
  }
  if (!/preserveAspectRatio=/.test(normalized)) {
    normalized = normalized.replace(
      '<svg',
      '<svg preserveAspectRatio="xMidYMid meet"',
    );
  }
  return normalized.replace(/<svg([^>]*)>/, (match, attrs: string) => {
    const cleaned = attrs
      .replace(/\s(width|height)="[^"]*"/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned ? `<svg ${cleaned}>` : '<svg>';
  });
}

function applyColorToSvg(svg: string, color: string): string {
  const fill = resolveThemeColor(color);
  const colored = svg.replace(/<path\b([^>]*)>/g, (match, attrs: string) => {
    if (/\bfill=/.test(attrs)) {
      return match.replace(/\bfill="[^"]*"/, `fill="${fill}"`);
    }
    return `<path fill="${fill}"${attrs}>`;
  });
  return normalizeSetiSvg(colored);
}

const FOLDER_SVG = {
  folder: normalizeSetiSvg(
    `<svg viewBox="0 0 32 32"><path fill="${FOLDER_BLUE}" d="M27 8H14.5L12 5H5a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h22a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2z"/></svg>`,
  ),
  'folder-open': normalizeSetiSvg(
    `<svg viewBox="0 0 32 32"><path fill="${FOLDER_BLUE}" d="M27 8H14.5L12 5H5a2 2 0 0 0-2 2v3h24v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10h24V8z"/><path fill="${SETI_COLD_THEME['grey-light']}" d="M3 13h26v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V13z"/></svg>`,
  ),
};

/** Seti `default` 图标（1200×1000）在目录树中视觉偏大；改用 32×32 通用文件轮廓（与 mdo 等语言图标同画布） */
const SETI_DEFAULT_ICON_SVG = getThemedIcon('default.txt').svg ?? '';
const GENERIC_FILE_SVG = normalizeSetiSvg(
  `<svg viewBox="0 0 32 32"><path d="M22.9 9.1H9.4L6 16s3.4 6.8 3.4 6.9h13.5c1.7 0 3.1-1.4 3.1-3.1v-7.7c0-1.6-1.3-3-3.1-3zm1.6 10.8c0 .9-.7 1.5-1.5 1.5H10.6s-3.1-4.9-3.1-5.2l3.1-5.5H23c.9 0 1.5.7 1.5 1.5v7.7z"/><path d="M10.8 18.2h12.2v1h-12.2zm0 2.8h12.2v1h-12.2zm0 2.8h8v1h-8z"/></svg>`,
);

function isSetiDefaultIcon(svg: string | undefined): boolean {
  return Boolean(svg && svg === SETI_DEFAULT_ICON_SVG);
}

function lookupFileIcon(fileName: string) {
  const normalized = normalizeFileNameForSeti(fileName);
  const candidates =
    normalized === fileName ? [fileName] : [fileName, normalized];

  const matched = candidates
    .map((name) => getThemedIcon(name))
    .find((result) => Boolean(result.svg));

  const result = matched ?? getThemedIcon('default.txt');
  if (isSetiDefaultIcon(result.svg)) {
    return { svg: GENERIC_FILE_SVG, color: result.color };
  }
  return result;
}

export function getSetiFileIconSvg(filePath: string): string {
  const fileName = basename(filePath);
  const { svg, color } = lookupFileIcon(fileName);
  if (!svg) return FOLDER_SVG.folder;
  return applyColorToSvg(svg, color);
}

export function getSetiFolderIconSvg(isOpen: boolean): string {
  return isOpen ? FOLDER_SVG['folder-open'] : FOLDER_SVG.folder;
}
