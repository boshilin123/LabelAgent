import { useEffect, useState } from 'react';
import {
  isRemoteMarkdownImageSrc,
  loadMarkdownImageBlobUrl,
  resolveMarkdownImageAbsolutePath,
} from '../../utils/markdownImageResolver';

interface MarkdownLocalImageProps {
  src?: string;
  alt?: string;
  baseDir?: string | null;
  className?: string;
  resolveAbsolutePath?: (baseDir: string, src: string) => string | null;
}

export default function MarkdownLocalImage({
  src,
  alt,
  baseDir,
  className,
  resolveAbsolutePath = resolveMarkdownImageAbsolutePath,
}: MarkdownLocalImageProps) {
  const [displaySrc, setDisplaySrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src) {
      setDisplaySrc(null);
      setFailed(false);
      return undefined;
    }

    if (isRemoteMarkdownImageSrc(src)) {
      setDisplaySrc(src);
      setFailed(false);
      return undefined;
    }

    if (!baseDir) {
      setDisplaySrc(null);
      setFailed(false);
      return undefined;
    }

    const absolutePath = resolveAbsolutePath(baseDir, src);
    if (!absolutePath) {
      setFailed(true);
      setDisplaySrc(null);
      return undefined;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    setFailed(false);
    setDisplaySrc(null);

    loadMarkdownImageBlobUrl(absolutePath)
      .then((url) => {
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (!url) {
          setFailed(true);
          return;
        }
        objectUrl = url;
        setDisplaySrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, baseDir, resolveAbsolutePath]);

  if (!src) return null;

  if (displaySrc) {
    return <img src={displaySrc} alt={alt ?? ''} className={className} />;
  }

  if (failed) {
    return (
      <span className="markdown-local-image__failed" title={src}>
        图片加载失败：{alt ?? src}
      </span>
    );
  }

  return <span className="markdown-local-image__loading">加载图片…</span>;
}
