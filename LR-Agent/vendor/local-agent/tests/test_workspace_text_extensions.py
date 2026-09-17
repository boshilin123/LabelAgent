from app.agent.tools.workspace_text_extensions import (
    is_allowed_text_extension,
    is_blocked_text_extension,
)


def test_jsonl_allowed():
    assert not is_blocked_text_extension(".jsonl")
    assert is_allowed_text_extension(".jsonl")


def test_png_blocked():
    assert is_blocked_text_extension(".png")
    assert not is_allowed_text_extension(".png")


def test_extensionless_allowed():
    assert not is_blocked_text_extension("")
    assert is_allowed_text_extension("")


def test_script_and_executable_suffixes_blocked_for_write():
    for ext in (
        ".bat",
        ".cmd",
        ".ps1",
        ".psm1",
        ".vbs",
        ".hta",
        ".scr",
        ".com",
        ".jar",
        ".reg",
        ".lnk",
        ".xyz",
    ):
        assert is_blocked_text_extension(ext), ext
        assert not is_allowed_text_extension(ext), ext


def test_common_code_suffixes_allowed_for_write():
    for ext in (".py", ".ts", ".tsx", ".json", ".yaml", ".sh"):
        assert is_allowed_text_extension(ext), ext
