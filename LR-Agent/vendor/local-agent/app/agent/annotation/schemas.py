# 学习导航：标注服务内部的结构化数据模型。与 app/schemas 中的 HTTP 请求模型分工不同：这里约束服务输出与执行计划。
"""Internal structured outputs for annotation agent LLM calls."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# 范围载荷：检测类名与项目标签名分别保存包含/排除规则。
class AnnotationScopePayload(BaseModel):
    scope_summary: str = ""
    include_detection_labels: list[str] = Field(default_factory=list)
    exclude_detection_labels: list[str] = Field(default_factory=list)
    include_label_names: list[str] = Field(default_factory=list)
    exclude_label_names: list[str] = Field(default_factory=list)


# 检测计划参数：是否检测、模型 ID、置信度和 IoU 阈值等。
class DetectionHintsPayload(BaseModel):
    needs_object_detection: bool = True
    model_id: str | None = None
    conf_threshold: float | None = None
    iou_threshold: float | None = None
    notes: str = ""


# 逐图/逐框处理的约束，例如是否要求逐框映射、是否允许空标签和最低标注数。
class SubAgentConstraintsPayload(BaseModel):
    require_per_box_mapping: bool = True
    allow_unlabeled_boxes: bool = True
    min_labeled_box_count: int = 1


# 一次批量任务的计划，包括标签策略、检测配置、视觉开关、范围与步骤说明。
class BatchPlanResult(BaseModel):
    intent_summary: str = "批量图片标注"
    label_strategy: Literal["map_each_box_to_label", "single_label_for_all_boxes"] = (
        "map_each_box_to_label"
    )
    use_vision_mapping: bool = False
    detection_hints: DetectionHintsPayload = Field(default_factory=DetectionHintsPayload)
    sub_agent_constraints: SubAgentConstraintsPayload = Field(
        default_factory=SubAgentConstraintsPayload
    )
    annotation_scope: AnnotationScopePayload = Field(default_factory=AnnotationScopePayload)
    plan_steps: list[str] = Field(default_factory=list)


# 批量准备的整体返回值：选择哪些图片、为什么选择，以及后续采用什么计划。
class BatchPrepareResult(BaseModel):
    """Scope + plan in one LLM call."""

    selected_paths: list[str] = Field(default_factory=list)
    scope_reason: str = ""
    plan: BatchPlanResult = Field(default_factory=BatchPlanResult)

