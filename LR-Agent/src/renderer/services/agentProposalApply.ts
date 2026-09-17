import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';
import type { AnnotationProject, LabelDefinition } from '../types/annotation';
import type {
  ChatMessage,
  FileProposalLikeBlock,
  MessageBlock,
  ProposalBlockStatus,
} from '../../shared/agentTypes';
import { isFileProposalBlock } from '../../shared/agentTypes';
import { isLrAgentRelativePath } from '../../shared/workspacePathGuards';
import type { AnnotationInstance } from '../types/annotationDocument';
import {
  applyAnnotationBatchProposal,
  dispatchMutationsAppliedEvent,
} from './annotationProposalApply';
import { getAnnotationWorkspaceAgentSnapshot } from './annotationAgentBridge';
import { isAgentDocumentWriteEnabled } from './agentFeatureFlags';
import { patchAgentMessageBlockRemote } from './agentChatApi';
import { markWorkspaceTextFilesChanged } from './agentFilePreviewStore';
import {
  captureProposalCheckpoint,
  discardProposalCheckpoint,
  recordProposalCheckpointAfter,
  type CheckpointRef,
} from './turnCheckpoint';

export type PendingProposalRef = {
  messageId: string;
  blockIndex: number;
  kind: 'annotation' | 'file';
};

export type PendingChangeItem = {
  id: string;
  ref: PendingProposalRef;
  path: string;
  summary: string;
  kind: PendingProposalRef['kind'];
  additions?: number;
  deletions?: number;
  /** file_proposal 新内容，供 Keep All 栏异步算 diff */
  newContent?: string;
  operation?: 'write' | 'delete' | string;
  destructive?: boolean;
};

export function summarizeAnnotationChange(
  change: AnnotationBatchProposal['changes'][number],
): string {
  const kindLabel = inferAnnotationKindLabel(change);
  switch (change.operation) {
    case 'patch':
      return `修改 ${change.patches?.length ?? 0} ${kindLabel}`;
    case 'delete':
      return `删除 ${change.deleteIds?.length ?? 0} ${kindLabel}`;
    case 'replace':
    case 'replace_bboxes':
      return `替换 ${change.annotations?.length ?? 0} ${kindLabel}`;
    case 'append':
    default:
      return `新增 ${change.annotations?.length ?? 0} ${kindLabel}`;
  }
}

function inferAnnotationKindLabel(
  change: AnnotationBatchProposal['changes'][number],
): string {
  const annotations = change.annotations ?? [];
  if (annotations.length === 0) return '项';
  const { kind } = annotations[0];
  switch (kind) {
    case 'bbox':
    case 'rotated_bbox':
    case 'polygon':
      return '个框';
    case 'caption':
      return '条描述';
    case 'classification':
      return '条分类';
    case 'instruction':
      return '条指令';
    case 'cot':
      return '条思维链';
    case 'conversation':
      return '条对话';
    case 'preference':
      return '条偏好';
    case 'span_ner':
      return '条实体';
    case 'text_classification':
      return '条分类';
    case 'pose':
    case 'point':
      return '个标注';
    default:
      return '项';
  }
}

const MAX_PREVIEW_LEN = 80;

function truncate(text: string, max: number = MAX_PREVIEW_LEN): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function labelName(
  labelId: string | null,
  labelMap: Map<string, string>,
): string {
  if (!labelId) return '(无标签)';
  return labelMap.get(labelId) ?? labelId;
}

export function formatAnnotationPreviewText(
  ann: AnnotationInstance,
  labelMap: Map<string, string>,
): string {
  switch (ann.kind) {
    case 'bbox':
      return `${labelName(ann.labelId, labelMap)} (${ann.x.toFixed(2)}, ${ann.y.toFixed(2)}, ${ann.width.toFixed(2)}, ${ann.height.toFixed(2)})`;
    case 'rotated_bbox':
      return `${labelName(ann.labelId, labelMap)} (cx:${ann.cx.toFixed(2)}, cy:${ann.cy.toFixed(2)}, ${ann.width.toFixed(2)}x${ann.height.toFixed(2)}, ${ann.angle}deg)`;
    case 'polygon':
      return `${labelName(ann.labelId, labelMap)} (${ann.points.length} 顶点)`;
    case 'pose':
      return `${labelName(ann.labelId, labelMap)} (${ann.keypoints.length} 关键点)`;
    case 'point':
      return `${labelName(ann.labelId, labelMap)} (${ann.x.toFixed(2)}, ${ann.y.toFixed(2)})`;
    case 'caption':
      return truncate(ann.text);
    case 'classification':
      return labelName(ann.labelId, labelMap);
    case 'span_ner':
      return `${labelName(ann.labelId, labelMap)} [${ann.start}:${ann.end}]`;
    case 'text_classification':
      return `${labelName(ann.labelId, labelMap)}${ann.note ? ` (${truncate(ann.note, 40)})` : ''}`;
    case 'instruction':
      return `指令: ${truncate(ann.instruction, 30)} / 输出: ${truncate(ann.output, 30)}`;
    case 'cot':
      return `步骤: ${ann.steps.length} / 答案: ${truncate(ann.answer, 40)}`;
    case 'conversation':
      return `轮次: ${ann.turns.length} / 首: ${truncate(ann.turns[0]?.content ?? '', 30)}`;
    case 'preference':
      return `chosen: ${truncate(ann.chosen, 25)} / rejected: ${truncate(ann.rejected, 25)}`;
    default:
      return '';
  }
}

export function buildLabelMap(labels: LabelDefinition[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of labels) {
    map.set(l.id, l.name);
  }
  return map;
}

export function annotationChangeDiffStats(
  change: AnnotationBatchProposal['changes'][number],
): { additions: number; deletions: number } {
  if (change.operation === 'delete') {
    return {
      additions: 0,
      deletions: change.deleteIds?.length || change.annotations?.length || 0,
    };
  }
  if (change.operation === 'patch') {
    return {
      additions: change.patches?.length || 0,
      deletions: 0,
    };
  }
  return {
    additions: change.annotations?.length || change.patches?.length || 0,
    deletions: 0,
  };
}

export type MessageChangeItem = {
  id: string;
  ref: PendingProposalRef;
  path: string;
  kind: PendingProposalRef['kind'];
  status: ProposalBlockStatus;
  summary: string;
  operation?: string;
  newContent?: string;
  additions?: number;
  deletions?: number;
  absolutePath?: string;
};

export function collectMessageChangeItems(
  message: ChatMessage,
): MessageChangeItem[] {
  if (message.role !== 'assistant') return [];
  const items: MessageChangeItem[] = [];
  message.blocks.forEach((block, blockIndex) => {
    if (block.type === 'annotation_proposal') {
      if (block.status === 'dismissed') return;
      const ref: PendingProposalRef = {
        messageId: message.id,
        blockIndex,
        kind: 'annotation',
      };
      block.proposal.changes.forEach((change, changeIndex) => {
        const stats = annotationChangeDiffStats(change);
        items.push({
          id: `${ref.messageId}-${ref.blockIndex}-${change.relativePath}-${change.operation}-${changeIndex}`,
          ref,
          path: change.relativePath,
          kind: 'annotation',
          status: block.status,
          summary: summarizeAnnotationChange(change),
          operation: change.operation,
          absolutePath: change.absolutePath,
          additions: stats.additions,
          deletions: stats.deletions,
        });
      });
      return;
    }
    if (isFileProposalBlock(block)) {
      if (block.status === 'dismissed') return;
      items.push({
        id: `${message.id}-${blockIndex}`,
        ref: { messageId: message.id, blockIndex, kind: 'file' },
        path: block.suggestedRelativePath,
        kind: 'file',
        status: block.status,
        summary:
          block.operation === 'delete'
            ? '删除文件'
            : block.operation === 'rename'
              ? '移动文件'
              : '写入文件',
        operation: block.operation ?? 'write',
        newContent: block.content,
        additions: block.additions,
        deletions: block.deletions,
      });
    }
  });
  return items;
}

export function collectPendingChangeItems(
  messages: ChatMessage[],
): PendingChangeItem[] {
  const refs = collectPendingProposals(messages);
  const items: PendingChangeItem[] = [];

  for (const ref of refs) {
    const msg = messages.find((m) => m.id === ref.messageId);
    if (!msg) continue;
    const block = msg.blocks[ref.blockIndex];
    if (!block) continue;

    if (ref.kind === 'annotation' && block.type === 'annotation_proposal') {
      block.proposal.changes.forEach((change, changeIndex) => {
        items.push({
          id: `${ref.messageId}-${ref.blockIndex}-${change.relativePath}-${change.operation}-${changeIndex}`,
          ref,
          path: change.relativePath,
          summary: summarizeAnnotationChange(change),
          kind: 'annotation',
          operation: change.operation,
          destructive: change.operation === 'delete',
        });
      });
    } else if (ref.kind === 'file' && isFileProposalBlock(block)) {
      items.push({
        id: `${ref.messageId}-${ref.blockIndex}`,
        ref,
        path: block.suggestedRelativePath,
        summary:
          block.operation === 'delete'
            ? '删除文件'
            : block.operation === 'rename'
              ? '移动文件'
              : '写入文件',
        kind: 'file',
        newContent: block.content,
        operation: block.operation ?? 'write',
        destructive: block.operation === 'delete',
      });
    }
  }

  return items;
}

export function collectPendingProposals(
  messages: ChatMessage[],
): PendingProposalRef[] {
  const refs: PendingProposalRef[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    msg.blocks.forEach((block, blockIndex) => {
      if (block.type === 'annotation_proposal' && block.status === 'pending') {
        refs.push({ messageId: msg.id, blockIndex, kind: 'annotation' });
      } else if (isFileProposalBlock(block) && block.status === 'pending') {
        refs.push({ messageId: msg.id, blockIndex, kind: 'file' });
      }
    });
  }
  return refs;
}

export function countPendingProposals(messages: ChatMessage[]): number {
  return collectPendingProposals(messages).length;
}

export function dismissPendingProposals(options: {
  sessionId: string;
  messages: ChatMessage[];
  updateBlock: (
    messageId: string,
    blockIndex: number,
    patch: { status: 'dismissed' },
  ) => void;
}): number {
  const refs = collectPendingProposals(options.messages);
  for (const ref of refs) {
    const block = options.messages.find((msg) => msg.id === ref.messageId)
      ?.blocks[ref.blockIndex];
    if (!block) continue;
    options.updateBlock(ref.messageId, ref.blockIndex, { status: 'dismissed' });
    patchAgentMessageBlockRemote({
      sessionId: options.sessionId,
      messageId: ref.messageId,
      blockType: block.type,
      blockIndex: ref.blockIndex,
      patch: { status: 'dismissed' },
    }).catch(() => undefined);
  }
  return refs.length;
}

function annotationHasUnresolved(proposal: AnnotationBatchProposal): boolean {
  return proposal.changes.some((change) => {
    if (change.operation === 'patch') return !change.patches?.length;
    if (change.operation === 'delete') return !change.deleteIds?.length;
    if (
      change.operation === 'append' ||
      change.operation === 'replace' ||
      change.operation === 'replace_bboxes'
    ) {
      return !change.annotations?.length;
    }
    return true;
  });
}

export type ApplyCheckpointContext = CheckpointRef & {
  workspaceRoot?: string | null;
};

async function withProposalCheckpoint<T>(
  options: {
    checkpoint?: ApplyCheckpointContext;
    project: AnnotationProject | null;
    kind: 'annotation' | 'file';
    annotationPaths?: string[];
    filePaths?: string[];
  },
  write: () => Promise<T>,
): Promise<{ value: T; hasCheckpoint: boolean }> {
  const { checkpoint } = options;
  let captured = false;
  if (checkpoint) {
    captured = await captureProposalCheckpoint({
      ref: checkpoint,
      kind: options.kind,
      project: options.project,
      workspaceRoot: checkpoint.workspaceRoot,
      annotationPaths: options.annotationPaths,
      filePaths: options.filePaths,
    });
  }
  try {
    const value = await write();
    let hasCheckpoint = false;
    if (captured && checkpoint) {
      hasCheckpoint = await recordProposalCheckpointAfter({
        ref: checkpoint,
        project: options.project,
        workspaceRoot: checkpoint.workspaceRoot,
      });
    }
    return { value, hasCheckpoint };
  } catch (err) {
    if (captured && checkpoint) {
      await discardProposalCheckpoint(checkpoint);
    }
    throw err;
  }
}

export async function applyAnnotationProposalWithGuards(
  project: AnnotationProject,
  proposal: AnnotationBatchProposal,
  options?: { checkpoint?: ApplyCheckpointContext },
): Promise<{ hasCheckpoint: boolean }> {
  if (annotationHasUnresolved(proposal)) {
    throw new Error('标注提案包含未解析的变更');
  }
  const wsSnap = getAnnotationWorkspaceAgentSnapshot();
  const overlapPaths = proposal.changes
    .map((c) => c.relativePath)
    .filter(
      (rel) =>
        wsSnap.workspaceDirty &&
        wsSnap.workspaceRelativePath === rel &&
        wsSnap.workspaceProjectId === proposal.projectId,
    );
  if (overlapPaths.length > 0) {
    const ok = window.confirm(
      '工作区有未保存的修改，应用提案将覆盖磁盘上的标注 JSON。是否继续？',
    );
    if (!ok) throw new Error('用户取消应用');
  }
  const { hasCheckpoint } = await withProposalCheckpoint(
    {
      checkpoint: options?.checkpoint,
      project,
      kind: 'annotation',
      annotationPaths: proposal.changes.map((change) => change.relativePath),
    },
    async () => {
      const result = await applyAnnotationBatchProposal(project, proposal, {
        onFreshnessConflict: (_rel, reason) =>
          window.confirm(`${reason}。是否仍要应用？`),
      });
      dispatchMutationsAppliedEvent(proposal.projectId, result.relativePaths, {
        force: true,
      });
      return result;
    },
  );
  return { hasCheckpoint };
}

async function applyFileBlock(
  project: AnnotationProject | null,
  workspaceRoot: string | null,
  block: FileProposalLikeBlock,
  checkpoint?: ApplyCheckpointContext,
): Promise<{ hasCheckpoint: boolean }> {
  if (!isAgentDocumentWriteEnabled()) {
    throw new Error('文档写入功能未启用');
  }
  const root = project?.directoryPath ?? workspaceRoot;
  if (!root) throw new Error('请先打开项目或工作区目录');
  if (isLrAgentRelativePath(block.suggestedRelativePath)) {
    throw new Error('禁止写入 .lr-agent 标注库目录，请使用标注工具。');
  }
  // rename 提案：内容不变，落盘动作是把旧路径移动到新路径；
  // checkpoint 需同时覆盖两个路径，Undo 才能既删新路径又还原旧路径。
  if (block.operation === 'rename') {
    const oldPath = (block.oldPath ?? '').trim();
    if (!oldPath) throw new Error('移动提案缺少原路径');
    if (isLrAgentRelativePath(oldPath)) {
      throw new Error('禁止移动 .lr-agent 标注库目录内的文件。');
    }
    return withProposalCheckpoint(
      {
        checkpoint,
        project,
        kind: 'file',
        filePaths: [oldPath, block.suggestedRelativePath],
      },
      async () => {
        const result = await window.electron?.workspace?.moveTextFile?.({
          rootDir: root,
          relativePath: oldPath,
          newRelativePath: block.suggestedRelativePath,
        });
        if (!result?.success) {
          throw new Error(result?.error ?? '移动失败');
        }
        markWorkspaceTextFilesChanged([oldPath, block.suggestedRelativePath]);
      },
    );
  }
  return withProposalCheckpoint(
    {
      checkpoint,
      project,
      kind: 'file',
      filePaths: [block.suggestedRelativePath],
    },
    async () => {
      if (block.operation === 'delete') {
        const result = await window.electron?.workspace?.deleteTextFile?.({
          rootDir: root,
          relativePath: block.suggestedRelativePath,
        });
        if (!result?.success) {
          throw new Error(result?.error ?? '删除失败');
        }
        markWorkspaceTextFilesChanged([block.suggestedRelativePath]);
        return;
      }
      const result = await window.electron?.workspace?.writeTextFile({
        rootDir: root,
        relativePath: block.suggestedRelativePath,
        content: block.content,
      });
      if (!result?.success) {
        throw new Error(result?.error ?? '保存失败');
      }
      // 在统一入口标记磁盘变更：无论从顶栏、卡片还是重新应用走哪条路径，
      // 已打开的编辑器 tab 都会强制重读磁盘，避免滞留旧内容。
      markWorkspaceTextFilesChanged([block.suggestedRelativePath]);
    },
  );
}

async function syncBlockStatusRemote(options: {
  sessionId: string;
  messageId: string;
  blockIndex: number;
  blockType: string;
  patch: Record<string, unknown>;
  onSyncWarning?: (message: string) => void;
}): Promise<void> {
  try {
    await patchAgentMessageBlockRemote({
      sessionId: options.sessionId,
      messageId: options.messageId,
      blockType: options.blockType,
      blockIndex: options.blockIndex,
      patch: options.patch,
    });
  } catch {
    options.onSyncWarning?.('状态未持久化，刷新后可能再次提示 Keep All');
  }
}

export async function applyProposalRefs(options: {
  sessionId: string;
  messages: ChatMessage[];
  refs: PendingProposalRef[];
  project: AnnotationProject | null;
  workspaceRoot?: string | null;
  updateBlock: (
    messageId: string,
    blockIndex: number,
    patch: Partial<MessageBlock>,
  ) => void;
  onSyncWarning?: (message: string) => void;
}): Promise<{ applied: number; errors: string[]; missingCheckpoints: number }> {
  const { refs } = options;
  if (refs.length === 0) {
    return { applied: 0, errors: [], missingCheckpoints: 0 };
  }

  const errors: string[] = [];
  let applied = 0;
  let missingCheckpoints = 0;

  for (const ref of refs) {
    const msg = options.messages.find((m) => m.id === ref.messageId);
    if (!msg) continue;
    const block = msg.blocks[ref.blockIndex];
    if (!block) continue;

    try {
      if (ref.kind === 'annotation' && block.type === 'annotation_proposal') {
        if (
          !options.project ||
          options.project.id !== block.proposal.projectId
        ) {
          throw new Error('请先打开对应的标注项目');
        }
        const appliedResult = await applyAnnotationProposalWithGuards(
          options.project,
          block.proposal,
          {
            checkpoint: {
              sessionId: options.sessionId,
              messageId: ref.messageId,
              blockIndex: ref.blockIndex,
              workspaceRoot: options.workspaceRoot,
            },
          },
        );
        options.updateBlock(ref.messageId, ref.blockIndex, {
          ...block,
          status: 'applied',
          hasCheckpoint: appliedResult.hasCheckpoint,
        });
        await syncBlockStatusRemote({
          sessionId: options.sessionId,
          messageId: ref.messageId,
          blockIndex: ref.blockIndex,
          blockType: 'annotation_proposal',
          patch: {
            status: 'applied',
            hasCheckpoint: appliedResult.hasCheckpoint,
          },
          onSyncWarning: options.onSyncWarning,
        });
        applied += 1;
        if (!appliedResult.hasCheckpoint) missingCheckpoints += 1;
      } else if (ref.kind === 'file' && isFileProposalBlock(block)) {
        const appliedResult = await applyFileBlock(
          options.project,
          options.workspaceRoot ?? null,
          block,
          {
            sessionId: options.sessionId,
            messageId: ref.messageId,
            blockIndex: ref.blockIndex,
            workspaceRoot: options.workspaceRoot,
          },
        );
        options.updateBlock(ref.messageId, ref.blockIndex, {
          ...block,
          status: 'applied',
          hasCheckpoint: appliedResult.hasCheckpoint,
        });
        await syncBlockStatusRemote({
          sessionId: options.sessionId,
          messageId: ref.messageId,
          blockIndex: ref.blockIndex,
          blockType: 'file_proposal',
          patch: {
            status: 'applied',
            hasCheckpoint: appliedResult.hasCheckpoint,
          },
          onSyncWarning: options.onSyncWarning,
        });
        applied += 1;
        if (!appliedResult.hasCheckpoint) missingCheckpoints += 1;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : '应用失败');
    }
  }

  return { applied, errors, missingCheckpoints };
}

export async function applyAllPendingProposals(options: {
  sessionId: string;
  messages: ChatMessage[];
  project: AnnotationProject | null;
  workspaceRoot?: string | null;
  updateBlock: (
    messageId: string,
    blockIndex: number,
    patch: Partial<MessageBlock>,
  ) => void;
  onSyncWarning?: (message: string) => void;
}): Promise<{
  applied: number;
  errors: string[];
  missingCheckpoints: number;
}> {
  return applyProposalRefs({
    ...options,
    refs: collectPendingProposals(options.messages),
  });
}
