import type {
  AnnotationBatchChange,
  BatchAnnotationPlan,
} from '../../../shared/annotationAgentTypes';
import type { AnnotationInstance } from '../../types/annotationDocument';
import { validateMappingsForFinalize } from './boxValidation';
import type {
  GeometryInstance,
  NormBox,
  PolygonPayload,
  PosePayload,
  RotatedBboxPayload,
} from './geometryTypes';

type MappingRow = { box_index: number; label_id: string; reason?: string };

function labelIdForInstance(
  instanceIndex: number,
  mappings: MappingRow[],
  validLabelIds: Set<string>,
  presetLabelId: string | null,
  allowUnlabeled: boolean,
): string | null {
  const mapped = mappings.find((m) => m.box_index === instanceIndex);
  const lid = (mapped?.label_id ?? presetLabelId ?? '').trim();
  if (!lid) return allowUnlabeled ? null : null;
  return validLabelIds.has(lid) ? lid : null;
}

export function buildAnnotationsFromGeometry(
  instances: GeometryInstance[],
  mappings: MappingRow[],
  validLabelIds: Set<string>,
  options?: { allowUnlabeled?: boolean },
): AnnotationInstance[] {
  const allowUnlabeled = options?.allowUnlabeled !== false;
  const now = new Date().toISOString();
  const out: AnnotationInstance[] = [];

  for (const inst of instances) {
    const preset =
      inst.geometry_kind === 'pose'
        ? (inst.payload as PosePayload).presetLabelId
        : null;
    const labelId = labelIdForInstance(
      inst.instance_index,
      mappings,
      validLabelIds,
      preset ?? null,
      allowUnlabeled,
    );
    if (!labelId && !allowUnlabeled) continue;

    switch (inst.geometry_kind) {
      case 'bbox': {
        const box = inst.payload as NormBox;
        out.push({
          id: crypto.randomUUID(),
          kind: 'bbox',
          labelId,
          createdAt: now,
          updatedAt: now,
          source: 'preannot',
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
        });
        break;
      }
      case 'rotated_bbox': {
        const obb = inst.payload as RotatedBboxPayload;
        out.push({
          id: crypto.randomUUID(),
          kind: 'rotated_bbox',
          labelId,
          createdAt: now,
          updatedAt: now,
          source: 'preannot',
          cx: obb.cx,
          cy: obb.cy,
          width: obb.width,
          height: obb.height,
          angle: obb.angle,
        });
        break;
      }
      case 'polygon': {
        const poly = inst.payload as PolygonPayload;
        out.push({
          id: crypto.randomUUID(),
          kind: 'polygon',
          labelId,
          createdAt: now,
          updatedAt: now,
          source: 'preannot',
          points: poly.points,
        });
        break;
      }
      case 'pose': {
        const pose = inst.payload as PosePayload;
        out.push({
          id: crypto.randomUUID(),
          kind: 'pose',
          labelId,
          createdAt: now,
          updatedAt: now,
          source: 'preannot',
          templateId: pose.templateId,
          cx: pose.cx,
          cy: pose.cy,
          width: pose.width,
          height: pose.height,
          angle: pose.angle,
          keypoints: pose.keypoints,
        });
        break;
      }
      default:
        break;
    }
  }

  return out;
}

export function tryAutoFinalizeFromGeometry(options: {
  plan: BatchAnnotationPlan;
  imageRelativePath: string;
  imageAbsolutePath: string;
  instances: GeometryInstance[];
  mappings: MappingRow[];
  labelCandidates: Array<{ id: string; name: string }>;
}): {
  ok: boolean;
  change?: AnnotationBatchChange;
  reason?: string;
  mappedCount: number;
  unlabeledInProposal?: number;
} {
  const mapBoxes = options.instances.map((inst) => ({
    box_index: inst.instance_index,
  }));
  const validIds = new Set(options.labelCandidates.map((l) => l.id));
  const validation = validateMappingsForFinalize(
    mapBoxes,
    options.mappings,
    validIds,
  );

  const constraints = options.plan.sub_agent_constraints;
  const allowUnlabeled = constraints.allow_unlabeled_boxes !== false;
  const minLabeled = constraints.min_labeled_box_count ?? 1;

  const annotations = buildAnnotationsFromGeometry(
    options.instances,
    options.mappings,
    validIds,
    { allowUnlabeled },
  );

  const mappedCount = validation.labeledCount;
  const unlabeledInProposal = annotations.filter(
    (a) => a.labelId == null,
  ).length;

  if (!validation.valid && mappedCount < minLabeled) {
    return {
      ok: false,
      reason:
        validation.errors.join('；') ||
        `成功映射 ${mappedCount} 个实例，不足 ${minLabeled}`,
      mappedCount,
      unlabeledInProposal,
    };
  }

  if (mappedCount < minLabeled && unlabeledInProposal === 0) {
    return {
      ok: false,
      reason: `成功映射 ${mappedCount} 个实例，不足 min_labeled_box_count=${minLabeled}`,
      mappedCount,
      unlabeledInProposal,
    };
  }

  if (annotations.length === 0) {
    return {
      ok: false,
      reason: '无实例可写入提案',
      mappedCount,
      unlabeledInProposal: 0,
    };
  }

  return {
    ok: true,
    mappedCount,
    unlabeledInProposal,
    change: {
      relativePath: options.imageRelativePath,
      absolutePath: options.imageAbsolutePath,
      operation: 'append',
      annotations,
    },
  };
}
