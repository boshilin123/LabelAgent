import type { BatchAnnotationPlan } from '../../../shared/annotationAgentTypes';
import { applyDetectionOverrides } from './geometryBatchPipeline';
import { parseDetectionOverrides } from '../agentJobRegistry';

function basePlan(): BatchAnnotationPlan {
  return {
    intent_summary: '几何实例检测 + 标签映射',
    label_strategy: 'map_each_box_to_label',
    use_vision_mapping: false,
    detection_hints: {},
    sub_agent_constraints: {},
    annotation_scope: {},
    plan_steps: [],
  };
}

describe('applyDetectionOverrides', () => {
  it('covers thresholds, model and class filters', () => {
    const plan = basePlan();
    applyDetectionOverrides(
      plan,
      {
        confThreshold: 0.6,
        iouThreshold: 0.4,
        modelId: 'yolo-11',
        includeClasses: ['person'],
        excludeClasses: ['car'],
      },
      true,
    );
    expect(plan.detection_hints.conf_threshold).toBe(0.6);
    expect(plan.detection_hints.iou_threshold).toBe(0.4);
    expect(plan.detection_hints.model_id).toBe('yolo-11');
    expect(plan.annotation_scope.include_detection_labels).toEqual(['person']);
    expect(plan.annotation_scope.exclude_detection_labels).toEqual(['car']);
  });

  it('leaves plan untouched when overrides undefined', () => {
    const plan = basePlan();
    applyDetectionOverrides(plan, undefined, true);
    expect(plan.detection_hints).toEqual({});
    expect(plan.annotation_scope).toEqual({});
  });

  it('forces vision mapping off when provider lacks vision', () => {
    const plan = basePlan();
    applyDetectionOverrides(plan, { useVisionMapping: true }, false);
    expect(plan.use_vision_mapping).toBe(false);
  });

  it('honors explicit vision mapping when provider supports vision', () => {
    const plan = basePlan();
    applyDetectionOverrides(plan, { useVisionMapping: true }, true);
    expect(plan.use_vision_mapping).toBe(true);
  });
});

describe('parseDetectionOverrides', () => {
  it('parses snake_case args into overrides', () => {
    const overrides = parseDetectionOverrides({
      conf_threshold: 0.55,
      iou_threshold: '0.45',
      model_id: ' m1 ',
      include_classes: ['person', ''],
      exclude_classes: '["car", "bus"]',
      use_vision_mapping: 'true',
    });
    expect(overrides).toEqual({
      confThreshold: 0.55,
      iouThreshold: 0.45,
      modelId: 'm1',
      includeClasses: ['person'],
      excludeClasses: ['car', 'bus'],
      useVisionMapping: true,
    });
  });

  it('clamps thresholds into [0, 1]', () => {
    const overrides = parseDetectionOverrides({
      conf_threshold: 1.5,
      iou_threshold: -0.2,
    });
    expect(overrides?.confThreshold).toBe(1);
    expect(overrides?.iouThreshold).toBe(0);
  });

  it('returns undefined when no override fields present', () => {
    expect(
      parseDetectionOverrides({ user_request: '标注', paths: ['a.jpg'] }),
    ).toBeUndefined();
  });
});
