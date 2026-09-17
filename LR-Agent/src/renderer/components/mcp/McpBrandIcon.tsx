import { VscodeIcon } from '@vscode-elements/react-elements';

const ICONS: Record<string, { bg: string; fg: string; label: string }> = {
  tavily: { bg: '#0d9488', fg: '#fff', label: 'Tv' },
  context7: { bg: '#6366f1', fg: '#fff', label: 'C7' },
  github: { bg: '#24292f', fg: '#fff', label: 'GH' },
  huggingface: { bg: '#ffd21e', fg: '#1a1a1a', label: 'HF' },
};

interface McpBrandIconProps {
  presetId?: string | null;
  size?: number;
}

export default function McpBrandIcon({
  presetId,
  size = 20,
}: McpBrandIconProps) {
  const brand = presetId ? ICONS[presetId] : undefined;
  if (!brand) {
    return (
      <span
        className="mcp-brand-icon mcp-brand-icon--generic"
        style={{ width: size, height: size }}
      >
        <VscodeIcon name="plug" size={Math.max(12, size - 6)} />
      </span>
    );
  }
  return (
    <span
      className="mcp-brand-icon"
      style={{
        width: size,
        height: size,
        background: brand.bg,
        color: brand.fg,
        fontSize: Math.max(8, size * 0.42),
      }}
      aria-hidden
    >
      {brand.label}
    </span>
  );
}
