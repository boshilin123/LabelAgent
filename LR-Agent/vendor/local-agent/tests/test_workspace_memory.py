"""工作区记忆注入：开关控制 prompt，不再走偏好记忆语义。"""

from app.agent.context_snapshot import build_assist_system_prompt
from app.schemas.agent import ClientContextInput


def _build_prompt(client_context: ClientContextInput | None) -> str:
    return build_assist_system_prompt(
        client_context,
        model="test-model",
        provider_label="测试",
        supports_vision=False,
    )


def test_enabled_with_empty_index_still_injects_block() -> None:
    ctx = ClientContextInput(
        workspace_root="/ws",
        workspace_memory_enabled=True,
        memory_index=None,
    )
    prompt = _build_prompt(ctx)

    assert "【工作区记忆】" in prompt
    assert "尚无工作区记忆文件" in prompt
    assert "memory_create" in prompt
    assert "必须更新" not in prompt
    assert "已保存的记忆" not in prompt
    assert "长期价值" not in prompt


def test_enabled_with_index_injects_index() -> None:
    ctx = ClientContextInput(
        workspace_root="/ws",
        workspace_memory_enabled=True,
        memory_index="- [进度](topics/progress.md)：已标 3/10",
    )
    prompt = _build_prompt(ctx)

    assert "【工作区记忆】" in prompt
    assert "topics/progress.md" in prompt
    assert "memory_write" in prompt
    assert "memory_read" in prompt
    assert "必须更新" not in prompt
    assert "用户规范" in prompt


def test_disabled_skips_memory_block_even_if_index_present() -> None:
    ctx = ClientContextInput(
        workspace_root="/ws",
        workspace_memory_enabled=False,
        memory_index="- leftover",
    )
    prompt = _build_prompt(ctx)

    assert "【工作区记忆】" not in prompt
    assert "leftover" not in prompt
