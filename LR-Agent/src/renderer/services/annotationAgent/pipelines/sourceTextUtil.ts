import type { AnnotationProject } from '../../../types/annotation';
import { readWorkspaceTextFile } from '../../../utils/workspaceFileRead';

export async function readSourceTextForProject(
  projectDir: string,
  relativePath: string,
): Promise<string> {
  const stubProject = { directoryPath: projectDir } as AnnotationProject;
  const { content, exists } = await readWorkspaceTextFile({
    project: stubProject,
    workspaceRoot: null,
    relativePath,
  });
  if (!exists) return '';
  return content;
}
