import type {
  BatchAnnotationPlan,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import type { ImageAnnotationType } from '../../types/annotation';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { assertPreAnnotResult, runPreAnnot } from '../preAnnotService';
import {
  isDetectResult,
  isPolygonResult,
  isPoseResult,
} from '../../../shared/preAnnotTypes';
import { pickDefaultPreAnnotModel } from '../../utils/preAnnotModelFilter';
import { resolveLabelIdForPoseTemplate } from '../../utils/preAnnotLabelMapping';
import { getKeypointTemplate } from '../../types/keypointTemplate';
import { filterDetectionBoxesByScope } from './detectionScope';
import { runObjectDetectionForSubAgent } from './fusionSubImageTools';
import type { GeometryAnnotationType, GeometryInstance } from './geometryTypes';
import { obbToAabb, pointsToAabb } from './geometryTypes';

export interface GeometryAdapterContext {
  keypointTemplateId?: string;
  labelCount: number;
  labels: Array<{ id: string; name: string }>;
}

export interface GeometryInferenceContext {
  image: ImageCandidate;
  plan: BatchAnnotationPlan;
  primaryModel: PretrainedModelConfig;
  secondaryModel?: PretrainedModelConfig | null;
  adapterContext: GeometryAdapterContext;
  onProgress?: (message: string) => void;
}

export interface GeometryPipelineAdapter {
  annotationType: GeometryAnnotationType;
  pickPrimaryModel: (
    models: PretrainedModelConfig[],
    ctx: GeometryAdapterContext,
  ) => PretrainedModelConfig | null;
  pickSecondaryModel?: (
    models: PretrainedModelConfig[],
    ctx: GeometryAdapterContext,
  ) => PretrainedModelConfig | null;
  runInference: (ctx: GeometryInferenceContext) => Promise<{
    instances: GeometryInstance[];
    rawCount: number;
    keptCount: number;
    excludedCount: number;
  }>;
  skipLabelMapping?: (ctx: GeometryAdapterContext) => boolean;
}

function normBoxToSamBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: box.x,
    y1: box.y,
    x2: box.x + box.width,
    y2: box.y + box.height,
  };
}

/** 从 plan.detection_hints 提取 conf/iou 阈值覆盖（无则不动模型默认值）。 */
function thresholdOverrides(plan: BatchAnnotationPlan): {
  overrides?: { confThreshold?: number; iouThreshold?: number };
} {
  const hints = plan.detection_hints;
  if (hints.conf_threshold === undefined && hints.iou_threshold === undefined) {
    return {};
  }
  return {
    overrides: {
      confThreshold: hints.conf_threshold,
      iouThreshold: hints.iou_threshold,
    },
  };
}

const bboxAdapter: GeometryPipelineAdapter = {
  annotationType: 'bbox',
  pickPrimaryModel: (models) => pickDefaultPreAnnotModel('bbox', models),
  runInference: async (ctx) => {
    const det = await runObjectDetectionForSubAgent(
      ctx.image,
      ctx.plan,
      ctx.primaryModel,
      {},
    );
    const instances: GeometryInstance[] = det.boxes.map((box) => ({
      instance_index: box.box_index,
      geometry_kind: 'bbox',
      class_name: box.class_name,
      confidence: box.confidence,
      crop_box: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
      payload: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
    }));
    return {
      instances,
      rawCount: det.rawCount,
      keptCount: det.keptCount,
      excludedCount: det.excludedCount,
    };
  },
};

const rotatedBboxAdapter: GeometryPipelineAdapter = {
  annotationType: 'rotated_bbox',
  pickPrimaryModel: (models) =>
    pickDefaultPreAnnotModel('rotated_bbox', models),
  runInference: async (ctx) => {
    const response = await runPreAnnot(
      'yolo_obb',
      ctx.image.absolutePath,
      ctx.primaryModel,
      thresholdOverrides(ctx.plan),
    );
    const result = assertPreAnnotResult(response, isDetectResult, 'OBB 检测');
    const rawItems = result.items.map((item, idx) => {
      const g = item.geometry;
      const cx = 'cx' in g ? g.cx : g.x + g.width / 2;
      const cy = 'cy' in g ? g.cy : g.y + g.height / 2;
      const angle = 'angle' in g ? g.angle : 0;
      return {
        box_index: idx,
        class_name: item.className,
        confidence: item.confidence,
        cx,
        cy,
        width: g.width,
        height: g.height,
        angle,
      };
    });
    const rawCount = rawItems.length;
    const scoped = filterDetectionBoxesByScope(
      rawItems.map((item) => ({
        box_index: item.box_index,
        class_name: item.class_name,
        confidence: item.confidence,
        x: item.cx - item.width / 2,
        y: item.cy - item.height / 2,
        width: item.width,
        height: item.height,
      })),
      ctx.plan.annotation_scope,
    );
    const instances: GeometryInstance[] = scoped.boxes.map((box, i) => {
      const src = rawItems[box.box_index] ?? rawItems[i];
      const cx = src?.cx ?? box.x + box.width / 2;
      const cy = src?.cy ?? box.y + box.height / 2;
      const width = src?.width ?? box.width;
      const height = src?.height ?? box.height;
      const angle = src?.angle ?? 0;
      return {
        instance_index: i,
        geometry_kind: 'rotated_bbox',
        class_name: src?.class_name ?? box.class_name,
        confidence: src?.confidence ?? box.confidence,
        crop_box: obbToAabb(cx, cy, width, height, angle),
        payload: { cx, cy, width, height, angle },
      };
    });
    return {
      instances,
      rawCount,
      keptCount: instances.length,
      excludedCount: scoped.excluded,
    };
  },
};

const polygonAdapter: GeometryPipelineAdapter = {
  annotationType: 'polygon',
  pickPrimaryModel: (models) => pickDefaultPreAnnotModel('polygon', models),
  pickSecondaryModel: (models) => pickDefaultPreAnnotModel('bbox', models),
  runInference: async (ctx) => {
    const detectModel = ctx.secondaryModel;
    if (!detectModel) {
      return { instances: [], rawCount: 0, keptCount: 0, excludedCount: 0 };
    }

    const det = await runObjectDetectionForSubAgent(
      ctx.image,
      ctx.plan,
      detectModel,
      {},
    );
    if (det.keptCount === 0) {
      return {
        instances: [],
        rawCount: det.rawCount,
        keptCount: 0,
        excludedCount: det.excludedCount,
      };
    }

    const instances: GeometryInstance[] = [];
    for (let i = 0; i < det.boxes.length; i += 1) {
      const box = det.boxes[i];
      ctx.onProgress?.(
        `分割 ${i + 1}/${det.boxes.length}：${ctx.image.relativePath}`,
      );
      const response = await runPreAnnot(
        'sam2_box',
        ctx.image.absolutePath,
        ctx.primaryModel,
        { box: normBoxToSamBox(box) },
      );
      const polyResult = assertPreAnnotResult(
        response,
        isPolygonResult,
        'SAM2',
      );
      if (!polyResult.points.length) continue;
      const crop = pointsToAabb(polyResult.points) ?? {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
      instances.push({
        instance_index: instances.length,
        geometry_kind: 'polygon',
        class_name: box.class_name,
        confidence: box.confidence,
        crop_box: crop,
        payload: { points: polyResult.points },
      });
    }

    return {
      instances,
      rawCount: det.rawCount,
      keptCount: instances.length,
      excludedCount: det.excludedCount,
    };
  },
};

const keypointAdapter: GeometryPipelineAdapter = {
  annotationType: 'keypoint',
  pickPrimaryModel: (models, ctx) =>
    pickDefaultPreAnnotModel('keypoint', models, ctx.keypointTemplateId),
  skipLabelMapping: (ctx) => ctx.labelCount <= 1,
  runInference: async (ctx) => {
    const templateId = ctx.adapterContext.keypointTemplateId;
    if (!templateId) {
      return { instances: [], rawCount: 0, keptCount: 0, excludedCount: 0 };
    }
    const template = getKeypointTemplate(templateId);
    const presetLabelId =
      ctx.adapterContext.labelCount <= 1
        ? (ctx.adapterContext.labels[0]?.id ?? null)
        : template
          ? resolveLabelIdForPoseTemplate(
              template,
              ctx.adapterContext.labels as never,
            )
          : null;

    const response = await runPreAnnot(
      'keypoint_full',
      ctx.image.absolutePath,
      ctx.primaryModel,
      { templateId, ...thresholdOverrides(ctx.plan) },
    );
    const result = assertPreAnnotResult(response, isPoseResult, '关键点');
    const instances: GeometryInstance[] = result.poses.map((pose, index) => {
      const crop = obbToAabb(
        pose.cx,
        pose.cy,
        pose.width,
        pose.height,
        pose.angle,
      );
      return {
        instance_index: index,
        geometry_kind: 'pose',
        class_name: template?.defaultLabel,
        confidence: pose.confidence,
        crop_box: crop,
        payload: {
          templateId: pose.templateId || templateId,
          cx: pose.cx,
          cy: pose.cy,
          width: pose.width,
          height: pose.height,
          angle: pose.angle,
          keypoints: pose.keypoints.map((kp) => ({
            x: kp.x,
            y: kp.y,
            visibility: kp.visibility,
          })),
          presetLabelId,
        },
      };
    });
    return {
      instances,
      rawCount: result.poses.length,
      keptCount: instances.length,
      excludedCount: 0,
    };
  },
};

const ADAPTERS: Record<GeometryAnnotationType, GeometryPipelineAdapter> = {
  bbox: bboxAdapter,
  rotated_bbox: rotatedBboxAdapter,
  polygon: polygonAdapter,
  keypoint: keypointAdapter,
};

export function getGeometryAdapter(
  annotationType: ImageAnnotationType,
): GeometryPipelineAdapter | null {
  if (!(annotationType in ADAPTERS)) return null;
  return ADAPTERS[annotationType as GeometryAnnotationType];
}

export function buildPresetMappings(
  instances: GeometryInstance[],
): Array<{ box_index: number; label_id: string; reason?: string }> {
  return instances.flatMap((inst) => {
    if (inst.geometry_kind !== 'pose') return [];
    const preset = (inst.payload as { presetLabelId?: string | null })
      .presetLabelId;
    if (!preset) return [];
    return [
      { box_index: inst.instance_index, label_id: preset, reason: 'template' },
    ];
  });
}
