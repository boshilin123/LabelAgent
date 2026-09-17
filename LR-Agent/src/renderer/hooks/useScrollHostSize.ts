import { useLayoutEffect, useRef, useState } from 'react';
import { createResizeObserver } from '../utils/resizeObserver';

/** 测量 flex 滚动宿主的可视宽高，供 VscodeScrollable 等使用固定像素尺寸 */
export function useScrollHostSize() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const nextWidth = Math.floor(rect.width);
      const nextHeight = Math.floor(rect.height);
      setSize((prev) =>
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight },
      );
    };

    update();
    const ro = createResizeObserver(update);
    if (!ro) return undefined;
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { hostRef, width: size.width, height: size.height };
}
