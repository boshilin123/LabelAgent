export const THEME_STORAGE_KEY = 'lr-agent:colorTheme';

export type ColorThemePreference = 'system' | 'dark' | 'light';
export type EffectiveTheme = 'dark' | 'light';

export const THEME_TRANSITION_MS = 360;

export function readStoredPreference(): ColorThemePreference {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === 'dark' || raw === 'light' || raw === 'system') {
    return raw;
  }
  return 'system';
}

export function resolveEffectiveTheme(
  preference: ColorThemePreference,
  systemIsDark: boolean,
): EffectiveTheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return systemIsDark ? 'dark' : 'light';
}

export function getMatchMediaDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function themeBackgroundColor(theme: EffectiveTheme): string {
  return theme === 'dark' ? '#1e1e1e' : '#ffffff';
}
