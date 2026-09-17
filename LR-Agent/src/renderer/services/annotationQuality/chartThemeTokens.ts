import {
  themeBackgroundColor,
  type EffectiveTheme,
} from '../../theme/themeConstants';

export type ChartSemanticRole =
  'success' | 'warning' | 'danger' | 'muted' | 'info';

export interface ChartThemeTokens {
  palette: string[];
  semantic: Record<ChartSemanticRole, string>;
  text: { primary: string; secondary: string };
  axis: { line: string; splitLine: string };
  tooltip: { bg: string; border: string; shadow: string };
  radar: { areaOpacity: number; splitArea: [string, string] };
  emphasis: { shadowColor: string };
  pie: { labelLine: string };
  exportBackground: string;
}

const DARK_PALETTE = [
  '#5299e0',
  '#6cc76c',
  '#e0a050',
  '#e06c75',
  '#c678dd',
  '#56b6c2',
  '#e5c07b',
  '#98c379',
  '#61afef',
  '#be5046',
];

const LIGHT_PALETTE = [
  '#4A9EE8',
  '#52C452',
  '#F0A050',
  '#F06060',
  '#C080E0',
  '#40C8B0',
  '#E8C040',
  '#90D890',
  '#70C8FF',
  '#F09090',
];

const STRUCTURAL_FALLBACKS: Record<
  EffectiveTheme,
  Omit<ChartThemeTokens, 'palette' | 'exportBackground'>
> = {
  dark: {
    semantic: {
      success: '#6cc76c',
      warning: '#cca700',
      danger: '#f48771',
      muted: '#666666',
      info: '#5299e0',
    },
    text: { primary: '#cccccc', secondary: '#9d9d9d' },
    axis: { line: '#555555', splitLine: '#3e3e42' },
    tooltip: {
      bg: 'rgba(30, 30, 30, 0.94)',
      border: '#454545',
      shadow: '0 8px 24px rgba(0,0,0,0.35)',
    },
    radar: {
      areaOpacity: 0.12,
      splitArea: ['#2d2d30', '#252526'],
    },
    emphasis: { shadowColor: 'rgba(0,0,0,0.25)' },
    pie: { labelLine: '#888888' },
  },
  light: {
    semantic: {
      success: '#52C452',
      warning: '#D4A017',
      danger: '#E03030',
      muted: '#B8B8B8',
      info: '#4A9EE8',
    },
    text: { primary: '#333333', secondary: '#717171' },
    axis: { line: '#cccccc', splitLine: '#eeeeee' },
    tooltip: {
      bg: 'rgba(255, 255, 255, 0.94)',
      border: '#c8c8c8',
      shadow: '0 8px 24px rgba(0,0,0,0.12)',
    },
    radar: {
      areaOpacity: 0.12,
      splitArea: ['#fafafa', '#ffffff'],
    },
    emphasis: { shadowColor: 'rgba(0,0,0,0.12)' },
    pie: { labelLine: '#aaaaaa' },
  },
};

/** Chart tokens are tuned per theme; use fallbacks only to avoid CSS/DOM desync. */
export function getChartThemeTokens(theme: EffectiveTheme): ChartThemeTokens {
  const fallbacks = STRUCTURAL_FALLBACKS[theme];
  const palette = theme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;

  return {
    palette,
    exportBackground: themeBackgroundColor(theme),
    ...fallbacks,
    semantic: {
      ...fallbacks.semantic,
      info: palette[0],
    },
  };
}

export function resolveSemanticColor(
  tokens: ChartThemeTokens,
  role: ChartSemanticRole,
): string {
  return tokens.semantic[role];
}
