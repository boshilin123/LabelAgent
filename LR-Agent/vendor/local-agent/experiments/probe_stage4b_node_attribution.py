"""阶段 4b 探针：候选侧原始分片的**节点归因**（messages 流里的合成消息）。

回答两个必须实测的问题：

1. ``messages`` 流里带 ``langgraph_node == "<X>.after_model"`` 的合成帧长什么样
   （阶段 5 的视觉兜底会注入这类消息；若按现状映射成 ``text_delta`` 会多出空帧）；
2. ``after_model`` 注入的 ``ToolMessage`` 在 ``messages`` 流里被归因成哪个节点，
   ``updates`` 里又出现在哪个键下——决定 ``_tool_results`` 能不能只靠节点名过滤。

运行：
    .venvs\\langchain-migration\\Scripts\\python.exe experiments\\probe_stage4b_node_attribution.py
"""

from __future__ import annotations

import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from langchain.agents import create_agent  # noqa: E402
from langchain_core.messages import HumanMessage  # noqa: E402

from app.agent.langchain_runtime.middleware import (  # noqa: E402
    build_business_middleware,
)
from app.agent.langchain_runtime.runtime import AgentContext  # noqa: E402
from app.schemas.agent import ClientContextInput  # noqa: E402
from experiments.compare_agent_contract import (  # noqa: E402
    ScriptedStreamChat,
    _to_ai_round,
    _tool_instances,
    scenario_list,
)

_NAME = "mixed_sync_async"


async def main() -> int:
    scenario = next(item for item in scenario_list() if item.name == _NAME)
    tools = _tool_instances(scenario.tools_spec)
    model = ScriptedStreamChat(
        rounds=[_to_ai_round(round_) for round_ in scenario.rounds]
    )
    agent = create_agent(
        model,
        tools,
        middleware=build_business_middleware(max_tool_rounds=5),
        name="probe-4b-node",
    )
    context = AgentContext(
        mode="assist",
        client_context=ClientContextInput(workspace_root="/w"),
    )

    print(f"########## {_NAME}: raw parts ##########")
    async for part in agent.astream(
        {"messages": [HumanMessage(content="执行任务")]},
        context=context,
        stream_mode=["messages", "updates"],
        version="v2",
    ):
        kind = part.get("type")
        data = part.get("data")
        if kind == "messages":
            message, metadata = data
            print(
                "  MESSAGES node={!r} step={!r} cls={} tool_call_id={!r} "
                "status={!r} content={!r}".format(
                    metadata.get("langgraph_node"),
                    metadata.get("langgraph_step"),
                    type(message).__name__,
                    getattr(message, "tool_call_id", None),
                    getattr(message, "status", None),
                    (message.content or "")[:70],
                )
            )
            continue
        carrying = {
            node: [
                (
                    type(item).__name__,
                    getattr(item, "tool_call_id", None),
                    getattr(item, "status", None),
                )
                for item in (update or {}).get("messages", [])
            ]
            for node, update in data.items()
            if isinstance(update, dict) and (update or {}).get("messages")
        }
        if carrying:
            print(f"  UPDATES ns={part.get('ns')!r} {carrying}")
        elif kind == "updates":
            print(f"  UPDATES ns={part.get('ns')!r} keys={list(data)}")
        else:
            print(f"  {kind} {data!r}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
