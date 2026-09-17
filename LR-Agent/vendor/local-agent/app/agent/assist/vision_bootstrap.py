"""视觉兜底加载：第一轮 LLM 未发起任何 tool call 时，自动加载相关图片。

设计说明：历史上曾在进 LLM 前无条件预加载（bootstrap），但系统替模型选图容易看错、
浪费视觉 token；现仅保留弱模型未调用工具时的首轮兜底（try_fallback），
正常路径由模型自行调用 read_image_for_vision。
"""

import uuid
from collections.abc import AsyncIterator, Callable

from app.agent.assist_vision import (
    can_bootstrap_vision,
    pick_vision_relative_path,
    stream_vision_tool_execution,
    vision_relative_from_user_text,
)
from app.core.config import Settings
from app.schemas.agent import ClientContextInput, StreamEventPayload


class VisionAutoLoader:
    """视觉兜底加载器。

    根据 user_content 判断是否涉及图片；仅在第一轮无 tool call 时
    通过流式执行 vision tool 将图片注入消息上下文（弱模型兜底）。
    """

    def __init__(
        self,
        vision_fn: Callable | None,
        provider_is_vision: bool,
        settings: Settings,
        client_context: ClientContextInput | None,
        user_content: str,
    ) -> None:
        self.vision_fn = vision_fn
        self.provider_is_vision = provider_is_vision
        self.settings = settings
        self.client_context = client_context
        self.user_content = user_content

    def should_load(self, is_resume: bool) -> bool:
        """判断本轮是否可能涉及图片（fallback 触发前提）。"""
        if is_resume or not self.provider_is_vision or self.vision_fn is None:
            return False
        return bool(vision_relative_from_user_text(self.user_content))

    async def try_fallback(
        self, messages: list
    ) -> AsyncIterator[StreamEventPayload]:
        """在第一轮无 tool call 时尝试视觉回退（fallback）加载。"""
        rel = pick_vision_relative_path(self.client_context)
        if not rel and self.user_content.strip():
            rel = vision_relative_from_user_text(self.user_content)

        if can_bootstrap_vision(self.client_context, rel):
            tool_id = f"lr-vision-fallback-{uuid.uuid4().hex[:10]}"
            async for event in stream_vision_tool_execution(
                tool_id=tool_id,
                relative_path=rel,
                vision_fn=self.vision_fn,  # type: ignore[arg-type]
                provider_is_vision=self.provider_is_vision,
                settings=self.settings,
                messages=messages,
            ):
                yield event
