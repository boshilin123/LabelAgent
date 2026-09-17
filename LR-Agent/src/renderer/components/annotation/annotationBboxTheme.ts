/** Shared constants for bbox rendering (Fabric canvas + legacy SVG layer). */
export const BBOX_THEME = {
  defaultLabelColor: '#1976d2',
  unknownLabelColor: '#607D8B',
  defaultStroke: '#4fc3f7',
  focusStroke: 'var(--vscode-focusBorder, #007fd4)',

  strokeWidthPx: 2,
  /** @deprecated SVG suffix; prefer hexToRgba + fillAlpha for Fabric */
  strokeUnselectedPx: 2,
  strokeSelectedPx: 2,
  fillAlpha: 0.1,
  /** ~10% alpha hex suffix for legacy SVG `${color}${fillAlpha}` */
  fillAlphaHex: '1a',
  fillAlphaSelected: '1a',

  draftStrokeWidthPx: 2,

  labelTextOffsetX: 4,
  labelTextOffsetY: 2,
  labelFontSizePx: 14,
  labelFontWeight: '600' as const,
  labelTextFill: '#ffffff',
  labelTextStroke: 'rgba(0,0,0,0.45)',
  labelTextStrokeWidth: 0.4,
  labelFontFamily: 'Inter, "Noto Sans SC", sans-serif' as const,
  labelEmptyText: '—',

  /** Legacy SVG label chip */
  labelBarHeightPx: 18,
  labelCharWidthPx: 7,
  labelPaddingPx: 12,
  labelMinWidthPx: 48,
  handleSizePx: 8,
  haloStrokePx: 4,
} as const;

export function pxToNormX(px: number, displayWidthPx: number): number {
  if (displayWidthPx <= 0) return 0;
  return px / displayWidthPx;
}
