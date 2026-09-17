import { useCallback, useEffect, useState } from 'react';
import {
  getAdjacentSiblingFile,
  listSiblingFiles,
} from '../../utils/siblingFiles';
import VscodeClickableToolbarButton from '../VscodeClickableButton';
import './EditorFileSiblingNav.css';

interface EditorFileSiblingNavProps {
  filePath: string;
  onSelectFile: (filePath: string) => void;
}

export default function EditorFileSiblingNav({
  filePath,
  onSelectFile,
}: EditorFileSiblingNavProps) {
  const [canNavigate, setCanNavigate] = useState(false);

  useEffect(() => {
    let cancelled = false;

    listSiblingFiles(filePath).then((siblings) => {
      if (!cancelled) {
        setCanNavigate(siblings.length > 1);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const navigateSibling = useCallback(
    async (direction: 'prev' | 'next') => {
      const nextPath = await getAdjacentSiblingFile(filePath, direction);
      if (nextPath) {
        onSelectFile(nextPath);
      }
    },
    [filePath, onSelectFile],
  );

  return (
    <div
      className={`editor-file-sibling-nav${
        canNavigate ? '' : ' editor-file-sibling-nav--disabled'
      }`}
      role="group"
      aria-label="切换同目录文件"
    >
      <VscodeClickableToolbarButton
        icon="chevron-left"
        label="上一个文件"
        onClick={() => {
          void navigateSibling('prev');
        }}
      />
      <VscodeClickableToolbarButton
        icon="chevron-right"
        label="下一个文件"
        onClick={() => {
          void navigateSibling('next');
        }}
      />
    </div>
  );
}
