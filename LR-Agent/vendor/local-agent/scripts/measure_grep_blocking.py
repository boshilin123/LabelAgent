"""一次性基线测量脚本：真实 grep 对事件循环的阻塞时长（前后对照）。

用法（仓库根目录下）：
    python vendor/local-agent/scripts/measure_grep_blocking.py <工作区根目录> [pattern]

分别测量两种调用方式，输出事件循环的最大阻塞时长：
  1. 直接调用（当前实现）—— 同步代码跑在事件循环线程上，会阻塞
  2. asyncio.to_thread（改造目标）—— 跑在线程池，不阻塞
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.agent.tools.workspace_search import grep_workspace  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.schemas.agent import ClientContextInput  # noqa: E402


class LoopLagMonitor:
    """测量事件循环被阻塞的最长连续时间（loop lag）。"""

    def __init__(self, interval: float = 0.005) -> None:
        self.interval = interval
        self.samples: list[float] = []
        self._task: asyncio.Task | None = None
        self._running = False

    async def _ticker(self) -> None:
        while self._running:
            before = time.perf_counter()
            await asyncio.sleep(self.interval)
            # 实际间隔 - 期望间隔 = 这次调度被延迟的时间
            self.samples.append(time.perf_counter() - before - self.interval)

    async def __aenter__(self) -> "LoopLagMonitor":
        self._running = True
        self._task = asyncio.create_task(self._ticker())
        await asyncio.sleep(0)
        return self

    async def __aexit__(self, *exc: object) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    @property
    def max_lag_ms(self) -> float:
        return max(self.samples) * 1000 if self.samples else 0.0

    @property
    def ticks(self) -> int:
        return len(self.samples)


def _call_grep(ctx: ClientContextInput, pattern: str, settings) -> str:
    return grep_workspace(
        ctx,
        pattern,
        "",  # 整个工作区
        "*",
        False,
        None,
        settings=settings,
    )


async def _measure(mode: str, ctx, pattern, settings) -> tuple[float, LoopLagMonitor, str]:
    async with LoopLagMonitor() as mon:
        started = time.perf_counter()
        if mode == "direct":
            out = _call_grep(ctx, pattern, settings)
        else:
            out = await asyncio.to_thread(_call_grep, ctx, pattern, settings)
        elapsed = (time.perf_counter() - started) * 1000
    return elapsed, mon, out


async def main() -> None:
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    pattern = sys.argv[2] if len(sys.argv) > 2 else r"def\s+\w+"

    settings = get_settings()
    ctx = ClientContextInput(workspace_root=str(Path(root).resolve()))

    # 预热一次，排除磁盘缓存冷启动的影响
    _call_grep(ctx, pattern, settings)

    for mode, label in (("direct", "当前实现（直接调用，阻塞事件循环）"),
                        ("thread", "改造目标（asyncio.to_thread）")):
        elapsed, mon, out = await _measure(mode, ctx, pattern, settings)
        print(f"--- {label} ---")
        print(f"  调用耗时        : {elapsed:.1f} ms")
        print(f"  心跳次数        : {mon.ticks}")
        print(f"  事件循环最大阻塞: {mon.max_lag_ms:.1f} ms")
        print(f"  结果字节数      : {len(out)}")
    print(f"\nworkspace: {ctx.workspace_root}")
    print(f"pattern  : {pattern}")


if __name__ == "__main__":
    asyncio.run(main())
