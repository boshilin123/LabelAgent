import type { ChatMessage, ProposalStateEntry } from '../../shared/agentTypes';
import { isFileProposalBlock } from '../../shared/agentTypes';
import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';

function unlabeledCount(change: AnnotationBatchChange): number {
  return (change.annotations ?? []).filter((ann) => !ann.labelId).length;
}

function annotationLine(
  path: string,
  status: string,
  change: AnnotationBatchChange,
): string {
  const op = change.operation;
  const ids =
    op === 'delete'
      ? (change.deleteIds ?? [])
      : (change.annotations ?? [])
          .map((ann) => ann.id)
          .filter(Boolean)
          .slice(0, 8);
  const unlabeled = unlabeledCount(change);
  const extra = unlabeled > 0 ? `（${unlabeled} 个无标签）` : '';
  const idPart = ids.length > 0 ? ` ids=${ids.join(',')}` : '';
  return `- annotation ${status} ${path} ${op}${idPart}${extra}`;
}

function section(title: string, intro: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [`${title}无`];
  }
  return [title + intro, ...lines];
}

/** 会话提案台账。无 pending/applied 时返回空串。 */
export function buildProposalLedger(messages: ChatMessage[]): string {
  const pending: string[] = [];
  const applied: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.blocks) {
      if (block.type === 'annotation_proposal') {
        if (block.status === 'pending') {
          for (const change of block.proposal.changes) {
            pending.push(
              annotationLine(change.relativePath, 'pending', change),
            );
          }
        } else if (block.status === 'applied') {
          for (const change of block.proposal.changes) {
            applied.push(
              annotationLine(change.relativePath, 'applied', change),
            );
          }
        }
      } else if (isFileProposalBlock(block)) {
        if (block.status === 'pending') {
          pending.push(
            `- file pending ${block.suggestedRelativePath} ${block.operation ?? 'write'}`,
          );
        } else if (block.status === 'applied') {
          applied.push(
            `- file applied ${block.suggestedRelativePath} ${block.operation ?? 'write'}`,
          );
        }
      }
    }
  }
  if (pending.length === 0 && applied.length === 0) return '';
  return [
    ...section('【已应用】', '已 Keep All，已写盘。', applied),
    ...section(
      '【未确认提案】',
      '未 Keep All，未写盘。磁盘可能没有这些框，以本列表为准。',
      pending,
    ),
  ].join('\n');
}

export function collectPendingAnnotationChanges(
  messages: ChatMessage[],
): AnnotationBatchChange[] {
  const changes: AnnotationBatchChange[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.blocks) {
      if (block.type === 'annotation_proposal' && block.status === 'pending') {
        changes.push(...block.proposal.changes);
      }
    }
  }
  return changes;
}

/**
 * 提案结构化状态（与 buildProposalLedger 同源），注入 client_context.proposal_states，
 * 供后端任务阶段机推导门禁。undone 透传，后端按非约束状态处理。
 */
export function buildProposalStates(
  messages: ChatMessage[],
): ProposalStateEntry[] {
  const states: ProposalStateEntry[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.blocks) {
      if (block.type === 'annotation_proposal') {
        for (const change of block.proposal.changes) {
          const annotationIds: string[] = [];
          if (change.annotations) {
            for (const ann of change.annotations) {
              if (ann.id) annotationIds.push(ann.id);
            }
          }
          if (change.deleteIds) {
            annotationIds.push(...change.deleteIds.filter(Boolean));
          }
          if (change.patches) {
            for (const patch of change.patches) {
              if (patch.id) annotationIds.push(patch.id);
            }
          }
          states.push({
            path: change.relativePath,
            kind: 'annotation',
            status: block.status,
            operation: change.operation,
            annotationIds,
          });
        }
      } else if (isFileProposalBlock(block)) {
        states.push({
          path: block.suggestedRelativePath,
          kind: 'file',
          status: block.status,
          operation: block.operation ?? 'write',
        });
      }
    }
  }
  return states;
}
