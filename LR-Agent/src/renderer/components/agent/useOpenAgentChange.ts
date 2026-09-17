import { useCallback } from 'react';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import type { ProposalBlockStatus } from '../../../shared/agentTypes';
import { isFileProposalBlock } from '../../../shared/agentTypes';
import type { ChatMessage } from '../../types/agent';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import { useWorkMode } from '../../context/WorkModeContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { useAgentFilePreview } from '../../hooks/useAgentFilePreview';
import type { PendingChangeItem } from '../../services/agentProposalApply';
import { resolveWorkspaceAbsolutePath } from '../../utils/workspacePaths';
import { readWorkspaceTextFile } from '../../utils/workspaceFileRead';
import { scrollToProposalAnchor } from '../../utils/fileDiffStats';
import { requestOpenAnnotationPreview } from './agentAnnotationPreview';

export function useOpenAgentChange() {
  const { activeProject } = useAnnotation();
  const { rootPath, openFileInEditor } = useApp();
  const { setWorkMode } = useWorkMode();
  const {
    enterAgentPreview,
    schedulePendingAgentNavigation,
    applyImmediateAnnotationPreview,
    relativeFilePath,
    loadSyntheticAnnotationForView,
    selectAnnotation,
    setTool,
  } = useAnnotationWorkspace();
  const { enterFilePreview, clearFilePreview } = useAgentFilePreview();

  const openFileProposal = useCallback(
    async (options: {
      relativePath: string;
      content: string;
      operation?: 'write' | 'delete' | 'rename';
      oldPath?: string;
      status: ProposalBlockStatus;
    }) => {
      // rename 提案：目标文件确认前尚不存在，打开原路径查看，不出 diff 预览
      const openRelativePath =
        options.operation === 'rename' && options.oldPath
          ? options.oldPath
          : options.relativePath;
      const absolutePath = resolveWorkspaceAbsolutePath(
        openRelativePath,
        activeProject ?? null,
        rootPath,
      );
      if (!absolutePath) return;
      // 目录不能当文件打开：否则 binaryFileDetect / 编辑器读正文会刷
      // EISDIR 错误日志，并打开一个空白 tab。
      const stats =
        await window.electron?.fileSystem?.getFileStats?.(absolutePath);
      if (stats?.isDirectory) return;
      const operation = options.operation ?? 'write';
      if (options.operation === 'rename') {
        clearFilePreview();
        setWorkMode('editor', { silent: true });
        openFileInEditor(absolutePath);
        return;
      }
      const existing = await readWorkspaceTextFile({
        project: activeProject ?? null,
        workspaceRoot: rootPath,
        relativePath: options.relativePath,
      });
      const oldContent = existing.exists ? existing.content : '';
      const newContent = operation === 'delete' ? '' : options.content;
      if (options.status === 'pending') {
        enterFilePreview({
          absolutePath,
          relativePath: options.relativePath,
          oldContent,
          newContent,
          operation,
        });
      } else {
        clearFilePreview();
      }
      setWorkMode('editor', { silent: true });
      openFileInEditor(absolutePath);
    },
    [
      activeProject,
      clearFilePreview,
      enterFilePreview,
      openFileInEditor,
      rootPath,
      setWorkMode,
    ],
  );

  const openAnnotationProposal = useCallback(
    (options: {
      relativePath: string;
      absolutePath: string;
      status: ProposalBlockStatus;
      proposal: AnnotationBatchProposal;
      proposalAnchorId?: string;
    }) => {
      const fileChanges = options.proposal.changes.filter(
        (change) => change.relativePath === options.relativePath,
      );
      const annotationId =
        fileChanges
          .flatMap((change) => change.annotations ?? [])
          .find((ann) => ann.id)?.id ??
        fileChanges.flatMap((change) => change.deleteIds ?? [])[0] ??
        '';
      requestOpenAnnotationPreview(
        {
          relativePath: options.relativePath,
          absolutePath: options.absolutePath,
          annotationId,
          status: options.status,
          proposal: options.proposal,
          proposalAnchorId: options.proposalAnchorId,
        },
        {
          activeProject: activeProject ?? null,
          rootPath,
          workspaceRelativePath: relativeFilePath,
          setWorkMode,
          openFileInEditor,
          schedulePendingAgentNavigation,
          applyImmediateAnnotationPreview,
          enterAgentPreview,
          selectAnnotation,
          setTool,
          loadSyntheticAnnotationForView,
        },
      );
    },
    [
      activeProject,
      applyImmediateAnnotationPreview,
      enterAgentPreview,
      loadSyntheticAnnotationForView,
      openFileInEditor,
      relativeFilePath,
      rootPath,
      schedulePendingAgentNavigation,
      selectAnnotation,
      setTool,
      setWorkMode,
    ],
  );

  const openChangeItem = useCallback(
    (item: PendingChangeItem, messages: ChatMessage[]) => {
      const message = messages.find((entry) => entry.id === item.ref.messageId);
      const block = message?.blocks[item.ref.blockIndex];
      if (!message || !block) return;

      if (item.kind === 'file' && isFileProposalBlock(block)) {
        void openFileProposal({
          relativePath: block.suggestedRelativePath,
          content: block.content,
          operation: block.operation,
          oldPath: block.oldPath,
          status: block.status,
        });
      } else if (
        item.kind === 'annotation' &&
        block.type === 'annotation_proposal'
      ) {
        const change = block.proposal.changes.find(
          (entry) => entry.relativePath === item.path,
        );
        openAnnotationProposal({
          relativePath: item.path,
          absolutePath: change?.absolutePath ?? '',
          status: block.status,
          proposal: block.proposal,
          proposalAnchorId: `proposal-${item.ref.messageId}-${item.ref.blockIndex}`,
        });
      }

      scrollToProposalAnchor(item.ref.messageId, item.ref.blockIndex);
    },
    [openAnnotationProposal, openFileProposal],
  );

  return { openFileProposal, openAnnotationProposal, openChangeItem };
}
