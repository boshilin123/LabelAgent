"""Cross-process pause/resume probe using a temporary SQLite checkpointer.

The `pause` and `resume` commands must run as separate Python processes with
the same database path and thread id. This script is not production storage.
"""

import argparse

from langchain.agents import create_agent
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from experiments.langchain_agent_spike import ScriptedModel, auto_annotate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("pause", "resume"))
    parser.add_argument("database_path")
    args = parser.parse_args()
    config = {"configurable": {"thread_id": "persistence-spike-1"}}

    with SqliteSaver.from_conn_string(args.database_path) as checkpointer:
        agent = create_agent(
            model=ScriptedModel(),
            tools=[auto_annotate],
            checkpointer=checkpointer,
        )
        if args.phase == "pause":
            result = agent.invoke(
                {"messages": [{"role": "user", "content": "标注 sample.jpg"}]},
                config=config,
            )
            assert len(result.get("__interrupt__", ())) == 1, result
            print("PASS: checkpointed pending annotation in process A")
        else:
            result = agent.invoke(
                Command(resume={"ok": True, "processed": 1}),
                config=config,
            )
            assert "__interrupt__" not in result, result
            assert "processed" in result["messages"][-1].content
            print("PASS: resumed checkpointed annotation in process B")


if __name__ == "__main__":
    main()
