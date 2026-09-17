import fs from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';

/**
 * 滚动宿主契约守卫。
 *
 * OverlayVerticalScrollArea 的内层 __content 才是滚动元素：只有拿到确定高度
 * （fillHost 的 height:100%，或 maxHeight 的显式上限）才会出现 overflow，
 * 否则内容撑破容器被 overflow:hidden 裁掉 —— 表现为「列表滚不动」，
 * 且依赖 onScroll 的加载更多也永不触发（2026-09-14 修过一次这类 bug：
 * AgentHistoryPopover 与 QuickInferencePanel）。
 *
 * 这里做静态扫描，要求每个用法显式给出高度来源，避免以后再漏。
 */

// 本文件位于 src/renderer/components，上一级即渲染层根目录
const RENDERER_ROOT = path.resolve(__dirname, '..');
const COMPONENT = '<OverlayVerticalScrollArea';

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsxFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** 取 JSX 起始标签文本：从 `<OverlayVerticalScrollArea` 到同层级的 `>`（忽略字符串与花括号内的 `>`）。 */
function readOpeningTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ')') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

function collectUsages(): { file: string; tag: string }[] {
  const usages: { file: string; tag: string }[] = [];
  for (const file of listTsxFiles(RENDERER_ROOT)) {
    const source = fs.readFileSync(file, 'utf-8');
    let index = source.indexOf(COMPONENT);
    while (index >= 0) {
      usages.push({
        file: path.relative(RENDERER_ROOT, file),
        tag: readOpeningTag(source, index),
      });
      index = source.indexOf(COMPONENT, index + COMPONENT.length);
    }
  }
  return usages;
}

describe('OverlayVerticalScrollArea 用法契约', () => {
  it('每个用法都显式给出高度来源（fillHost 或 maxHeight）', () => {
    const usages = collectUsages();
    // 守卫自身有效性：扫描不到任何用法说明路径或匹配逻辑坏了
    expect(usages.length).toBeGreaterThan(4);

    const missing = usages
      .filter(
        ({ tag }) => !/\bfillHost\b/.test(tag) && !/\bmaxHeight=/.test(tag),
      )
      .map(({ file, tag }) => `${file}: ${tag.split('\n')[0]}`);

    expect(missing).toEqual([]);
  });

  it('fillHost 用法的宿主类名必须自带 flex:1 / min-height:0 之外的约束来源', () => {
    // fillHost 时 className 落在宿主 div 上，宿主必须是 flex 布局里的受限子项；
    // 这里只做弱校验：fillHost 用法必须传 className，强迫调用方显式声明宿主样式。
    const missingClass = collectUsages()
      .filter(
        ({ tag }) => /\bfillHost\b/.test(tag) && !/\bclassName=/.test(tag),
      )
      .map(({ file }) => file);
    expect(missingClass).toEqual([]);
  });
});
