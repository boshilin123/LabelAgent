import { describe, expect, it, beforeEach } from '@jest/globals';
import { realTextOffsetInContainer } from './textSpanOffsets';

/** 模拟渲染高亮后的 DOM：原文 + 已标注 span（内含标签名文本） */
function buildContainer(): HTMLDivElement {
  const container = document.createElement('div');
  // 单行 innerHTML，避免元素之间的换行/缩进被解析为空白文本节点
  container.innerHTML =
    '<span>钱学森是著名科学家，</span>' +
    '<span class="text-span-ner-highlight">钱学森<span class="text-span-ner-label-tag">人名</span></span>' +
    '<span>任教于加州理工。</span>';
  return container;
}

function textNodes(el: Element): Text[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

describe('realTextOffsetInContainer', () => {
  let container: HTMLDivElement;
  let nodes: Text[];

  beforeEach(() => {
    container = buildContainer();
    nodes = textNodes(container);
  });

  it('returns offset for a point inside leading plain text', () => {
    // "钱学森" 在原文起始处
    expect(realTextOffsetInContainer(container, nodes[0], 3)).toBe(3);
  });

  it('returns offset inside highlighted original text ignoring preceding label tag text', () => {
    // 第二个 "钱学森" 的起点：前文 10 字 + 0
    expect(realTextOffsetInContainer(container, nodes[1], 0)).toBe(10);
    // 高亮原文第 2 个字符处
    expect(realTextOffsetInContainer(container, nodes[1], 2)).toBe(12);
  });

  it('skips label tag text when the point is after a highlighted span', () => {
    // "任教于加州理工。" 起始真实位置 = 10 + 3 = 13（"人名" 2 字不计入）
    expect(realTextOffsetInContainer(container, nodes[3], 0)).toBe(13);
    // 其第 3 个字符处 = 16
    expect(realTextOffsetInContainer(container, nodes[3], 3)).toBe(16);
  });

  it('anchors inside label tag text resolve to its start (span end)', () => {
    // label tag 内任何位置都落在高亮 span 结束处
    expect(realTextOffsetInContainer(container, nodes[2], 0)).toBe(13);
    expect(realTextOffsetInContainer(container, nodes[2], 2)).toBe(13);
  });

  it('reports full real text length at end of container', () => {
    // 10 + 3 + 9 = 22
    expect(
      realTextOffsetInContainer(container, nodes[nodes.length - 1], 9),
    ).toBe(22);
  });
});
