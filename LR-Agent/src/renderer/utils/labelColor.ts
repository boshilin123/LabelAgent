import type { CSSProperties } from 'react';

function parseHexColor(
  hex: string,
): { r: number; g: number; b: number } | null {
  const normalized = hex.trim().replace(/^#/, '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export function hexToRgba(hex: string, alpha: number): string {
  const rgb = parseHexColor(hex);
  if (!rgb) return `rgba(79, 195, 247, ${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

export function getLabelTextColor(
  backgroundColor: string,
): '#ffffff' | '#000000' {
  const rgb = parseHexColor(backgroundColor);
  if (!rgb) return '#ffffff';

  return relativeLuminance(rgb.r, rgb.g, rgb.b) > 0.5 ? '#000000' : '#ffffff';
}

export function getLabelChipStyle(color: string): CSSProperties {
  return {
    backgroundColor: color,
    color: getLabelTextColor(color),
  };
}
