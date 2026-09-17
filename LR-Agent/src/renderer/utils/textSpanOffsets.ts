/**
 * 文本 span 编辑器：真实文本 offset 计算工具。
 * 渲染高亮 span 时会在 DOM 中嵌入标签名文本（.text-span-ner-label-tag），
 * 这些文本不属于原始文本，计算 offset 时必须跳过，否则后续手动标注会错位。
 */

export const LABEL_TAG_CLASS = 'text-span-ner-label-tag';

function isLabelTagNode(node: Node): boolean {
  return node.parentElement?.classList.contains(LABEL_TAG_CLASS) === true;
}

/**
 * 计算容器内从起始到 (node, offsetInNode) 处的真实文本长度。
 * - 遍历容器内全部文本节点，跳过 label tag 节点内的文本；
 * - 选区锚点落在标签文本内时（user-select:none 理论上避免），
 *   以标签起始位置（即对应 span 的结束位置）计算。
 */
export function realTextOffsetInContainer(
  container: Element,
  node: Node,
  offsetInNode: number,
): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let len = 0;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current === node) {
      return isLabelTagNode(current) ? len : len + offsetInNode;
    }
    if (!isLabelTagNode(current)) {
      len += current.textContent?.length ?? 0;
    }
  }
  return len;
}
