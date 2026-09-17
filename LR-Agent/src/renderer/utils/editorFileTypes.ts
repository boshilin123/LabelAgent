import { isTextEditableFile } from '../../shared/workspaceTextExtensions';

export function isMonacoEditableFile(filePath: string): boolean {
  return isTextEditableFile(filePath);
}

export { isMarkdownFile } from '../../shared/workspaceTextExtensions';
