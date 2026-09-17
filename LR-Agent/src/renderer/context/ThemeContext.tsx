import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { applyHighlightTheme } from '../theme/highlightTheme';
import {
  readStoredPreference,
  resolveEffectiveTheme,
  THEME_STORAGE_KEY,
  THEME_TRANSITION_MS,
  themeBackgroundColor,
  getMatchMediaDark,
  type ColorThemePreference,
  type EffectiveTheme,
} from '../theme/themeConstants';

interface ThemeContextValue {
  preference: ColorThemePreference;
  effectiveTheme: EffectiveTheme;
  toggleDarkLight: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

async function readSystemIsDark(): Promise<boolean> {
  try {
    const fromElectron = await window.electron?.theme?.getSystemDark?.();
    if (typeof fromElectron === 'boolean') {
      return fromElectron;
    }
  } catch {
    // fall through to matchMedia
  }
  return getMatchMediaDark();
}

function applyThemeToDom(
  theme: EffectiveTheme,
  options?: { animate?: boolean },
): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.backgroundColor = themeBackgroundColor(theme);

  applyHighlightTheme(theme);

  if (options?.animate) {
    root.classList.add('theme-transition');
    window.setTimeout(() => {
      root.classList.remove('theme-transition');
    }, THEME_TRANSITION_MS);
  }

  window.electron?.theme?.notifyEffectiveTheme?.(theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ColorThemePreference>(() =>
    readStoredPreference(),
  );
  const [systemIsDark, setSystemIsDark] = useState<boolean>(() =>
    getMatchMediaDark(),
  );
  const isFirstApply = useRef(true);

  const effectiveTheme = useMemo(
    () => resolveEffectiveTheme(preference, systemIsDark),
    [preference, systemIsDark],
  );

  useEffect(() => {
    let cancelled = false;

    readSystemIsDark().then((isDark) => {
      if (!cancelled) {
        setSystemIsDark(isDark);
      }
    });

    const unsubElectron = window.electron?.theme?.onSystemChanged?.(
      (isDark) => {
        setSystemIsDark(isDark);
      },
    );

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMediaChange = (event: MediaQueryListEvent) => {
      setSystemIsDark(event.matches);
    };
    media.addEventListener('change', onMediaChange);

    return () => {
      cancelled = true;
      unsubElectron?.();
      media.removeEventListener('change', onMediaChange);
    };
  }, []);

  useLayoutEffect(() => {
    const animate = !isFirstApply.current;
    isFirstApply.current = false;
    applyThemeToDom(effectiveTheme, { animate });
  }, [effectiveTheme]);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  }, [preference]);

  const toggleDarkLight = useCallback(() => {
    setPreference((prev) => {
      const current = resolveEffectiveTheme(prev, systemIsDark);
      return current === 'dark' ? 'light' : 'dark';
    });
  }, [systemIsDark]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      effectiveTheme,
      toggleDarkLight,
    }),
    [preference, effectiveTheme, toggleDarkLight],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
