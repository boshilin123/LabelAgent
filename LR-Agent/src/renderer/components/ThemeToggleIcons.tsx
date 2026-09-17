interface ThemeIconProps {
  className?: string;
}

/** Codicons 0.0.45 不含 sun/moon，用 SVG 保持与原方案一致的视觉 */
export function SunIcon({ className }: ThemeIconProps) {
  return (
    <svg
      className={className}
      width={22}
      height={22}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <circle cx="8" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoonIcon({ className }: ThemeIconProps) {
  return (
    <svg
      className={className}
      width={22}
      height={22}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path d="M10.74 2.1a5.5 5.5 0 1 0 1.16 9.98A4.5 4.5 0 0 1 10.74 2.1z" />
    </svg>
  );
}
