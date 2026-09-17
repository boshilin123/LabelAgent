"""read_file_annotation 工具：大标注文件分页与截断。"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from app.agent.annotation.annotation_doc_reader import compute_file_key
from app.agent.tools.registry import build_tools_p1
from app.core.config import Settings
from app.models.user import User
from app.schemas.agent import ClientContextInput


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("SECRET_KEY", "test-secret-key-for-unit-tests")
    return Settings()


@pytest.fixture
def user() -> User:
    return User(
        id=uuid.uuid4(),
        email="test@example.com",
        email_verified=True,
        username="tester",
        display_name="Tester",
        password_hash="x",
        is_active=True,
    )


def _write_annotation_doc(project_dir: Path, relative_path: str, count: int) -> None:
    files_dir = project_dir / ".lr-agent" / "annotations" / "files"
    files_dir.mkdir(parents=True)
    doc = {
        "relativePath": relative_path,
        "annotations": [
            {"id": f"ann-{i}", "kind": "bbox", "labelId": "l1"} for i in range(count)
        ],
    }
    (files_dir / f"{compute_file_key(relative_path)}.json").write_text(
        json.dumps(doc, ensure_ascii=False),
        encoding="utf-8",
    )


def _get_tool(tools: list, name: str):
    return next(t for t in tools if t.name == name)


def test_read_file_annotation_paginates(
    tmp_path: Path,
    user: User,
    settings: Settings,
) -> None:
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    _write_annotation_doc(project_dir, "data/a.jpg", 250)

    ctx = ClientContextInput(project_directory_path=str(project_dir))
    tools = build_tools_p1(user, ctx, settings=settings)
    tool = _get_tool(tools, "read_file_annotation")

    first_page = tool.func("data/a.jpg")
    assert "共 250 条标注" in first_page
    assert "第 1-200 条" in first_page
    assert "ann-199" in first_page
    assert "ann-200" not in first_page

    second_page = tool.func("data/a.jpg", annotation_offset=200)
    assert "第 201-250 条" in second_page
    assert "ann-249" in second_page
    assert "ann-0" not in second_page


def test_read_file_annotation_small_doc_no_note(
    tmp_path: Path,
    user: User,
    settings: Settings,
) -> None:
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    _write_annotation_doc(project_dir, "data/b.jpg", 3)

    ctx = ClientContextInput(project_directory_path=str(project_dir))
    tools = build_tools_p1(user, ctx, settings=settings)
    tool = _get_tool(tools, "read_file_annotation")

    result = tool.func("data/b.jpg")
    assert "共 3 条标注" not in result
    assert "ann-2" in result


def test_read_file_annotation_missing(
    tmp_path: Path,
    user: User,
    settings: Settings,
) -> None:
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    ctx = ClientContextInput(project_directory_path=str(project_dir))
    tools = build_tools_p1(user, ctx, settings=settings)
    tool = _get_tool(tools, "read_file_annotation")
    assert "未找到" in tool.func("data/none.jpg")
