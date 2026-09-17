/**
 * 单图标注本地工具：YOLO 检测与图像读取。
 */
import { assertPreAnnotResult, runPreAnnot } from '../preAnnotService';
import type {
  BatchAnnotationPlan,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { isDetectResult } from '../../../shared/preAnnotTypes';
import { filterDetectionBoxesByScope } from './detectionScope';
import { logAnnotationDebug } from './annotationAgentDebug';

export type DetectBox = {
  box_index: number;
  class_name: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function readImageBase64(absolutePath: string): Promise<string> {
  const buf = await window.electron?.fileSystem?.readFileBuffer(absolutePath);
  if (!buf || buf.byteLength === 0) return '';
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function runObjectDetectionForSubAgent(
  image: ImageCandidate,
  plan: BatchAnnotationPlan,
  detectionModel: PretrainedModelConfig,
  args: Record<string, unknown> = {},
): Promise<{
  rawCount: number;
  keptCount: number;
  excludedCount: number;
  boxes: DetectBox[];
}> {
  const hints = plan.detection_hints;
  const conf =
    typeof args.conf_threshold === 'number'
      ? args.conf_threshold
      : hints.conf_threshold;
  const iou =
    typeof args.iou_threshold === 'number'
      ? args.iou_threshold
      : hints.iou_threshold;

  const response = await runPreAnnot(
    'yolo_detect',
    image.absolutePath,
    detectionModel,
    {
      overrides: { confThreshold: conf, iouThreshold: iou },
    },
  );
  const detResult = assertPreAnnotResult(response, isDetectResult, '检测');
  const rawItems = detResult.items.map((item, idx) => {
    const g = item.geometry;
    const x = 'x' in g ? g.x : g.cx - g.width / 2;
    const y = 'y' in g ? g.y : g.cy - g.height / 2;
    return {
      box_index: idx,
      class_name: item.className,
      confidence: item.confidence,
      x,
      y,
      width: g.width,
      height: g.height,
    };
  });
  const rawCount = rawItems.length;
  const scoped = filterDetectionBoxesByScope(rawItems, plan.annotation_scope);
  const boxes = scoped.boxes.map((b, i) => ({ ...b, box_index: i }));
  logAnnotationDebug('detect', image.relativePath, {
    raw_count: rawCount,
    kept_count: boxes.length,
    excluded_count: scoped.excluded,
    detection_classes: [...new Set(boxes.map((b) => b.class_name))].slice(0, 8),
    scope: plan.annotation_scope,
    conf,
    iou,
    boxes: boxes.map((b) => ({
      box_index: b.box_index,
      class_name: b.class_name,
      confidence: Number(b.confidence.toFixed(3)),
      x: Number(b.x.toFixed(4)),
      y: Number(b.y.toFixed(4)),
      width: Number(b.width.toFixed(4)),
      height: Number(b.height.toFixed(4)),
    })),
  });
  return {
    rawCount,
    keptCount: boxes.length,
    excludedCount: scoped.excluded,
    boxes,
  };
}
