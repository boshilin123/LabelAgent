import type {
  AnnotationBatchChange,
  AnnotationProjectSnapshot,
} from '../../shared/annotationAgentTypes';

/** 单个文件的提案变更统计（注入客户端工具结果，供模型写报告时引用真实数字）。 */
export type AnnotationProposalFileStat = {
  path: string;
  operation: string;
  added: number;
  deleted: number;
  modified: number;
  labels: string[];
};

/**
 * 从提案 changes 构建逐文件统计。
 * 让 auto_annotate / mutate_annotation 的工具结果携带真实明细，
 * 避免模型在提案未落盘时只能估算框数。
 */
export function buildProposalFileStats(
  changes: AnnotationBatchChange[],
  labels: AnnotationProjectSnapshot['labels'] | undefined,
): AnnotationProposalFileStat[] {
  const labelNameById = new Map((labels ?? []).map((l) => [l.id, l.name]));
  return changes.map((change) => {
    const annotations = change.annotations ?? [];
    const labelNames = [
      ...new Set(
        annotations
          .map((ann) => ann.labelId)
          .filter((id): id is string => Boolean(id))
          .map((id) => labelNameById.get(id) ?? id),
      ),
    ];
    const isAddOperation =
      change.operation === 'append' ||
      change.operation === 'replace' ||
      change.operation === 'replace_bboxes';
    return {
      path: change.relativePath,
      operation: change.operation,
      added: isAddOperation ? annotations.length : 0,
      deleted:
        change.operation === 'delete'
          ? (change.deleteIds?.length ?? annotations.length)
          : 0,
      modified:
        change.operation === 'patch' ? (change.patches?.length ?? 0) : 0,
      labels: labelNames,
    };
  });
}

/** 把逐文件统计格式化为简短中文文本，附加到工具结果 summary。 */
export function formatFileStatsText(
  stats: AnnotationProposalFileStat[],
): string {
  if (stats.length === 0) return '';
  const lines = stats.map((stat) => {
    const parts: string[] = [];
    if (stat.added > 0) parts.push(`新增 ${stat.added}`);
    if (stat.deleted > 0) parts.push(`删除 ${stat.deleted}`);
    if (stat.modified > 0) parts.push(`修改 ${stat.modified}`);
    const labelText =
      stat.labels.length > 0 ? `（${stat.labels.join('、')}）` : '';
    return `${stat.path}: ${parts.join('，') || '无变更'}${labelText}`;
  });
  return `逐文件明细：${lines.join('；')}`;
}
