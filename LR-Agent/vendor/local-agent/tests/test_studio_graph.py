"""The Studio adapter must expose the existing read-only Agent graph."""

from app.agent.langchain_runtime import entry
from app.core.config import get_settings
from app.schemas.agent import ClientContextInput, LocalChatStreamRequest
from studio_graph import graph


def test_studio_graph_uses_existing_agent_nodes() -> None:
    nodes = set(graph.get_graph().nodes)
    assert {"model", "tools", "BusinessRoundMiddleware.before_model"} <= nodes


def test_studio_ask_tool_set_has_no_mutations(tmp_path) -> None:
    body = LocalChatStreamRequest(
        api_key="test-only",
        base_url="http://127.0.0.1:9/v1",
        model="studio-preview-only",
        messages=[],
        user_content="test-only",
        client_job_id="studio-test",
        client_context=ClientContextInput(
            workspace_root=str(tmp_path),
            agent_mode="chat",
            work_mode="editor",
        ),
    )
    names = {tool.name for tool in entry.build_local_tools(body, get_settings())}
    assert "read_workspace_file" in names
    assert not names & {
        "auto_annotate",
        "mutate_annotation",
        "write_workspace_file",
        "str_replace_workspace_file",
        "delete_workspace_file",
        "move_workspace_file",
    }
