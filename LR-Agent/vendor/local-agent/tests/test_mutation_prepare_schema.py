from app.agent.annotation.mutation_prepare_service import (
    MutationOperationSchema,
    MutationPrepareLlmResult,
)


def test_mutation_kinds_include_geometry_and_content():
    op = MutationOperationSchema.model_validate(
        {
            "relative_path": "data/1.jpg",
            "mutation_kind": "patch_geometry",
            "targets": [{"by": "unlabeled"}],
            "x": 0.1,
            "y": 0.2,
            "width": 0.15,
            "height": 0.18,
        }
    )
    assert op.mutation_kind == "patch_geometry"
    assert op.x == 0.1

    content = MutationOperationSchema.model_validate(
        {
            "relative_path": "math.md",
            "mutation_kind": "patch_content",
            "targets": [{"by": "all"}],
            "steps": [
                {"description": "设未知数", "conclusion": "x,y"},
                {"description": "求解", "conclusion": "23,12"},
            ],
            "answer": "鸡 23 兔 12",
        }
    )
    assert content.mutation_kind == "patch_content"
    assert len(content.steps or []) == 2


def test_prepare_llm_result_accepts_duplicate_label_target():
    parsed = MutationPrepareLlmResult.model_validate(
        {
            "selected_paths": ["review.txt"],
            "intent_summary": "去重",
            "operations": [
                {
                    "relative_path": "review.txt",
                    "mutation_kind": "delete",
                    "targets": [{"by": "duplicate_label"}],
                }
            ],
        }
    )
    assert parsed.operations[0].targets[0].by == "duplicate_label"


def test_geometry_accepts_rotated_and_pose_fields():
    op = MutationOperationSchema.model_validate(
        {
            "relative_path": "data/1.jpg",
            "mutation_kind": "patch_geometry",
            "targets": [{"by": "selected"}],
            "cx": 0.5,
            "cy": 0.4,
            "angle": 30.0,
            "keypoints": [{"x": 0.1, "y": 0.2, "visibility": 2}],
        }
    )
    assert op.cx == 0.5
    assert op.angle == 30.0
    assert op.keypoints is not None and op.keypoints[0].visibility == 2


def test_content_accepts_span_preference_conversation_fields():
    op = MutationOperationSchema.model_validate(
        {
            "relative_path": "data/a.txt",
            "mutation_kind": "patch_content",
            "targets": [{"by": "id", "id": "s1"}],
            "start": 0,
            "end": 12,
            "prompt": "问",
            "chosen": "好",
            "rejected": "差",
            "turns": [{"role": "user", "content": "你好"}],
        }
    )
    assert op.start == 0 and op.end == 12
    assert op.turns is not None and op.turns[0].role == "user"


def test_span_offset_rejects_negative():
    import pytest

    with pytest.raises(ValueError):
        MutationOperationSchema.model_validate(
            {
                "relative_path": "data/a.txt",
                "mutation_kind": "patch_content",
                "targets": [{"by": "all"}],
                "start": -1,
            }
        )


def test_turns_reject_unknown_role():
    import pytest

    with pytest.raises(ValueError):
        MutationOperationSchema.model_validate(
            {
                "relative_path": "data/a.txt",
                "mutation_kind": "patch_content",
                "targets": [{"by": "all"}],
                "turns": [{"role": "system", "content": "x"}],
            }
        )
