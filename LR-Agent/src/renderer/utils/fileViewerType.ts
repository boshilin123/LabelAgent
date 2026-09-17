import {
  isDocxPreviewFile,
  isImagePreviewFile,
  isMarkdownFile,
  isPdfPreviewFile,
  isSpecialPreviewFile,
} from '../../shared/workspaceTextExtensions';

export type ViewerType =
  | 'empty'
  | 'markdown'
  | 'pdf'
  | 'image'
  | 'docx'
  | 'text'
  | 'binary'
  | 'unsupported';

export function getViewerType(filePath: string | null): ViewerType {
  if (!filePath) return 'empty';
  if (isMarkdownFile(filePath)) return 'markdown';
  if (isPdfPreviewFile(filePath)) return 'pdf';
  if (isImagePreviewFile(filePath)) return 'image';
  if (isDocxPreviewFile(filePath)) return 'docx';
  if (isSpecialPreviewFile(filePath)) return 'unsupported';
  return 'text';
}

export function resolveViewerType(
  filePath: string | null,
  options?: {
    forceViewerType?: ViewerType;
    preferTextForMarkdown?: boolean;
  },
): ViewerType {
  if (options?.forceViewerType) return options.forceViewerType;
  const base = getViewerType(filePath);
  if (options?.preferTextForMarkdown && base === 'markdown') return 'text';
  return base;
}
