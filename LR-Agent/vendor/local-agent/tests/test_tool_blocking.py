"""工具执行的阻塞性回归测试。

核心命题：同步工具（grep / 读文件 / 图片编码等）必须在线程池里执行，
不能占住事件循环线程。否则一次大范围 grep 会卡住整个 FastAPI 进程
（其它会话 SSE 卡顿、/health 可能超时、多个工具只能排队）。

测量方式：起一个「心跳 ticker」协程，每 10ms 自增一次计数；随后调用工具。
若工具阻塞事件循环，ticker 在工具执行期间拿不到执行机会，ticks 不增长。
"""

import asyncio
import time

import pytest

from app.agent.assist.explore_readonly import _invoke_inner
from app.agent.assist.tool_loop import _invoke_tool_fn

HEARTBEAT_INTERVAL_S = 0.01
BLOCKING_TOOL_SLEEP_S = 0.3
# 300ms 内每 10ms 一次，理论上限约 30 次；留足余量断言 >= 15。
MIN_EXPECTED_TICKS = 15


class Heartbeat:
    """事件循环心跳计数器：记录 interval 期间循环获得了多少次执行机会。"""

    def __init__(self) -> None:
        self.ticks = 0
        self._task: asyncio.Task | None = None
        self._running = False

    async def _ticker(self) -> None:
        while self._running:
            await asyncio.sleep(HEARTBEAT_INTERVAL_S)
            self.ticks += 1

    async def __aenter__(self) -> "Heartbeat":
        self._running = True
        self._task = asyncio.create_task(self._ticker())
        # 让 ticker 先进入 sleep，确保后续测量覆盖工具的整个执行期
        await asyncio.sleep(0)
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None


def _blocking_tool() -> str:
    """模拟一次较重的同步扫描（读盘 + 正则），期间不释放执行权。"""
    time.sleep(BLOCKING_TOOL_SLEEP_S)
    return "blocking tool done"


async def _blocking_coroutine_tool() -> str:
    """异步工具：本身就会 await，不构成阻塞。"""
    await asyncio.sleep(BLOCKING_TOOL_SLEEP_S)
    return "async tool done"


# ── 主循环：_invoke_tool_fn ──────────────────────────────────────────────


class TestInvokeToolFnDoesNotBlockLoop:
    async def test_sync_tool_does_not_block_event_loop(self):
        """同步工具在线程池执行：执行期间事件循环仍在心跳。"""
        async with Heartbeat() as hb:
            result = await _invoke_tool_fn(
                "blocking", {}, {"blocking": _blocking_tool}
            )

        assert "blocking tool done" in result
        assert hb.ticks >= MIN_EXPECTED_TICKS, (
            f"事件循环被同步工具阻塞：{BLOCKING_TOOL_SLEEP_S}s 内仅 {hb.ticks} 次心跳"
        )

    async def test_coroutine_tool_still_runs_on_loop(self):
        """协程工具走 await 分支，行为与改造前一致。"""
        async with Heartbeat() as hb:
            result = await _invoke_tool_fn(
                "async_tool", {}, {"async_tool": _blocking_coroutine_tool}
            )

        assert "async tool done" in result
        assert hb.ticks >= MIN_EXPECTED_TICKS

    async def test_sync_tool_returning_awaitable_is_awaited(self):
        """边界：同步可调用对象返回 awaitable 时，仍要被正确 await。"""

        def sync_returning_coroutine() -> object:
            return _blocking_coroutine_tool()

        result = await _invoke_tool_fn(
            "hybrid", {}, {"hybrid": sync_returning_coroutine}
        )
        assert "async tool done" in result

    async def test_unknown_tool_returns_error_json(self):
        """未知工具仍返回结构化错误，不抛异常。"""
        result = await _invoke_tool_fn("nope", {}, {})
        assert "未知工具" in result

    async def test_tool_exception_becomes_error_json(self):
        """工具抛异常时被捕获为结构化错误。"""

        def boom() -> str:
            raise RuntimeError("工具炸了")

        result = await _invoke_tool_fn("boom", {}, {"boom": boom})
        assert "工具执行失败" in result


# ── 子代理：_invoke_inner ───────────────────────────────────────────────


class TestInvokeInnerDoesNotBlockLoop:
    async def test_subagent_sync_tool_does_not_block_event_loop(self):
        """子代理内层的同步工具同样必须走线程池。"""
        async with Heartbeat() as hb:
            result = await _invoke_inner(
                "blocking", {}, {"blocking": _blocking_tool}
            )

        assert "blocking tool done" in result
        assert hb.ticks >= MIN_EXPECTED_TICKS, (
            f"子代理内层同步工具阻塞事件循环："
            f"{BLOCKING_TOOL_SLEEP_S}s 内仅 {hb.ticks} 次心跳"
        )

    async def test_subagent_coroutine_tool_still_runs_on_loop(self):
        """子代理内层的协程工具走 await 分支。"""
        async with Heartbeat() as hb:
            result = await _invoke_inner(
                "async_tool", {}, {"async_tool": _blocking_coroutine_tool}
            )

        assert "async tool done" in result
        assert hb.ticks >= MIN_EXPECTED_TICKS


# ── 并行语义：真并发 + 保序 ──────────────────────────────────────────────


class TestParallelToolsConcurrency:
    async def test_parallel_sync_tools_actually_overlap(self):
        """多个同步只读工具应真正并发：总耗时接近单次而非累加。

        未走线程池时，3 个 0.3s 的工具会串行花掉约 0.9s；
        走线程池后应接近 0.3s。用宽松阈值避免机器抖动导致的 flaky。
        """
        tools = {f"tool{i}": _blocking_tool for i in range(3)}

        started = time.perf_counter()
        await asyncio.gather(
            *[_invoke_tool_fn(name, {}, tools) for name in tools],
        )
        elapsed = time.perf_counter() - started

        serial_cost = BLOCKING_TOOL_SLEEP_S * 3
        assert elapsed < serial_cost * 0.7, (
            f"三个同步工具疑似仍串行：耗时 {elapsed:.2f}s，串行基线 {serial_cost:.2f}s"
        )

    async def test_parallel_results_preserve_call_order(self):
        """gather 结果必须按传入顺序返回，保证消息历史保序。"""

        def make_tool(tag: str, delay: float):
            def _tool() -> str:
                time.sleep(delay)
                return tag

            return _tool

        # 故意让靠前的调用更慢，验证不是按完成顺序返回
        tools = {
            "slow": make_tool("first", 0.20),
            "fast": make_tool("second", 0.02),
        }
        names = ["slow", "fast"]
        results = await asyncio.gather(
            *[_invoke_tool_fn(name, {}, tools) for name in names],
        )

        assert results[0] == "first", "先发起的调用未排在前面，结果顺序被完成顺序污染"
        assert results[1] == "second"


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-v"])
