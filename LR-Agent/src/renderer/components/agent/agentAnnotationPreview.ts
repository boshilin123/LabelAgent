import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import type { AnnotationProject } from '../../types/annotation';
import type {
  AgentPreviewSession,
  ImageCanvasTool,
  PendingAgentNavigation,
} from '../../context/AnnotationWorkspaceContext';
import { mergeProposalChangesIntoDoc } from '../../services/annotationMutationApply';
import {
  isSyntheticAnnotationPath,
  resolveAnnotationOpenTarget,
} from './agentAnnotationNavigation';

export type OpenAnnotationPreviewParams = {
  relativePath: string;
  absolutePath: string;
  annotationId: string;
  status: 'pending' | 'applied' | 'dismissed' | 'undone';
  proposal: AnnotationBatchProposal;
  proposalAnchorId?: string;
};

export type AgentAnnotationPreviewDeps = {
  activeProject: AnnotationProject | null;
  rootPath: string | null;
  workspaceRelativePath: string | null;
  setWorkMode: (mode: 'annotation', opts?: { silent?: boolean }) => void;
  openFileInEditor: (path: string) => void;
  schedulePendingAgentNavigation: (nav: PendingAgentNavigation) => void;
  applyImmediateAnnotationPreview?: (
    params: Omit<OpenAnnotationPreviewParams, 'status' | 'absolutePath'> & {
      status: 'pending';
    },
  ) => boolean;
  enterAgentPreview: (session: AgentPreviewSession) => void;
  selectAnnotation: (id: string | null) => void;
  setTool: (tool: ImageCanvasTool) => void;
  loadSyntheticAnnotationForView: (
    relativePath: string,
    annotationId: string,
  ) => Promise<void>;
};

export function buildFileChangesFromProposal(
  proposal: AnnotationBatchProposal,
  relativePath: string,
): AnnotationBatchProposal['changes'] {
  return proposal.changes.filter(
    (change) => change.relativePath === relativePath,
  );
}

function shouldUseSelectTool(project: AnnotationProject | null): boolean {
  if (!project || project.modality !== 'image') return false;
  return (
    project.annotationType === 'bbox' ||
    project.annotationType === 'rotated_bbox' ||
    project.annotationType === 'polygon' ||
    project.annotationType === 'keypoint'
  );
}

function applySelectToolIfNeeded(
  project: AnnotationProject | null,
  setTool: (tool: ImageCanvasTool) => void,
): void {
  if (shouldUseSelectTool(project)) {
    setTool('select');
  }
}

export function requestOpenAnnotationPreview(
  params: OpenAnnotationPreviewParams,
  deps: AgentAnnotationPreviewDeps,
): boolean {
  const {
    relativePath,
    absolutePath,
    annotationId,
    status,
    proposal,
    proposalAnchorId,
  } = params;
  const {
    activeProject,
    rootPath,
    workspaceRelativePath,
    setWorkMode,
    openFileInEditor,
    schedulePendingAgentNavigation,
    applyImmediateAnnotationPreview,
    enterAgentPreview,
    selectAnnotation,
    setTool,
  } = deps;

  if (!activeProject) return false;

  const target = resolveAnnotationOpenTarget(
    relativePath,
    absolutePath,
    activeProject,
    rootPath,
  );
  if (!target) return false;

  setWorkMode('annotation', { silent: true });

  if (target.kind === 'synthetic') {
    if (status === 'pending') {
      const fileChanges = buildFileChangesFromProposal(proposal, relativePath);
      const merged = mergeProposalChangesIntoDoc(
        null,
        fileChanges,
        activeProject,
      );
      enterAgentPreview({
        relativePath,
        annotations: merged.annotations,
        proposalAnchorId,
      });
      selectAnnotation(annotationId);
      return true;
    }

    void deps.loadSyntheticAnnotationForView(relativePath, annotationId);
    return true;
  }

  const fileChanges =
    status === 'pending'
      ? buildFileChangesFromProposal(proposal, relativePath)
      : undefined;

  if (
    status === 'pending' &&
    workspaceRelativePath &&
    relativePath === workspaceRelativePath &&
    applyImmediateAnnotationPreview?.({
      relativePath,
      annotationId,
      proposal,
      proposalAnchorId,
      status: 'pending',
    })
  ) {
    openFileInEditor(target.absolutePath);
    applySelectToolIfNeeded(activeProject, setTool);
    return true;
  }

  schedulePendingAgentNavigation({
    relativePath,
    annotationId,
    proposalAnchorId,
    pendingChanges: fileChanges,
    mode: status === 'pending' ? 'preview' : 'select',
  });

  openFileInEditor(target.absolutePath);
  applySelectToolIfNeeded(activeProject, setTool);
  return true;
}

export function isAgentPreviewPathMatch(
  sessionRelativePath: string,
  workspaceRelativePath: string | null,
): boolean {
  if (sessionRelativePath === workspaceRelativePath) return true;
  if (
    !workspaceRelativePath &&
    isSyntheticAnnotationPath(sessionRelativePath)
  ) {
    return true;
  }
  return false;
}
