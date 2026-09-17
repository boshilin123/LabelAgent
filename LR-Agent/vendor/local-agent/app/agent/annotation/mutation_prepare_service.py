"""标注变更准备：单次 LLM 解析 mutate 意图与目标描述。"""

from __future__ import annotations

import json
from typing import Any, Literal

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from app.agent.annotation.debug_log import log_annotation_agent
from app.agent.annotation.llm_invoke import invoke_json_model

MUTATION_PREPARE_SYSTEM = """你是 LR-Agent 标注变更准备助手。用户希望修改或删除已有标注（非新增）。

支持全部标注类型：bbox、rotated_bbox、polygon、keypoint（骨架）、caption、cot、
text_classification、classification、span_ner、instruction、preference、conversation。
用户说「不要新增框/不要新增标注」时，只能改或删已有项，不要改用 auto_annotate。

输出 JSON（一次完成）：
{
  "selected_paths": ["data/7.jpg"],
  "intent_summary": "一句话摘要",
  "operations": [
    {
      "relative_path": "data/7.jpg",
      "mutation_kind": "patch_label|patch_geometry|patch_content|delete",
      "targets": [
        {"by": "all"},
        {"by": "id", "id": "uuid"},
        {"by": "label_name", "label_name": "person"},
        {"by": "index", "index": 1},
        {"by": "spatial", "hint": "leftmost"},
        {"by": "selected"},
        {"by": "unlabeled"},
        {"by": "granularity", "granularity": "brief"},
        {"by": "language", "language": "en"},
        {"by": "longest"},
        {"by": "shortest"},
        {"by": "duplicate_label"}
      ],
      "new_label_name": "worker",
      "x": 0.1, "y": 0.2, "width": 0.15, "height": 0.18,
      "cx": 0.5, "cy": 0.4, "angle": 30,
      "points": [{"x": 0.1, "y": 0.2}],
      "keypoints": [{"x": 0.1, "y": 0.2, "visibility": 2}],
      "text": "新的 caption",
      "granularity": "brief",
      "language": "zh",
      "steps": [{"description": "...", "conclusion": "..."}],
      "answer": "...",
      "instruction": "...",
      "input": "...", "output": "...",
      "start": 0, "end": 12,
      "prompt": "...", "chosen": "...", "rejected": "...",
      "turns": [{"role": "user", "content": "..."}],
      "note": "..."
    }
  ]
}

规则：
- patch_label：改已有标签（含多边形/分类空 labelId 补标）。必须给出 new_label_name（项目标签名之一）
- patch_geometry：改几何。
  bbox 填 x/y/width/height（0–1，左上角）；rotated_bbox 与 keypoint 骨架填 cx/cy/width/height（0–1，中心点），可带 angle（度）；
  keypoint 改关键点填 keypoints 整表替换（长度与骨架模板一致，visibility 0=不可见 1=遮挡 2=可见）；
  polygon 仅在用户明确给出新轮廓时填 points（至少 3 点），飘出的多边形优先 delete
- patch_content：改正文。
  caption 填 text/granularity/language；cot 填 steps（至少 2 步）+ answer 整表替换，可带 instruction；
  instruction 填 instruction/input/output；span_ner 改文本偏移填 start/end（字符索引，start < end）；
  preference 填 prompt/chosen/rejected；conversation 填 turns 整表替换（role 为 user/assistant）
- delete：删除目标；清空某文件全部标注时 targets=[{"by":"all"}]；去重分类用 {"by":"duplicate_label"}
- selected_paths 必须为候选列表中的 relative_path
- 优先使用摘要里的 id；无 id 时用 label_name/index/spatial/unlabeled/granularity
- 用户说「这个框」「当前选中」时加入 {"by":"selected"}
- 勿编造不在候选中的路径
"""


class MutationPointSchema(BaseModel):
    x: float
    y: float


class MutationCotStepSchema(BaseModel):
    description: str
    conclusion: str


class MutationKeypointSchema(BaseModel):
    x: float
    y: float
    # 0=不可见 1=遮挡 2=可见
    visibility: int = 2


class MutationTurnSchema(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class MutationTargetSchema(BaseModel):
    by: Literal[
        "id",
        "label_name",
        "index",
        "spatial",
        "selected",
        "all",
        "unlabeled",
        "granularity",
        "language",
        "longest",
        "shortest",
        "duplicate_label",
    ] = "id"
    id: str | None = None
    label_name: str | None = None
    index: int | None = None
    hint: str | None = None
    granularity: str | None = None
    language: str | None = None


class MutationOperationSchema(BaseModel):
    relative_path: str = Field(min_length=1)
    mutation_kind: Literal[
        "patch_label", "patch_geometry", "patch_content", "delete"
    ] = "patch_label"
    targets: list[MutationTargetSchema] = Field(default_factory=list)
    new_label_name: str | None = None
    x: float | None = None
    y: float | None = None
    width: float | None = None
    height: float | None = None
    # rotated_bbox / keypoint 骨架：中心点 + 旋转角（度）
    cx: float | None = None
    cy: float | None = None
    angle: float | None = None
    points: list[MutationPointSchema] | None = None
    # keypoint 骨架关键点（整表替换）
    keypoints: list[MutationKeypointSchema] | None = None
    text: str | None = None
    granularity: str | None = None
    language: str | None = None
    steps: list[MutationCotStepSchema] | None = None
    answer: str | None = None
    instruction: str | None = None
    input: str | None = None
    output: str | None = None
    # span_ner 文本偏移（字符索引）
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)
    # preference
    prompt: str | None = None
    chosen: str | None = None
    rejected: str | None = None
    # conversation（整表替换）
    turns: list[MutationTurnSchema] | None = None
    note: str | None = None


class MutationPrepareLlmResult(BaseModel):
    selected_paths: list[str] = Field(default_factory=list)
    intent_summary: str = ""
    operations: list[MutationOperationSchema] = Field(default_factory=list)


class MutationPrepareResult(BaseModel):
    selected_paths: list[str] = Field(default_factory=list)
    intent_summary: str = ""
    operations: list[dict[str, Any]] = Field(default_factory=list)
    resolved_user_request: str = ""


def _filter_paths(raw_paths: object, candidates: list[dict]) -> list[str]:
    by_path = {
        str(c.get("relative_path") or "").strip().replace("\\", "/"): c
        for c in candidates
        if str(c.get("relative_path") or "").strip()
    }
    selected: list[str] = []
    if isinstance(raw_paths, list):
        for raw in raw_paths:
            key = str(raw).strip().replace("\\", "/")
            if key in by_path:
                selected.append(key)
    return selected


async def prepare_mutation_annotation(
    llm: ChatOpenAI,
    *,
    user_request: str,
    current_relative_path: str,
    candidates: list[dict],
    label_names: list[str],
    selected_annotation_ids: list[str] | None = None,
    conversation_transcript: str = "",
) -> MutationPrepareResult:
    if not candidates:
        return MutationPrepareResult(
            intent_summary="无文件候选",
            resolved_user_request=user_request,
        )

    catalog = json.dumps(
        [
            {
                "relative_path": c.get("relative_path"),
                "name": c.get("name"),
                "parent": c.get("parent"),
            }
            for c in candidates[:80]
        ],
        ensure_ascii=False,
    )
    labels = ", ".join(label_names[:50]) or "（无）"
    selected_ids = ", ".join(selected_annotation_ids or []) or "（无）"
    transcript = conversation_transcript.strip() or "（无历史）"

    human = (
        f"【对话上下文】\n{transcript}\n\n"
        f"【用户请求】\n{user_request.strip()}\n\n"
        f"current_relative_path: {current_relative_path or '（无）'}\n"
        f"selected_annotation_ids: {selected_ids}\n"
        f"项目标签: {labels}\n"
        f"候选文件: {catalog}\n"
    )

    parsed = await invoke_json_model(
        llm,
        messages=[
            SystemMessage(content=MUTATION_PREPARE_SYSTEM),
            HumanMessage(content=human),
        ],
        model_cls=MutationPrepareLlmResult,
    )

    selected = _filter_paths(parsed.selected_paths, candidates)
    if not selected and parsed.operations:
        op_paths = {
            str(op.relative_path).strip().replace("\\", "/")
            for op in parsed.operations
        }
        selected = [p for p in op_paths if p in {c.get("relative_path") for c in candidates}]

    operations = [op.model_dump() for op in parsed.operations]

    log_annotation_agent(
        "mutation-prepare",
        "mutation-prepare 完成",
        selected=len(selected),
        operations=len(operations),
    )

    return MutationPrepareResult(
        selected_paths=selected,
        intent_summary=parsed.intent_summary or user_request[:200],
        operations=operations,
        resolved_user_request=user_request,
    )
