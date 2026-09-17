import { dirname } from '../types/file';

/** vscode-tree 的 vsc-tree-select：detail 可能是数组或 { selectedItems } */
export type VscTreeSelectEvent = CustomEvent<
  Element[] | { selectedItems?: Element[] }
>;

export function getPathFromTreeItem(item: Element): string | null {
  const pathEl = item.querySelector('[data-file-path]');
  return pathEl?.getAttribute('data-file-path') ?? null;
}

export function getSelectedTreeItem(
  event: VscTreeSelectEvent,
): Element | undefined {
  const selectedItems = Array.isArray(event.detail)
    ? event.detail
    : event.detail?.selectedItems;
  return selectedItems?.[0];
}

export function isTreeItemBranch(item: Element): boolean {
  const el = item as HTMLElement & { branch?: boolean };
  if (typeof el.branch === 'boolean') return el.branch;
  return item.hasAttribute('branch');
}

type TreeItemElement = HTMLElement & {
  selected?: boolean;
  highlightedGuides?: boolean;
  open?: boolean;
  branch?: boolean;
};

/** 当前路径的所有祖先（不含 rootPath）是否均已展开 */
export function areAncestorsExpanded(
  path: string,
  rootPath: string,
  expandedPaths: Set<string>,
): boolean {
  if (path === rootPath) return true;
  let current = dirname(path);
  while (current !== rootPath && current !== path) {
    if (!expandedPaths.has(current)) return false;
    path = current;
    current = dirname(current);
  }
  return true;
}

/** 将 WC 内部 open 与 React expandedPaths 对齐 */
export function syncTreeOpenState(
  tree: Element,
  expandedPaths: Set<string>,
  rootPath: string,
): void {
  tree.querySelectorAll('vscode-tree-item').forEach((el) => {
    const item = el as TreeItemElement;
    if (!item.branch) return;
    const path = getPathFromTreeItem(el);
    if (path) {
      item.open =
        expandedPaths.has(path) &&
        areAncestorsExpanded(path, rootPath, expandedPaths);
    }
  });
}

export function getTreeFromItem(item: Element): Element | null {
  return item.closest('vscode-tree');
}

export function clearTreeSelections(tree: Element): void {
  tree.querySelectorAll('vscode-tree-item').forEach((el) => {
    (el as TreeItemElement).selected = false;
  });
}

export function syncActiveFileSelection(
  tree: Element,
  activeFilePath: string | null,
): void {
  clearTreeSelections(tree);
  if (!activeFilePath) return;

  const escaped = activeFilePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const pathEl = tree.querySelector(`[data-file-path="${escaped}"]`);
  const item = pathEl?.closest('vscode-tree-item') as TreeItemElement | null;
  if (item) {
    item.selected = true;
  }
}

export function clearAncestorIndentGuides(item: Element): void {
  let parent = item.parentElement?.closest(
    'vscode-tree-item',
  ) as TreeItemElement | null;
  while (parent) {
    parent.highlightedGuides = false;
    parent = parent.parentElement?.closest(
      'vscode-tree-item',
    ) as TreeItemElement | null;
  }
}

export function handleTreeSelect(
  event: VscTreeSelectEvent,
  onToggleFolder: (path: string) => void,
  onSelectFile: (path: string) => void,
): void {
  const item = getSelectedTreeItem(event);
  if (!item) return;

  const path = getPathFromTreeItem(item);
  if (!path) return;

  if (isTreeItemBranch(item)) {
    onToggleFolder(path);
  } else {
    onSelectFile(path);
  }
}
