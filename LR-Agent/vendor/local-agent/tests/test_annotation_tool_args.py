from app.agent.tools.registry import AutoAnnotateArgs, MutateAnnotationArgs


def test_auto_annotate_args_defaults():
    parsed = AutoAnnotateArgs.model_validate({"user_request": "标 data/1.jpg"})
    assert parsed.paths == []
    assert parsed.all_files is False
    assert parsed.write_mode == "append"


def test_auto_annotate_args_explicit_scope():
    parsed = AutoAnnotateArgs.model_validate(
        {
            "user_request": "重写 data/",
            "paths": ["data/"],
            "write_mode": "replace_matching",
        }
    )
    assert parsed.paths == ["data/"]
    assert parsed.write_mode == "replace_matching"
    assert parsed.all_files is False


def test_mutate_annotation_args_paths_and_ids():
    parsed = MutateAnnotationArgs.model_validate(
        {
            "user_request": "把这个框改成 worker",
            "paths": ["data/7.jpg"],
            "annotation_ids": ["ann-1"],
        }
    )
    assert parsed.paths == ["data/7.jpg"]
    assert parsed.annotation_ids == ["ann-1"]
