import type { AnnotationProject } from '../types/annotation';
import {
  parseFileAnnotationDocument,
  type FileAnnotationDocument,
} from '../types/annotationDocument';
import type { ChatMessage, MessageBlock } from '../../shared/agentTypes';
import { isFileProposalBlock } from '../../shared/agentTypes';
import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';
import { patchAgentMessageBlockRemote } from './agentChatApi';

function resolveWorkspaceRoot(
  project: AnnotationProject | null,
  workspaceRoot: string | null,
): string | null {
  return project?.directoryPath ?? workspaceRoot;
}

/** 若磁盘文件已与 pending file_proposal 一致，自动标为 applied 并持久化。 */
export async function reconcileAppliedFileProposals(options: {
  sessionId: string;
  messages: Record<string, ChatMessage>;
  messageIds: string[];
  project: AnnotationProject | null;
  workspaceRoot: string | null;
  updateBlock: (
    messageId: string,
    blockIndex: number,
    patch: Partial<MessageBlock>,
  ) => void;
}): Promise<number> {
  const root = resolveWorkspaceRoot(options.project, options.workspaceRoot);
  if (!root || !window.electron?.workspace?.readTextFile) return 0;

  let reconciled = 0;

  for (const messageId of options.messageIds) {
    const msg = options.messages[messageId];
    if (!msg || msg.role !== 'assistant') continue;

    for (let blockIndex = 0; blockIndex < msg.blocks.length; blockIndex += 1) {
      const block = msg.blocks[blockIndex];
      if (!isFileProposalBlock(block) || block.status !== 'pending') continue;

      const readResult = await window.electron.workspace.readTextFile({
        rootDir: root,
        relativePath: block.suggestedRelativePath,
      });
      if (!readResult.success) continue;
      if (!readResult.exists) continue;
      if (readResult.content !== block.content) continue;

      options.updateBlock(messageId, blockIndex, {
        ...block,
        status: 'applied',
      });
      reconciled += 1;

      // 持久化到 SQLite
      patchAgentMessageBlockRemote({
        sessionId: options.sessionId,
        messageId,
        blockType: 'file_proposal',
        blockIndex,
        patch: { status: 'applied' },
      }).catch(() => undefined);
    }
  }

  return reconciled;
}

/** 磁盘文档是否已经体现该 change（用于 reconcile，不写盘）。 */
export function isAnnotationChangeAppliedOnDisk(
  change: AnnotationBatchChange,
  doc: FileAnnotationDocument | null,
): boolean {
  if (change.operation === 'delete') {
    const ids = change.deleteIds ?? [];
    if (ids.length === 0) return false;
    // 文件不存在：pending 框可能从未写盘，不能当成已删除。
    if (!doc) return false;
    const existingIds = new Set(doc.annotations.map((ann) => ann.id));
    return ids.every((id) => !existingIds.has(id));
  }

  if (!doc) return false;
  const byId = new Map(doc.annotations.map((ann) => [ann.id, ann]));

  if (change.operation === 'patch') {
    const patches = change.patches ?? [];
    if (patches.length === 0) return false;
    return patches.every((patch) => {
      const ann = byId.get(patch.id);
      if (!ann) return false;
      if (patch.labelId !== undefined && ann.labelId !== patch.labelId) {
        return false;
      }
      return true;
    });
  }

  const proposalIds = (change.annotations ?? [])
    .map((ann) => ann.id)
    .filter((id): id is string => Boolean(id));
  if (proposalIds.length === 0) return false;
  return proposalIds.every((id) => byId.has(id));
}

export async function reconcileAppliedAnnotationProposals(options: {
  sessionId: string;
  messages: Record<string, ChatMessage>;
  messageIds: string[];
  project: AnnotationProject | null;
  updateBlock: (
    messageId: string,
    blockIndex: number,
    patch: Partial<MessageBlock>,
  ) => void;
}): Promise<number> {
  const projectDir = options.project?.directoryPath;
  if (!projectDir || !window.electron?.annotation?.readFileAnnotationDoc)
    return 0;

  let reconciled = 0;

  for (const messageId of options.messageIds) {
    const msg = options.messages[messageId];
    if (!msg || msg.role !== 'assistant') continue;

    for (let blockIndex = 0; blockIndex < msg.blocks.length; blockIndex += 1) {
      const block = msg.blocks[blockIndex];
      if (block.type !== 'annotation_proposal' || block.status !== 'pending')
        continue;

      let allApplied = true;
      for (const change of block.proposal.changes) {
        try {
          const raw = await window.electron.annotation.readFileAnnotationDoc(
            projectDir,
            change.relativePath,
          );
          const doc = raw ? parseFileAnnotationDocument(raw) : null;
          if (!isAnnotationChangeAppliedOnDisk(change, doc)) {
            allApplied = false;
            break;
          }
        } catch {
          allApplied = false;
          break;
        }
      }

      if (!allApplied) continue;

      options.updateBlock(messageId, blockIndex, {
        ...block,
        status: 'applied',
      });
      reconciled += 1;

      // 持久化到 SQLite
      patchAgentMessageBlockRemote({
        sessionId: options.sessionId,
        messageId,
        blockType: 'annotation_proposal',
        blockIndex,
        patch: { status: 'applied' },
      }).catch(() => undefined);
    }
  }

  return reconciled;
}
