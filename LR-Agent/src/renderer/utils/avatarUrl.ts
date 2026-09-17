const AVATAR_SIZE_PATTERN = /_(\d+)\.webp$/;

/** Prefer the largest stored variant for sharp display on HiDPI screens. */
export function getAvatarDisplayUrl(url: string): string {
  const match = url.match(AVATAR_SIZE_PATTERN);
  if (!match) return url;
  const current = Number(match[1]);
  if (current >= 512) return url;
  return url.replace(AVATAR_SIZE_PATTERN, '_512.webp');
}

export function getAvatarSrcSet(url: string): string | undefined {
  const match = url.match(AVATAR_SIZE_PATTERN);
  if (!match) return undefined;
  const base = url.replace(AVATAR_SIZE_PATTERN, '');
  const maxSize = Number(match[1]);
  const sizes = [128, 256, 512].filter((size) => size <= maxSize);
  if (sizes.length <= 1) return undefined;
  return sizes.map((size) => `${base}_${size}.webp ${size}w`).join(', ');
}
