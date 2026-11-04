"""请求中止后的流清理；所有聊天分支共用 asyncio 任务取消，不再另存 Event。"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, TypeVar

import anyio
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

T = TypeVar("T")


# 兼容业务循环已有的检查钩子；停止状态只来自当前异步任务，不维护第二份标记。
async def task_cancelled() -> bool:
    # 给请求断连的取消一个调度点，也让不产生网络等待的短循环可以及时停止。
    await asyncio.sleep(0)
    task = asyncio.current_task()
    return bool(task and task.cancelling())


# 取消期间仍须完成资源释放；不吞掉真实的关闭错误。
async def close_stream(stream: object) -> None:
    close = getattr(stream, "aclose", None)
    if close is not None:
        # Starlette 的 AnyIO 取消会在每次 await 再次生效，因此只保护清理阶段。
        with anyio.CancelScope(shield=True):
            await close()


# async for 提前退出不会保证关闭内层生成器；由持有它的包装层负责关闭。
@asynccontextmanager
async def closing_stream(stream: AsyncIterator[T]) -> AsyncIterator[AsyncIterator[T]]:
    try:
        yield stream
    finally:
        await close_stream(stream)


# 断连可能发生在发送当前帧时，此时生成器暂停在 yield，也需要显式关闭。
class ClosingStreamingResponse(StreamingResponse):
    def __init__(self, content: Any, *args: Any, **kwargs: Any) -> None:
        super().__init__(content, *args, **kwargs)
        self.body_iterator = self._stream_in_task(self.body_iterator)

    # HTTP 层使用 AnyIO 的持续取消；用一个有明确归属的 asyncio 任务读取业务流，
    # 断连后取消它一次并等待清理，避免第三方生成器的异步 finally 被反复打断。
    async def _stream_in_task(self, source: AsyncIterator[Any]) -> AsyncIterator[Any]:
        # 只预取一帧，保留网络发送的背压，慢客户端不会导致无限积压。
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=1)
        done = object()
        error: BaseException | None = None

        async def _pump() -> None:
            nonlocal error
            try:
                async with closing_stream(source):
                    async for chunk in source:
                        await queue.put(chunk)
            except BaseException as exc:
                error = exc
                current = asyncio.current_task()
                # 消费方已经离开时，不能再等待向满队列写入取消通知。
                if not isinstance(exc, asyncio.CancelledError) or not (current and current.cancelling()):
                    await queue.put(exc)
            else:
                await queue.put(done)

        task = asyncio.create_task(_pump())
        try:
            while True:
                item = await queue.get()
                if item is done:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            with anyio.CancelScope(shield=True):
                if not task.done():
                    task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                # 断连时消费者不再读错误帧，也不能静默吞掉真正的资源清理失败。
                if error is not None and not isinstance(error, asyncio.CancelledError):
                    raise error

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await close_stream(self.body_iterator)
