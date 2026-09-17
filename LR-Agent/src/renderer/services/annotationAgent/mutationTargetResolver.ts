import {
  parseFileAnnotationDocument,
  type AnnotationInstance,
  type CaptionGranularity,
  type ConversationTurn,
  type CotStep,
  type PoseKeypoint,
} from '../../types/annotationDocument';
import type { LabelDefinition } from '../../types/annotation';

export type MutationTargetBy =
  | 'id'
  | 'label_name'
  | 'index'
  | 'spatial'
  | 'selected'
  | 'all'
  | 'unlabeled'
  | 'granularity'
  | 'language'
  | 'longest'
  | 'shortest'
  | 'duplicate_label';

export interface MutationTargetSpec {
  by: MutationTargetBy;
  id?: string;
  label_name?: string;
  index?: number;
  hint?: string;
  granularity?: string;
  language?: string;
}

export type MutationKind =
  'patch_label' | 'patch_geometry' | 'patch_content' | 'delete';

export interface MutationOperationSpec {
  relative_path: string;
  mutation_kind: MutationKind;
  targets: MutationTargetSpec[];
  new_label_name?: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** rotated_bbox / pose：中心点与旋转角 */
  cx?: number;
  cy?: number;
  angle?: number;
  points?: { x: number; y: number }[];
  /** pose 关键点（整表替换） */
  keypoints?: PoseKeypoint[];
  text?: string;
  granularity?: CaptionGranularity;
  language?: string;
  steps?: CotStep[];
  answer?: string;
  instruction?: string;
  input?: string;
  output?: string;
  /** span_ner 文本偏移 */
  start?: number;
  end?: number;
  /** preference */
  prompt?: string;
  chosen?: string;
  rejected?: string;
  /** conversation（整表替换） */
  turns?: ConversationTurn[];
  note?: string;
}

const MUTATION_KINDS = new Set<MutationKind>([
  'patch_label',
  'patch_geometry',
  'patch_content',
  'delete',
]);
const TARGET_BY = new Set<MutationTargetBy>([
  'id',
  'label_name',
  'index',
  'spatial',
  'selected',
  'all',
  'unlabeled',
  'granularity',
  'language',
  'longest',
  'shortest',
  'duplicate_label',
]);
const GRANULARITIES = new Set(['brief', 'detailed', 'dense']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function parseOptionalOffset(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
    ? raw
    : undefined;
}

function parseKeypoints(raw: unknown): PoseKeypoint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const keypoints: PoseKeypoint[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return undefined;
    if (typeof item.x !== 'number' || typeof item.y !== 'number') {
      return undefined;
    }
    const visibility =
      item.visibility === 0 || item.visibility === 1 || item.visibility === 2
        ? item.visibility
        : 2;
    keypoints.push({ x: item.x, y: item.y, visibility });
  }
  return keypoints.length ? keypoints : undefined;
}

function parseTurns(raw: unknown): ConversationTurn[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const turns: ConversationTurn[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return undefined;
    if (
      (item.role !== 'user' && item.role !== 'assistant') ||
      typeof item.content !== 'string' ||
      !item.content.trim()
    ) {
      return undefined;
    }
    turns.push({ role: item.role, content: item.content });
  }
  return turns.length ? turns : undefined;
}

function parsePoints(raw: unknown): { x: number; y: number }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const points: { x: number; y: number }[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return undefined;
    if (typeof item.x !== 'number' || typeof item.y !== 'number') {
      return undefined;
    }
    points.push({ x: item.x, y: item.y });
  }
  return points.length ? points : undefined;
}

function parseSteps(raw: unknown): CotStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: CotStep[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return undefined;
    if (
      typeof item.description !== 'string' ||
      typeof item.conclusion !== 'string'
    ) {
      return undefined;
    }
    steps.push({
      description: item.description.trim(),
      conclusion: item.conclusion.trim(),
    });
  }
  return steps.length ? steps : undefined;
}

function parseMutationTarget(raw: unknown): MutationTargetSpec | null {
  if (
    !isRecord(raw) ||
    typeof raw.by !== 'string' ||
    !TARGET_BY.has(raw.by as MutationTargetBy)
  ) {
    return null;
  }
  const by = raw.by as MutationTargetBy;
  const target: MutationTargetSpec = { by };
  if (typeof raw.id === 'string' && raw.id.trim()) target.id = raw.id;
  if (typeof raw.label_name === 'string' && raw.label_name.trim()) {
    target.label_name = raw.label_name;
  }
  if (typeof raw.index === 'number' && Number.isFinite(raw.index)) {
    target.index = raw.index;
  }
  if (typeof raw.hint === 'string' && raw.hint.trim()) target.hint = raw.hint;
  if (typeof raw.granularity === 'string' && raw.granularity.trim()) {
    target.granularity = raw.granularity.trim();
  }
  if (typeof raw.language === 'string' && raw.language.trim()) {
    target.language = raw.language.trim();
  }

  if (by === 'id' && !target.id) return null;
  if (by === 'index' && target.index == null) return null;
  if (by === 'label_name' && !target.label_name) return null;
  if (by === 'spatial' && !target.hint) return null;
  if (by === 'granularity' && !target.granularity) return null;
  if (by === 'language' && !target.language) return null;
  return target;
}

export function parseMutationOperation(
  raw: unknown,
): MutationOperationSpec | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.relative_path !== 'string' || !raw.relative_path.trim()) {
    return null;
  }
  if (
    typeof raw.mutation_kind !== 'string' ||
    !MUTATION_KINDS.has(raw.mutation_kind as MutationKind)
  ) {
    return null;
  }
  if (!Array.isArray(raw.targets)) return null;

  const targets = raw.targets
    .map(parseMutationTarget)
    .filter((t): t is MutationTargetSpec => t != null);
  if (targets.length !== raw.targets.length) return null;

  const spec: MutationOperationSpec = {
    relative_path: raw.relative_path,
    mutation_kind: raw.mutation_kind as MutationKind,
    targets,
  };
  if (raw.new_label_name === null || typeof raw.new_label_name === 'string') {
    spec.new_label_name = raw.new_label_name;
  }
  const x = parseOptionalNumber(raw.x);
  const y = parseOptionalNumber(raw.y);
  const width = parseOptionalNumber(raw.width);
  const height = parseOptionalNumber(raw.height);
  if (x !== undefined) spec.x = x;
  if (y !== undefined) spec.y = y;
  if (width !== undefined) spec.width = width;
  if (height !== undefined) spec.height = height;
  const points = parsePoints(raw.points);
  if (points) spec.points = points;
  if (typeof raw.text === 'string') spec.text = raw.text;
  if (
    typeof raw.granularity === 'string' &&
    GRANULARITIES.has(raw.granularity)
  ) {
    spec.granularity = raw.granularity as CaptionGranularity;
  }
  if (typeof raw.language === 'string' && raw.language.trim()) {
    spec.language = raw.language.trim();
  }
  const steps = parseSteps(raw.steps);
  if (steps) spec.steps = steps;
  if (typeof raw.answer === 'string') spec.answer = raw.answer;
  if (typeof raw.instruction === 'string') spec.instruction = raw.instruction;
  if (typeof raw.input === 'string') spec.input = raw.input;
  if (typeof raw.output === 'string') spec.output = raw.output;
  const cx = parseOptionalNumber(raw.cx);
  const cy = parseOptionalNumber(raw.cy);
  const angle = parseOptionalNumber(raw.angle);
  if (cx !== undefined) spec.cx = cx;
  if (cy !== undefined) spec.cy = cy;
  if (angle !== undefined) spec.angle = angle;
  const keypoints = parseKeypoints(raw.keypoints);
  if (keypoints) spec.keypoints = keypoints;
  const start = parseOptionalOffset(raw.start);
  const end = parseOptionalOffset(raw.end);
  if (start !== undefined) spec.start = start;
  if (end !== undefined) spec.end = end;
  if (typeof raw.prompt === 'string') spec.prompt = raw.prompt;
  if (typeof raw.chosen === 'string') spec.chosen = raw.chosen;
  if (typeof raw.rejected === 'string') spec.rejected = raw.rejected;
  const turns = parseTurns(raw.turns);
  if (turns) spec.turns = turns;
  if (typeof raw.note === 'string') spec.note = raw.note;
  return spec;
}

export interface ResolveTargetsResult {
  ids: string[];
  errors: string[];
}

function instanceCenter(
  ann: AnnotationInstance,
): { cx: number; cy: number; area: number } | null {
  if (ann.kind === 'bbox') {
    return {
      cx: ann.x + ann.width / 2,
      cy: ann.y + ann.height / 2,
      area: ann.width * ann.height,
    };
  }
  if (ann.kind === 'rotated_bbox' || ann.kind === 'pose') {
    return { cx: ann.cx, cy: ann.cy, area: ann.width * ann.height };
  }
  if (ann.kind === 'polygon' && ann.points.length > 0) {
    const xs = ann.points.map((p) => p.x);
    const ys = ann.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      area: Math.max(0, maxX - minX) * Math.max(0, maxY - minY),
    };
  }
  return null;
}

function labelNameForId(
  labelId: string | null,
  labels: LabelDefinition[],
): string | null {
  if (!labelId) return null;
  return labels.find((l) => l.id === labelId)?.name ?? null;
}

function filterByLabelName(
  items: AnnotationInstance[],
  labelName: string,
  labels: LabelDefinition[],
): AnnotationInstance[] {
  const needle = labelName.trim().toLowerCase();
  return items.filter((ann) => {
    const name = labelNameForId(ann.labelId, labels);
    return name?.toLowerCase() === needle;
  });
}

function applySpatialHint(
  candidates: AnnotationInstance[],
  hint: string | undefined,
): AnnotationInstance[] {
  if (!hint || candidates.length === 0) return candidates;
  const withCenter = candidates
    .map((a) => ({ ann: a, center: instanceCenter(a) }))
    .filter(
      (
        row,
      ): row is {
        ann: AnnotationInstance;
        center: { cx: number; cy: number; area: number };
      } => row.center != null,
    );
  if (withCenter.length === 0) return [];
  const h = hint.toLowerCase();
  if (h.includes('left') || h.includes('左')) {
    const minCx = Math.min(...withCenter.map((r) => r.center.cx));
    return withCenter.filter((r) => r.center.cx === minCx).map((r) => r.ann);
  }
  if (h.includes('right') || h.includes('右')) {
    const maxCx = Math.max(...withCenter.map((r) => r.center.cx));
    return withCenter.filter((r) => r.center.cx === maxCx).map((r) => r.ann);
  }
  if (h.includes('largest') || h.includes('最大') || h.includes('biggest')) {
    const maxArea = Math.max(...withCenter.map((r) => r.center.area));
    return withCenter
      .filter((r) => r.center.area === maxArea)
      .map((r) => r.ann);
  }
  return withCenter.map((r) => r.ann);
}

function contentLength(ann: AnnotationInstance): number {
  if (ann.kind === 'caption') return ann.text.length;
  if (ann.kind === 'cot') {
    return (
      (ann.answer?.length ?? 0) +
      ann.steps.reduce(
        (n, step) => n + step.description.length + step.conclusion.length,
        0,
      )
    );
  }
  return 0;
}

function captionLang(ann: AnnotationInstance): string {
  return ann.kind === 'caption' ? (ann.language || 'zh').toLowerCase() : '';
}

function pickExtreme(
  items: AnnotationInstance[],
  mode: 'longest' | 'shortest',
): AnnotationInstance[] {
  if (items.length === 0) return [];
  const scored = items.map((ann) => ({ ann, len: contentLength(ann) }));
  const target =
    mode === 'longest'
      ? Math.max(...scored.map((s) => s.len))
      : Math.min(...scored.map((s) => s.len));
  return scored.filter((s) => s.len === target).map((s) => s.ann);
}

function duplicateLabelIds(items: AnnotationInstance[]): string[] {
  const seen = new Set<string>();
  const extras: string[] = [];
  for (const ann of items) {
    if (!ann.labelId) continue;
    if (seen.has(ann.labelId)) {
      extras.push(ann.id);
    } else {
      seen.add(ann.labelId);
    }
  }
  return extras;
}

export function resolveMutationTargets(
  annotations: AnnotationInstance[],
  targets: MutationTargetSpec[],
  labels: LabelDefinition[],
  selectedAnnotationIds: string[],
): ResolveTargetsResult {
  const errors: string[] = [];
  const resolved = new Set<string>();

  for (const target of targets) {
    if (target.by === 'all') {
      for (const ann of annotations) resolved.add(ann.id);
      continue;
    }

    if (target.by === 'selected') {
      for (const id of selectedAnnotationIds) {
        if (annotations.some((a) => a.id === id)) resolved.add(id);
      }
      continue;
    }

    if (target.by === 'id' && target.id) {
      if (annotations.some((a) => a.id === target.id)) {
        resolved.add(target.id);
      } else {
        errors.push(`未找到 id ${target.id}`);
      }
      continue;
    }

    if (target.by === 'index' && target.index != null) {
      const idx = Math.max(1, Math.floor(target.index)) - 1;
      const item = annotations[idx];
      if (item) {
        resolved.add(item.id);
      } else {
        errors.push(`序号 ${target.index} 超出范围`);
      }
      continue;
    }

    if (target.by === 'unlabeled') {
      const unlabeled = annotations.filter((a) => a.labelId == null);
      if (unlabeled.length === 0) {
        errors.push('没有未打标签的标注');
        continue;
      }
      for (const ann of unlabeled) resolved.add(ann.id);
      continue;
    }

    if (target.by === 'duplicate_label') {
      const classifiable = annotations.filter(
        (a) => a.kind === 'text_classification' || a.kind === 'classification',
      );
      if (classifiable.length === 0) {
        errors.push('duplicate_label 仅用于分类标注');
        continue;
      }
      const extras = duplicateLabelIds(classifiable);
      if (extras.length === 0) {
        errors.push('没有重复标签的标注');
        continue;
      }
      for (const id of extras) resolved.add(id);
      continue;
    }

    let pool = [...annotations];

    if (target.by === 'label_name' && target.label_name) {
      pool = filterByLabelName(pool, target.label_name, labels);
      if (pool.length === 0) {
        errors.push(`无标签为 ${target.label_name} 的标注`);
        continue;
      }
    }

    if (target.by === 'granularity' || target.granularity) {
      const gran = (target.granularity ?? '').toLowerCase();
      pool = pool.filter((a) => a.kind === 'caption' && a.granularity === gran);
      if (pool.length === 0) {
        errors.push(`无粒度为 ${target.granularity} 的描述`);
        continue;
      }
    }

    if (target.by === 'language' || target.language) {
      const lang = (target.language ?? '').toLowerCase();
      pool = pool.filter((a) => captionLang(a) === lang);
      if (pool.length === 0) {
        errors.push(`无语言为 ${target.language} 的描述`);
        continue;
      }
    }

    if (target.by === 'longest' || target.by === 'shortest') {
      pool = pickExtreme(pool, target.by);
      if (pool.length === 0) {
        errors.push(`无法按${target.by === 'longest' ? '最长' : '最短'}定位`);
        continue;
      }
    }

    if (target.by === 'spatial' || target.hint) {
      pool = applySpatialHint(pool, target.hint);
      if (pool.length === 0) {
        errors.push('空间指代未匹配到标注');
        continue;
      }
    }

    if (pool.length === 0) {
      errors.push('未匹配到标注');
      continue;
    }

    for (const ann of pool) resolved.add(ann.id);
  }

  return { ids: [...resolved], errors };
}

export async function readAnnotationsForPath(
  projectDir: string,
  relativePath: string,
): Promise<AnnotationInstance[]> {
  const raw = await window.electron?.annotation?.readFileAnnotationDoc(
    projectDir,
    relativePath,
  );
  if (!raw) return [];
  const parsed = parseFileAnnotationDocument(raw);
  return parsed?.annotations ?? [];
}

export function labelIdByName(
  name: string | null | undefined,
  labels: LabelDefinition[],
): string | null {
  if (!name?.trim()) return null;
  const needle = name.trim().toLowerCase();
  return labels.find((l) => l.name.toLowerCase() === needle)?.id ?? null;
}

export function buildAnnotationDigest(
  relativePath: string,
  annotations: AnnotationInstance[],
  labels: LabelDefinition[],
): string {
  const lines = annotations.slice(0, 40).map((ann) => {
    const name =
      labelNameForId(ann.labelId, labels) ??
      (ann.labelId == null ? 'unlabeled' : ann.labelId);
    if (ann.kind === 'bbox') {
      return `  - id=${ann.id} kind=bbox label=${name} box=${ann.x.toFixed(3)},${ann.y.toFixed(3)},${ann.width.toFixed(3)},${ann.height.toFixed(3)}`;
    }
    if (ann.kind === 'polygon') {
      return `  - id=${ann.id} kind=polygon label=${name} points=${ann.points.length}`;
    }
    if (ann.kind === 'caption') {
      return `  - id=${ann.id} kind=caption gran=${ann.granularity} lang=${ann.language ?? 'zh'} text=${ann.text.slice(0, 40)}`;
    }
    if (ann.kind === 'cot') {
      return `  - id=${ann.id} kind=cot steps=${ann.steps.length} answer=${ann.answer.slice(0, 40)}`;
    }
    if (ann.kind === 'text_classification' || ann.kind === 'classification') {
      return `  - id=${ann.id} kind=${ann.kind} label=${name}`;
    }
    return `  - id=${ann.id} kind=${ann.kind} label=${name}`;
  });
  return `${relativePath} (${annotations.length}):\n${lines.join('\n') || '  （空）'}`;
}
