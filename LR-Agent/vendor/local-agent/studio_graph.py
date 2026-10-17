"""Expose the existing read-only LR-Agent Agent graph to LangSmith Studio.

This is a separate local debugging entry point. It reuses the production graph
builder and middleware, but deliberately excludes desktop-executed mutation
tools: Studio cannot perform the Electron confirmation/resume protocol.
"""

import os
from pathlib import Path

from app.agent.langchain_runtime import entry
from app.core.config import get_settings
from app.schemas.agent import ChatMessageInput, ClientContextInput, LocalChatStreamRequest


def _studio_workspace() -> str:
    root = Path(os.environ.get("LR_AGENT_STUDIO_WORKSPACE_ROOT") or Path(__file__).resolve().parents[3])
    if not root.is_dir():
        raise ValueError(f"Studio workspace does not exist: {root}")
    return str(root.resolve())


def _build_graph():
    model = os.environ.get("LR_AGENT_STUDIO_MODEL", "").strip()
    base_url = os.environ.get("LR_AGENT_STUDIO_BASE_URL", "").strip()
    api_key = os.environ.get("LR_AGENT_STUDIO_MODEL_API_KEY", "").strip()
    configured = bool(model and base_url and api_key)

    # A loopback-only model lets Studio display the real graph before a model
    # credential is supplied, without sending test prompts to an external API.
    if not configured:
        model = "studio-preview-only"
        base_url = "http://127.0.0.1:9/v1"
        api_key = "studio-preview-only"

    context = ClientContextInput(
        workspace_root=_studio_workspace(),
        agent_mode="chat",
        work_mode="editor",
    )
    body = LocalChatStreamRequest(
        api_key=api_key,
        base_url=base_url,
        model=model,
        messages=[ChatMessageInput(role="user", content="Studio graph initialization")],
        user_content="Studio graph initialization",
        client_job_id="studio-graph",
        client_context=context,
    )
    settings = get_settings()
    llm, aux_llm = entry.build_llm_pair(body)
    tools = entry.build_local_tools(body, settings)

    async def is_cancelled() -> bool:
        return False

    agent, _, _ = entry.build_engine_agent(
        llm=llm,
        aux_llm=aux_llm,
        tools=tools,
        settings=settings,
        is_cancelled=is_cancelled,
        body=body,
        system_prompt=entry.build_system_prompt(body),
        task_phase_ctx=entry._derive_task_phase(body),
        is_resume=False,
    )
    return agent


graph = _build_graph()
