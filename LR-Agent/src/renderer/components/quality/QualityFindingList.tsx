import { useCallback } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import { useWorkMode } from '../../context/WorkModeContext';
import { resolveWorkspaceAbsolutePath } from '../../utils/workspacePaths';
import type { ConsistencyFinding } from '../../services/annotationQuality/types';

interface QualityFindingListProps {
  findings: ConsistencyFinding[];
}

export default function QualityFindingList({
  findings,
}: QualityFindingListProps) {
  const { activeProject } = useAnnotation();
  const { rootPath, openFileInEditor } = useApp();
  const { setWorkMode } = useWorkMode();

  const handleOpen = useCallback(
    (relativePath: string) => {
      const resolved = resolveWorkspaceAbsolutePath(
        relativePath,
        activeProject ?? null,
        rootPath,
      );
      if (!resolved) return;
      setWorkMode('annotation', { silent: true });
      openFileInEditor(resolved);
    },
    [activeProject, openFileInEditor, rootPath, setWorkMode],
  );

  if (findings.length === 0) {
    return <p className="quality-findings-empty">未发现一致性问题</p>;
  }

  const sorted = [...findings].sort((a, b) => {
    const rank = (s: ConsistencyFinding['severity']) =>
      s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
    return rank(a.severity) - rank(b.severity);
  });

  return (
    <ul className="quality-findings-list">
      {sorted.slice(0, 50).map((finding) => (
        <li
          key={finding.id}
          className={`quality-finding quality-finding--${finding.severity}`}
        >
          <span className="quality-finding__message">{finding.message}</span>
          {finding.relativePath ? (
            <VscodeButton
              secondary
              icon="go-to-file"
              type="button"
              className="quality-finding__open"
              onClick={() => handleOpen(finding.relativePath!)}
            >
              打开
            </VscodeButton>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
