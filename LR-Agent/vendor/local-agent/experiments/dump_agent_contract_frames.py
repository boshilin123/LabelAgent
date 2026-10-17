"""阶段 4b 姊妹脚本：把 ``compare_agent_contract`` 的 OLD/NEW 逐帧对照结果
**落盘为 JSON**，供前端渲染层 reducer 的等价性测试（Jest）直接消费。

与 ``compare_agent_contract.py`` 的关系：
- **不改动**原脚本（原脚本仍保留打印行为与 15/15 断言）；
- 本脚本复用其 ``scenario_list`` / ``old_frames`` / ``new_frames``，只增加
  序列化输出，因此两侧帧的来源、脚本化模型、HTTP/SSE 层与断言完全一致。

输出结构（**两侧都为 ``to_sse_dict()`` 的逐帧列表**）::

    {
      "meta": {"scenario_count": 15, "all_equal": true},
      "scenarios": {
        "<name>": {"baselineClass": "...", "old": [...], "new": [...]}
      }
    }

运行（在 ``vendor/local-agent`` 下，使用迁移 venv；无需任何 API key）::

    ..\\..\\..\\..\\.venvs\\langchain-migration\\Scripts\\python.exe \\
        -m experiments.dump_agent_contract_frames

离线确定性：无网络、无真实模型、无磁盘写入（工具一律结构化存根）。
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from experiments.compare_agent_contract import (  # noqa: E402
    first_difference,
    new_frames,
    old_frames,
    scenario_list,
    testset_fingerprint,
)

DEFAULT_OUTPUT = (
    ROOT.parents[2] / ".venvs" / "_logs" / "agent_contract_frames.json"
)


async def collect() -> tuple[dict[str, object], list[str]]:
    scenarios = scenario_list()
    payload: dict[str, object] = {}
    failures: list[str] = []
    for scenario in scenarios:
        old = await old_frames(scenario)
        new = await new_frames(scenario)
        payload[scenario.name] = {
            "baselineClass": scenario.baseline_class,
            "old": old,
            "new": new,
        }
        diff = first_difference(old, new)
        if diff is not None:
            failures.append(scenario.name)
        print(
            f"{scenario.name}: old={len(old)} frames new={len(new)} frames "
            f"{'EQUAL' if diff is None else f'DIFF@{diff[0]}'}"
        )
    return payload, failures


async def main() -> int:
    count, digest = testset_fingerprint()
    output = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUTPUT
    payload, failures = await collect()
    document = {
        "meta": {
            "scenario_count": len(payload),
            "all_equal": not failures,
            "failures": failures,
            "testset_fingerprint": {"files": count, "digest": digest},
            "source": "app.api.v1.agent._stream_local_chat",
            "old_entry": "app.agent.assist_service.stream_assist",
            "new_entry": "app.agent.langchain_runtime.sse_adapter.stream_agent_events",
        },
        "scenarios": payload,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    total = len(payload)
    print(f"\n写出：{output}")
    print(f"===== 汇总：{total - len(failures)}/{total} 场景逐帧一致 =====")
    if failures:
        print("不一致场景：" + ", ".join(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
