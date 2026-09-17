import { useEffect, useState } from 'react';
import { useWorkMode } from '../../context/WorkModeContext';
import { checkBinaryFile } from '../../utils/binaryFileDetect';
import { isMonacoEditableFile } from '../../utils/editorFileTypes';
import FileViewer from '../FileViewer';
import './EditorPane.css';

interface EditorPaneProps {
  filePath: string;
  isActive: boolean;
}

export default function EditorPane({ filePath, isActive }: EditorPaneProps) {
  const { workMode } = useWorkMode();
  const monacoEligible = isMonacoEditableFile(filePath);
  const loadPaused = !isActive;
  const [isBinary, setIsBinary] = useState<boolean | null>(null);

  const hideFileHeader = true;

  useEffect(() => {
    if (!monacoEligible || workMode !== 'editor') {
      setIsBinary(null);
      return undefined;
    }

    let cancelled = false;
    checkBinaryFile(filePath)
      .then((binary) => {
        if (!cancelled) setIsBinary(binary);
      })
      .catch(() => {
        if (!cancelled) setIsBinary(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, monacoEligible, workMode]);

  if (!monacoEligible) {
    return (
      <FileViewer
        filePath={filePath}
        embedded
        hideFileHeader={hideFileHeader}
        loadPaused={loadPaused}
      />
    );
  }

  if (workMode === 'annotation') {
    return (
      <FileViewer
        filePath={filePath}
        embedded
        hideFileHeader={hideFileHeader}
        loadPaused={loadPaused}
      />
    );
  }

  if (isBinary) {
    return (
      <FileViewer
        filePath={filePath}
        embedded
        hideFileHeader={hideFileHeader}
        loadPaused={loadPaused}
        forceViewerType="binary"
      />
    );
  }

  return <div className="editor-pane editor-pane--monaco-host" aria-hidden />;
}
