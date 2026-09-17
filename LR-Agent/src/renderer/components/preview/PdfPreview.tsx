import {
  VscodeLabel,
  VscodeProgressRing,
} from '@vscode-elements/react-elements';
import { useEffect, useMemo, useState } from 'react';
import { useScrollHostSize } from '../../hooks/useScrollHostSize';

interface PdfPreviewProps {
  pdfData: Uint8Array;
  onError: (message: string) => void;
}

export default function PdfPreview({ pdfData, onError }: PdfPreviewProps) {
  const { hostRef, height: hostHeight } = useScrollHostSize();
  const [ready, setReady] = useState(false);

  const blobUrl = useMemo(() => {
    try {
      const blob = new Blob([pdfData.slice()], { type: 'application/pdf' });
      return URL.createObjectURL(blob);
    } catch {
      onError('无法加载 PDF');
      return null;
    }
  }, [pdfData, onError]);

  useEffect(() => {
    setReady(false);
  }, [blobUrl]);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  const frameStyle =
    hostHeight > 0 ? { height: `${hostHeight}px`, width: '100%' } : undefined;

  return (
    <div ref={hostRef} className="pdf-preview-scroll-host viewer-body">
      {!ready && blobUrl ? (
        <div className="pdf-preview-loading">
          <VscodeProgressRing />
          <VscodeLabel>加载 PDF 中...</VscodeLabel>
        </div>
      ) : null}
      {blobUrl ? (
        <iframe
          className="pdf-native-frame"
          src={blobUrl}
          title="PDF 预览"
          onLoad={() => setReady(true)}
          style={frameStyle}
        />
      ) : null}
    </div>
  );
}
