import darkHljsHref from 'highlight.js/styles/vs2015.min.css';
import lightHljsHref from 'highlight.js/styles/github.min.css';
import type { EffectiveTheme } from './themeConstants';

const HLJS_LINK_ID = 'hljs-theme-stylesheet';

const HLJS_THEME_HREF: Record<EffectiveTheme, string> = {
  dark: typeof darkHljsHref === 'string' ? darkHljsHref : '',
  light: typeof lightHljsHref === 'string' ? lightHljsHref : '',
};

let activeTheme: EffectiveTheme | null = null;

export function applyHighlightTheme(theme: EffectiveTheme): void {
  if (activeTheme === theme) return;
  activeTheme = theme;

  let link = document.getElementById(HLJS_LINK_ID) as HTMLLinkElement | null;

  if (!link) {
    link = document.createElement('link');
    link.id = HLJS_LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }

  const href = HLJS_THEME_HREF[theme];
  if (!href) return;
  link.href = href;
}
