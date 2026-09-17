import {
  VscodeProgressRing,
  VscodeTreeItem,
} from '@vscode-elements/react-elements';
import FileTypeIcon from '../FileTypeIcon';
import { FileNode } from '../../types/file';

interface FileTreeVscItemProps {
  node: FileNode;
  expandedPaths: Set<string>;
  activeFilePath: string | null;
  parentOpen: boolean;
}

export default function FileTreeVscItem({
  node,
  expandedPaths,
  activeFilePath,
  parentOpen,
}: FileTreeVscItemProps) {
  const isFolder = node.type === 'folder';
  const isExpanded = expandedPaths.has(node.path);
  const effectiveOpen = isFolder && isExpanded && parentOpen;
  const isSelected = activeFilePath === node.path;

  return (
    <VscodeTreeItem
      slot="children"
      branch={isFolder}
      open={effectiveOpen}
      selected={isSelected}
    >
      {isFolder ? (
        <span className="file-tree-item-label" data-file-path={node.path}>
          {node.name}
        </span>
      ) : (
        <span className="file-tree-item-row">
          <span className="file-tree-item-glyph" aria-hidden="true">
            <FileTypeIcon path={node.path} className="file-tree-inline-icon" />
          </span>
          <span className="file-tree-item-label" data-file-path={node.path}>
            {node.name}
          </span>
        </span>
      )}
      {node.isLoading ? <VscodeProgressRing slot="decoration" /> : null}
      {isFolder && node.children
        ? node.children.map((child) => (
            <FileTreeVscItem
              key={child.path}
              node={child}
              expandedPaths={expandedPaths}
              activeFilePath={activeFilePath}
              parentOpen={effectiveOpen}
            />
          ))
        : null}
    </VscodeTreeItem>
  );
}
