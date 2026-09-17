import { useLayoutEffect, useRef, useState } from 'react';
import { createResizeObserver } from '../utils/resizeObserver';

/** 测量 flex 滚动宿主的可视高度，供 VscodeScrollable 使用固定像素高度 */
export function useScrollHostHeight() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;

    const update = () => {
      const next = Math.floor(el.getBoundingClientRect().height);
      setHeight((prev) => (prev === next ? prev : next));
    };

    update();
    const ro = createResizeObserver(update);
    if (!ro) return undefined;
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { hostRef, height };
}
