import {
  FILE_ANNOTATION_SCHEMA_VERSION,
  parseFileAnnotationDocument,
  type AnnotationInstance,
  type BboxAnnotation,
  type FileAnnotationDocument,
} from '../types/annotationDocument';
import {
  MAX_MUTATIONS_PER_PROPOSAL,
  type AnnotationBatchChange,
  type AnnotationBatchProposal,
  type AnnotationPatch,
} from '../../shared/annotationAgentTypes';
import type { AnnotationProject, LabelDefinition } from '../types/annotation';

export interface SourceFreshnessHint {
  mtimeMs?: number;
  size?: number;
}

export interface MutationValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ApplyMutationsResult {
  appliedFiles: number;
  appliedBoxes: number;
  appliedPatches: number;
  appliedDeletes: number;
  relativePaths: string[];
}

async function statsForPath(absPath: string): Promise<SourceFreshnessHint> {
  const s = await window.electron.fileSystem?.getFileStats(absPath);
  if (!s || s.isDirectory) return {};
  return { mtimeMs: s.mtime.getTime(), size: s.size };
}

export function checkSourceFreshness(
  stored: SourceFreshnessHint | undefined,
  current: SourceFreshnessHint,
): { fresh: boolean; reason?: string } {
  if (stored?.mtimeMs == null || current.mtimeMs == null) {
    return { fresh: true };
  }
  if (stored.mtimeMs !== current.mtimeMs) {
    return {
      fresh: false,
      reason: '源图片文件已变更，请先保存工作区或刷新后再应用',
    };
  }
  if (
    stored.size != null &&
    current.size != null &&
    stored.size !== current.size
  ) {
    return {
      fresh: false,
      reason: '源图片文件大小已变化，请先保存工作区或刷新后再应用',
    };
  }
  return { fresh: true };
}

function labelIdSet(labels: LabelDefinition[]): Set<string> {
  return new Set(labels.map((l) => l.id));
}

function countMutationsInChange(change: AnnotationBatchChange): number {
  switch (change.operation) {
    case 'append':
    case 'replace':
    case 'replace_bboxes':
      return change.annotations?.length ?? 0;
    case 'patch':
      return change.patches?.length ?? 0;
    case 'delete':
      return change.deleteIds?.length ?? 0;
    default:
      return 0;
  }
}

export function validateMutations(
  doc: FileAnnotationDocument | null,
  change: AnnotationBatchChange,
  projectLabels: LabelDefinition[],
): MutationValidationResult {
  const errors: string[] = [];
  const validLabelIds = labelIdSet(projectLabels);
  const existingIds = new Set((doc?.annotations ?? []).map((a) => a.id));
  const mutationCount = countMutationsInChange(change);

  if (mutationCount === 0) {
    errors.push(`${change.relativePath}: 变更项为空`);
  }
  if (mutationCount > MAX_MUTATIONS_PER_PROPOSAL) {
    errors.push(
      `${change.relativePath}: 单次变更超过上限 ${MAX_MUTATIONS_PER_PROPOSAL}`,
    );
  }

  const op = change.operation;

  if (op === 'append' || op === 'replace' || op === 'replace_bboxes') {
    const annotations = change.annotations ?? [];
    if (annotations.length === 0) {
      errors.push(`${change.relativePath}: append/replace 需要 annotations`);
    }
    for (const ann of annotations) {
      if (ann.labelId != null && !validLabelIds.has(ann.labelId)) {
        errors.push(`${change.relativePath}: 未知标签 id ${ann.labelId}`);
      }
    }
    if ((op === 'replace' || op === 'replace_bboxes') && !doc) {
      errors.push(`${change.relativePath}: replace 需要已有标注文档`);
    }
  }

  if (op === 'patch') {
    const patches = change.patches ?? [];
    if (patches.length === 0) {
      errors.push(`${change.relativePath}: patch 需要 patches`);
    }
    if (!doc) {
      errors.push(`${change.relativePath}: patch 需要已有标注文档`);
    }
    for (const patch of patches) {
      if (!patch.id?.trim()) {
        errors.push(`${change.relativePath}: patch 缺少 id`);
        continue;
      }
      if (!existingIds.has(patch.id)) {
        errors.push(`${change.relativePath}: 未找到标注 id ${patch.id}`);
      }
      if (patch.labelId != null && !validLabelIds.has(patch.labelId)) {
        errors.push(`${change.relativePath}: 未知标签 id ${patch.labelId}`);
      }
      if (!patchHasPayload(patch)) {
        errors.push(`${change.relativePath}: patch ${patch.id} 无有效字段`);
      }
      errors.push(
        ...validatePatchGeometry(patch).map(
          (msg) => `${change.relativePath}: ${msg}`,
        ),
      );
      const existing = (doc?.annotations ?? []).find((a) => a.id === patch.id);
      if (existing) {
        errors.push(
          ...validatePatchForKind(existing, patch).map(
            (msg) => `${change.relativePath}: ${msg}`,
          ),
        );
      }
    }
  }

  if (op === 'delete') {
    const ids = change.deleteIds ?? [];
    if (ids.length === 0) {
      errors.push(`${change.relativePath}: delete 需要 deleteIds`);
    }
    if (!doc) {
      errors.push(`${change.relativePath}: delete 需要已有标注文档`);
    }
    for (const id of ids) {
      if (!existingIds.has(id)) {
        errors.push(`${change.relativePath}: 未找到标注 id ${id}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function isNormCoord(n: number | undefined): boolean {
  return n === undefined || (Number.isFinite(n) && n >= 0 && n <= 1);
}

function isNormSize(n: number | undefined): boolean {
  return n === undefined || (Number.isFinite(n) && n > 0 && n <= 1);
}

export function patchHasPayload(patch: AnnotationPatch): boolean {
  return (
    patch.labelId !== undefined ||
    patch.note !== undefined ||
    patch.x !== undefined ||
    patch.y !== undefined ||
    patch.width !== undefined ||
    patch.height !== undefined ||
    patch.cx !== undefined ||
    patch.cy !== undefined ||
    patch.angle !== undefined ||
    (patch.points != null && patch.points.length >= 3) ||
    (patch.keypoints != null && patch.keypoints.length > 0) ||
    patch.start !== undefined ||
    patch.end !== undefined ||
    patch.text !== undefined ||
    patch.granularity !== undefined ||
    patch.language !== undefined ||
    patch.steps !== undefined ||
    patch.answer !== undefined ||
    patch.instruction !== undefined ||
    patch.input !== undefined ||
    patch.output !== undefined ||
    patch.prompt !== undefined ||
    patch.chosen !== undefined ||
    patch.rejected !== undefined ||
    (patch.turns != null && patch.turns.length > 0)
  );
}

function validatePatchGeometry(patch: AnnotationPatch): string[] {
  const errors: string[] = [];
  if (
    !isNormCoord(patch.x) ||
    !isNormCoord(patch.y) ||
    !isNormCoord(patch.cx) ||
    !isNormCoord(patch.cy)
  ) {
    errors.push(`patch ${patch.id} 坐标必须在 0–1`);
  }
  if (!isNormSize(patch.width) || !isNormSize(patch.height)) {
    errors.push(`patch ${patch.id} 宽高必须在 (0, 1]`);
  }
  if (patch.angle !== undefined && !Number.isFinite(patch.angle)) {
    errors.push(`patch ${patch.id} 旋转角必须是有限数值`);
  }
  if (patch.points) {
    if (patch.points.length < 3) {
      errors.push(`patch ${patch.id} 多边形至少 3 个点`);
    }
    if (patch.points.some((p) => !isNormCoord(p.x) || !isNormCoord(p.y))) {
      errors.push(`patch ${patch.id} 多边形顶点必须在 0–1`);
    }
  }
  if (patch.keypoints) {
    if (
      patch.keypoints.some((kp) => !isNormCoord(kp.x) || !isNormCoord(kp.y))
    ) {
      errors.push(`patch ${patch.id} 关键点坐标必须在 0–1`);
    }
  }
  if (
    patch.start !== undefined &&
    patch.end !== undefined &&
    patch.start >= patch.end
  ) {
    errors.push(`patch ${patch.id} span 偏移必须满足 start < end`);
  }
  if (patch.turns) {
    if (patch.turns.some((t) => !t.content.trim())) {
      errors.push(`patch ${patch.id} 对话轮次内容不能为空`);
    }
  }
  return errors;
}

function validatePatchForKind(
  ann: AnnotationInstance,
  patch: AnnotationPatch,
): string[] {
  const errors: string[] = [];
  const hasCaption =
    patch.text !== undefined ||
    patch.granularity !== undefined ||
    patch.language !== undefined;
  const hasCot = patch.steps !== undefined || patch.answer !== undefined;
  const hasCenter = patch.cx !== undefined || patch.cy !== undefined;
  const hasRotatableSize =
    patch.width !== undefined || patch.height !== undefined;

  if (patch.points && ann.kind !== 'polygon') {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入多边形点`);
  }
  if ((patch.x !== undefined || patch.y !== undefined) && ann.kind !== 'bbox') {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入 bbox 左上角几何`);
  }
  if (
    hasRotatableSize &&
    ann.kind !== 'bbox' &&
    ann.kind !== 'rotated_bbox' &&
    ann.kind !== 'pose'
  ) {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入宽高`);
  }
  if (
    (hasCenter || patch.angle !== undefined) &&
    ann.kind !== 'rotated_bbox' &&
    ann.kind !== 'pose'
  ) {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入中心点/旋转角`);
  }
  if (patch.keypoints && ann.kind !== 'pose') {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入关键点`);
  }
  if (hasCaption && ann.kind !== 'caption') {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入 caption 字段`);
  }
  if (hasCot && ann.kind !== 'cot') {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入 CoT 字段`);
  }
  if (
    patch.instruction !== undefined &&
    ann.kind !== 'cot' &&
    ann.kind !== 'instruction'
  ) {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入 instruction 字段`);
  }
  if (
    (patch.input !== undefined || patch.output !== undefined) &&
    ann.kind !== 'instruction'
  ) {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入 input/output 字段`);
  }
  if (
    (patch.start !== undefined || patch.end !== undefined) &&
    ann.kind !== 'span_ner'
  ) {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入 span 偏移`);
  }
  if (
    (patch.prompt !== undefined ||
      patch.chosen !== undefined ||
      patch.rejected !== undefined) &&
    ann.kind !== 'preference'
  ) {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入 preference 字段`);
  }
  if (patch.turns && ann.kind !== 'conversation') {
    errors.push(`patch ${patch.id} 不能对 ${ann.kind} 写入对话轮次`);
  }
  if (patch.steps && patch.steps.length < 2) {
    errors.push(`patch ${patch.id} CoT 至少 2 步`);
  }
  return errors;
}

function applyPatchToAnnotation(
  ann: AnnotationInstance,
  patch: AnnotationPatch,
): AnnotationInstance {
  if (ann.id !== patch.id) return ann;
  const now = new Date().toISOString();
  const labelId = patch.labelId !== undefined ? patch.labelId : ann.labelId;
  const note = patch.note !== undefined ? patch.note : ann.note;

  if (ann.kind === 'bbox') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      x: patch.x ?? ann.x,
      y: patch.y ?? ann.y,
      width: patch.width ?? ann.width,
      height: patch.height ?? ann.height,
    };
  }
  if (ann.kind === 'polygon') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      points:
        patch.points && patch.points.length >= 3 ? patch.points : ann.points,
    };
  }
  if (ann.kind === 'caption') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      text: patch.text ?? ann.text,
      granularity: patch.granularity ?? ann.granularity,
      language: patch.language ?? ann.language,
    };
  }
  if (ann.kind === 'cot') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      steps: patch.steps ?? ann.steps,
      answer: patch.answer ?? ann.answer,
      instruction:
        patch.instruction !== undefined ? patch.instruction : ann.instruction,
    };
  }
  if (ann.kind === 'rotated_bbox') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      cx: patch.cx ?? ann.cx,
      cy: patch.cy ?? ann.cy,
      width: patch.width ?? ann.width,
      height: patch.height ?? ann.height,
      angle: patch.angle ?? ann.angle,
    };
  }
  if (ann.kind === 'pose') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      cx: patch.cx ?? ann.cx,
      cy: patch.cy ?? ann.cy,
      width: patch.width ?? ann.width,
      height: patch.height ?? ann.height,
      angle: patch.angle ?? ann.angle,
      keypoints: patch.keypoints ?? ann.keypoints,
    };
  }
  if (ann.kind === 'span_ner') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      start: patch.start ?? ann.start,
      end: patch.end ?? ann.end,
    };
  }
  if (ann.kind === 'instruction') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      instruction: patch.instruction ?? ann.instruction,
      input: patch.input !== undefined ? patch.input : ann.input,
      output: patch.output ?? ann.output,
    };
  }
  if (ann.kind === 'preference') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      prompt: patch.prompt ?? ann.prompt,
      chosen: patch.chosen ?? ann.chosen,
      rejected: patch.rejected ?? ann.rejected,
    };
  }
  if (ann.kind === 'conversation') {
    return {
      ...ann,
      labelId,
      note,
      updatedAt: now,
      turns: patch.turns ?? ann.turns,
    };
  }
  return {
    ...ann,
    labelId,
    note,
    updatedAt: now,
  };
}

export function applyChangeToDoc(
  parsed: FileAnnotationDocument | null,
  change: AnnotationBatchChange,
  project: AnnotationProject,
  hint: SourceFreshnessHint = {},
): FileAnnotationDocument {
  const now = new Date().toISOString();
  const op = change.operation;

  if (!parsed) {
    if (op !== 'append') {
      throw new Error(`${change.relativePath}: 无法对不存在的文档执行 ${op}`);
    }
    return {
      schemaVersion: FILE_ANNOTATION_SCHEMA_VERSION,
      projectId: project.id,
      filePath: change.relativePath,
      modality: project.modality,
      annotationType: project.annotationType,
      source: hint.mtimeMs
        ? { width: 0, height: 0, mtimeMs: hint.mtimeMs, size: hint.size }
        : undefined,
      annotations: change.annotations ?? [],
      updatedAt: now,
    };
  }

  let annotations = [...parsed.annotations];

  if (op === 'append') {
    const existingIds = new Set(annotations.map((a) => a.id));
    const deduped = (change.annotations ?? []).filter(
      (ann) => !existingIds.has(ann.id),
    );
    annotations = [...annotations, ...deduped];
  } else if (op === 'replace_bboxes') {
    // Only replace bbox-type annotations, keep others
    const nonBbox = annotations.filter((a) => a.kind !== 'bbox');
    annotations = [...nonBbox, ...(change.annotations ?? [])];
  } else if (op === 'replace') {
    // Full replace: drop all existing annotations
    annotations = change.annotations ?? [];
  } else if (op === 'patch') {
    const patchMap = new Map(
      (change.patches ?? []).map((p) => [p.id, p] as const),
    );
    annotations = annotations.map((ann) => {
      const patch = patchMap.get(ann.id);
      return patch ? applyPatchToAnnotation(ann, patch) : ann;
    });
  } else if (op === 'delete') {
    const deleteSet = new Set(change.deleteIds ?? []);
    annotations = annotations.filter((ann) => !deleteSet.has(ann.id));
  }

  return {
    ...parsed,
    annotations,
    updatedAt: now,
  };
}

/** Merge multiple proposal changes for one file (in order) without persisting. */
export function mergeProposalChangesIntoDoc(
  parsed: FileAnnotationDocument | null,
  changes: AnnotationBatchChange[],
  project: AnnotationProject,
  hint: SourceFreshnessHint = {},
): FileAnnotationDocument {
  let doc = parsed;
  for (const change of changes) {
    doc = applyChangeToDoc(doc, change, project, hint);
  }
  if (!doc) {
    throw new Error(
      'mergeProposalChangesIntoDoc: no changes produced a document',
    );
  }
  return doc;
}

function groupChangesByPath(
  changes: AnnotationBatchChange[],
): Map<string, AnnotationBatchChange[]> {
  const groups = new Map<string, AnnotationBatchChange[]>();
  for (const change of changes) {
    const list = groups.get(change.relativePath) ?? [];
    list.push(change);
    groups.set(change.relativePath, list);
  }
  return groups;
}

/** Validate and fold changes for one file in memory; throw before any write. */
export function foldValidatedChangesIntoDoc(
  parsed: FileAnnotationDocument | null,
  changes: AnnotationBatchChange[],
  project: AnnotationProject,
  hint: SourceFreshnessHint = {},
): FileAnnotationDocument {
  let doc = parsed;
  for (const change of changes) {
    const validation = validateMutations(doc, change, project.labels);
    if (!validation.valid) {
      throw new Error(validation.errors.join('；'));
    }
    doc = applyChangeToDoc(doc, change, project, hint);
  }
  if (!doc) {
    throw new Error('foldValidatedChangesIntoDoc: no document produced');
  }
  return doc;
}

export async function applyMutations(
  project: AnnotationProject,
  changes: AnnotationBatchChange[],
  options?: {
    skipFreshnessCheck?: boolean;
    onFreshnessConflict?: (relativePath: string, reason: string) => boolean;
  },
): Promise<ApplyMutationsResult> {
  const projectDir = project.directoryPath;
  let appliedFiles = 0;
  let appliedBoxes = 0;
  let appliedPatches = 0;
  let appliedDeletes = 0;
  const relativePaths: string[] = [];

  for (const group of groupChangesByPath(changes).values()) {
    const first = group[0];
    if (!first) continue;
    const raw = await window.electron?.annotation?.readFileAnnotationDoc(
      projectDir,
      first.relativePath,
    );
    const parsed = raw ? parseFileAnnotationDocument(raw) : null;
    const hint = await statsForPath(first.absolutePath);
    if (!options?.skipFreshnessCheck && parsed?.source) {
      const freshness = checkSourceFreshness(parsed.source, hint);
      if (!freshness.fresh) {
        const proceed = options?.onFreshnessConflict?.(
          first.relativePath,
          freshness.reason ?? '文件已变更',
        );
        if (!proceed) {
          throw new Error(
            freshness.reason ??
              `${first.relativePath}: 源文件已变更，已取消应用`,
          );
        }
      }
    }

    const doc = foldValidatedChangesIntoDoc(parsed, group, project, hint);

    await window.electron?.annotation?.writeFileAnnotationDoc(
      projectDir,
      first.relativePath,
      doc,
      hint,
    );

    appliedFiles += 1;
    relativePaths.push(first.relativePath);

    for (const change of group) {
      if (
        change.operation === 'append' ||
        change.operation === 'replace' ||
        change.operation === 'replace_bboxes'
      ) {
        appliedBoxes += change.annotations?.length ?? 0;
      } else if (change.operation === 'patch') {
        appliedPatches += change.patches?.length ?? 0;
      } else if (change.operation === 'delete') {
        appliedDeletes += change.deleteIds?.length ?? 0;
      }
    }
  }

  return {
    appliedFiles,
    appliedBoxes,
    appliedPatches,
    appliedDeletes,
    relativePaths,
  };
}

export async function applyAnnotationBatchProposal(
  project: AnnotationProject,
  proposal: AnnotationBatchProposal,
  options?: {
    skipFreshnessCheck?: boolean;
    onFreshnessConflict?: (relativePath: string, reason: string) => boolean;
  },
): Promise<ApplyMutationsResult> {
  return applyMutations(project, proposal.changes, options);
}

export function dispatchMutationsAppliedEvent(
  projectId: string,
  relativePaths: string[],
  options?: { force?: boolean },
): void {
  const detail = {
    projectId,
    relativePaths,
    force: Boolean(options?.force),
  };
  window.dispatchEvent(
    new CustomEvent('lr-agent:annotation-mutations-applied', {
      detail,
    }),
  );
  // Backward compat for existing listeners
  window.dispatchEvent(
    new CustomEvent('lr-agent:annotation-batch-applied', {
      detail,
    }),
  );
}
