/** Lightweight bridge from AnnotationWorkspace to Agent client_context (avoids tight coupling). */

export interface AnnotationWorkspaceAgentSnapshot {
  selectedAnnotationId: string | null;
  selectedAnnotationIds: string[];
  workspaceDirty: boolean;
  workspaceRelativePath: string | null;
  workspaceProjectId: string | null;
  keypointTemplateId: string | null;
}

let snapshot: AnnotationWorkspaceAgentSnapshot = {
  selectedAnnotationId: null,
  selectedAnnotationIds: [],
  workspaceDirty: false,
  workspaceRelativePath: null,
  workspaceProjectId: null,
  keypointTemplateId: null,
};

export function updateAnnotationWorkspaceAgentSnapshot(
  patch: Partial<AnnotationWorkspaceAgentSnapshot>,
): void {
  snapshot = { ...snapshot, ...patch };
}

export function getAnnotationWorkspaceAgentSnapshot(): AnnotationWorkspaceAgentSnapshot {
  return snapshot;
}
