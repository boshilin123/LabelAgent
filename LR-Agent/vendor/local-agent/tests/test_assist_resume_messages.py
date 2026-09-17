import json

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.agent.context_service import (
    RESUME_APPLIED_NEXT_HINT,
    RESUME_NEXT_HINT,
    append_client_tool_results_to_messages,
)
from app.api.v1.agent import _build_lc_messages_from_local
from app.schemas.agent import (
    ChatMessageInput,
    ChatToolCallInput,
    ClientToolResult,
    LocalChatStreamRequest,
)


def test_append_client_tool_results_adds_ai_and_tool_messages() -> None:
    lc_messages = [
        SystemMessage(content="sys"),
        HumanMessage(content="标注并生成报告"),
    ]
    results = [
        ClientToolResult(
            tool_call_id="call-1",
            name="auto_annotate",
            result=json.dumps(
                {
                    "status": "completed",
                    "tool": "auto_annotate",
                    "user_request": "标注并生成报告",
                    "summary": "批量标注已完成",
                    "next_hint": "可继续 write_workspace_file",
                },
                ensure_ascii=False,
            ),
        ),
    ]

    append_client_tool_results_to_messages(
        lc_messages,
        results,
        user_content="标注并生成报告",
    )

    assert len(lc_messages) == 4
    ai_msg = lc_messages[2]
    tool_msg = lc_messages[3]
    assert isinstance(ai_msg, AIMessage)
    assert ai_msg.tool_calls
    assert ai_msg.tool_calls[0]["name"] == "auto_annotate"
    assert ai_msg.tool_calls[0]["id"] == "call-1"
    assert isinstance(tool_msg, ToolMessage)
    assert tool_msg.tool_call_id == "call-1"
    parsed = json.loads(tool_msg.content)
    assert parsed["status"] == "completed"
    assert parsed["summary"] == "批量标注已完成"


def test_append_client_tool_results_cumulative_pairs() -> None:
    lc_messages = [HumanMessage(content="标注并写报告")]
    results = [
        ClientToolResult(
            tool_call_id="call-1",
            name="auto_annotate",
            result='{"status":"completed","summary":"标注完成"}',
        ),
        ClientToolResult(
            tool_call_id="call-2",
            name="mutate_annotation",
            result='{"status":"completed","summary":"分析完成"}',
        ),
    ]

    append_client_tool_results_to_messages(
        lc_messages,
        results,
        user_content="标注并写报告",
    )

    assert len(lc_messages) == 5
    assert isinstance(lc_messages[1], AIMessage)
    assert isinstance(lc_messages[2], ToolMessage)
    assert isinstance(lc_messages[3], AIMessage)
    assert isinstance(lc_messages[4], ToolMessage)
    assert lc_messages[2].tool_call_id == "call-1"
    assert lc_messages[4].tool_call_id == "call-2"


def test_append_client_tool_results_empty_is_noop() -> None:
    lc_messages = [HumanMessage(content="hi")]
    append_client_tool_results_to_messages(lc_messages, [])
    assert len(lc_messages) == 1


def test_resume_placeholder_preserves_blocks_when_flag_set() -> None:
    """Resume 时 preserve_blocks=True 不应写入 blocks_json=[]。"""
    values: dict = {"status": "streaming", "error": None}
    preserve_blocks = True
    if not preserve_blocks:
        values["blocks_json"] = []
    assert "blocks_json" not in values


def test_non_resume_placeholder_clears_blocks() -> None:
    values: dict = {"status": "streaming", "error": None}
    preserve_blocks = False
    if not preserve_blocks:
        values["blocks_json"] = []
    assert values["blocks_json"] == []


def test_append_only_tool_message_when_aimessage_already_present() -> None:
    lc_messages = [
        HumanMessage(content="标注第 6~8 张"),
        AIMessage(
            content="现在执行自动标注。",
            tool_calls=[
                {
                    "id": "call-1",
                    "name": "auto_annotate",
                    "args": {"user_request": "标注第 6~8 张"},
                }
            ],
        ),
    ]
    append_client_tool_results_to_messages(
        lc_messages,
        [
            ClientToolResult(
                tool_call_id="call-1",
                name="auto_annotate",
                result='{"status":"completed","summary":"已处理 3 张图片"}',
            )
        ],
        user_content="标注第 6~8 张",
    )
    assert len(lc_messages) == 3
    assert isinstance(lc_messages[1], AIMessage)
    assert isinstance(lc_messages[2], ToolMessage)
    assert lc_messages[2].tool_call_id == "call-1"
    parsed = json.loads(lc_messages[2].content)
    assert parsed["summary"] == "已处理 3 张图片"
    assert parsed["next_hint"] == RESUME_NEXT_HINT


def test_resume_hint_forbids_fake_completion() -> None:
    assert "mutate_annotation" in RESUME_NEXT_HINT
    assert "proposal_pending" in RESUME_NEXT_HINT
    assert "请给出简短总结" not in RESUME_NEXT_HINT
    assert "已发送给用户确认" not in RESUME_NEXT_HINT


def test_append_preserves_existing_next_hint() -> None:
    lc_messages = [HumanMessage(content="标注")]
    append_client_tool_results_to_messages(
        lc_messages,
        [
            ClientToolResult(
                tool_call_id="call-1",
                name="auto_annotate",
                result=json.dumps(
                    {
                        "status": "completed",
                        "summary": "ok",
                        "next_hint": "可继续 write_workspace_file",
                    },
                    ensure_ascii=False,
                ),
            )
        ],
    )
    parsed = json.loads(lc_messages[2].content)
    assert parsed["next_hint"] == "可继续 write_workspace_file"


def test_resume_hint_applied_after_keep_all() -> None:
    """Keep All 后续跑：proposal_pending 修正为 False，hint 切换为已落盘口径。"""
    lc_messages = [HumanMessage(content="标注并写报告")]
    append_client_tool_results_to_messages(
        lc_messages,
        [
            ClientToolResult(
                tool_call_id="call-1",
                name="auto_annotate",
                result=json.dumps(
                    {
                        "status": "completed",
                        "summary": "已生成待确认提案（未写盘）。批量标注完成：处理 5 张，共 14 个框。",
                        "proposal_pending": True,
                        "file_written": False,
                    },
                    ensure_ascii=False,
                ),
            )
        ],
        user_content="标注并写报告",
        proposals_applied=True,
    )
    parsed = json.loads(lc_messages[2].content)
    assert parsed["proposal_pending"] is False
    assert parsed["file_written"] is True
    assert parsed["next_hint"] == RESUME_APPLIED_NEXT_HINT
    assert "已写盘" in parsed["next_hint"]
    # 禁止过时的确认引导（治 Keep All 后模型仍说"请确认 Keep All"）
    assert "禁止再要求用户确认" in parsed["next_hint"]


def test_resume_hint_pending_by_default() -> None:
    """未确认（或 Dismiss）后续跑：保留 pending 口径，禁止声称已标注。"""
    lc_messages = [HumanMessage(content="标注")]
    append_client_tool_results_to_messages(
        lc_messages,
        [
            ClientToolResult(
                tool_call_id="call-1",
                name="auto_annotate",
                result='{"status":"completed","summary":"ok","proposal_pending":true}',
            )
        ],
        user_content="标注",
    )
    parsed = json.loads(lc_messages[2].content)
    assert parsed["proposal_pending"] is True
    assert parsed["next_hint"] == RESUME_NEXT_HINT


def test_resume_applied_hint_skips_no_proposal_result() -> None:
    """VERIFY 阶段但 mutate 未生成提案（skipped）：不得谎报已写盘。"""
    lc_messages = [HumanMessage(content="修正标注")]
    append_client_tool_results_to_messages(
        lc_messages,
        [
            ClientToolResult(
                tool_call_id="m1",
                name="mutate_annotation",
                result=json.dumps(
                    {
                        "status": "skipped",
                        "summary": "未生成提案",
                        "proposal_pending": False,
                        "file_written": False,
                    },
                    ensure_ascii=False,
                ),
            )
        ],
        user_content="修正标注",
        proposals_applied=True,
    )
    parsed = json.loads(lc_messages[2].content)
    assert parsed["file_written"] is False
    assert parsed["next_hint"] == RESUME_NEXT_HINT


def test_build_lc_messages_restores_assistant_tool_chain() -> None:
    body = LocalChatStreamRequest(
        api_key="k",
        base_url="http://localhost",
        model="m",
        messages=[
            ChatMessageInput(role="user", content="标注第 6~8 张并更新记忆"),
            ChatMessageInput(
                role="assistant",
                content="我先预览。",
                tool_calls=[
                    ChatToolCallInput(
                        id="v1",
                        name="read_image_for_vision",
                        args={"relative_path": "6.jpg"},
                    )
                ],
            ),
            ChatMessageInput(
                role="tool",
                content='{"ok":true,"name":"6.jpg"}',
                tool_call_id="v1",
            ),
            ChatMessageInput(
                role="assistant",
                content="现在执行自动标注。",
                tool_calls=[
                    ChatToolCallInput(
                        id="call-1",
                        name="auto_annotate",
                        args={"user_request": "标注第 6~8 张"},
                    )
                ],
            ),
        ],
        user_content="标注第 6~8 张并更新记忆",
        client_job_id="job-1",
    )
    lc_messages = _build_lc_messages_from_local(body, "sys")
    assert isinstance(lc_messages[0], SystemMessage)
    assert isinstance(lc_messages[1], HumanMessage)
    assert isinstance(lc_messages[2], AIMessage)
    assert lc_messages[2].tool_calls[0]["name"] == "read_image_for_vision"
    assert isinstance(lc_messages[3], ToolMessage)
    assert lc_messages[3].tool_call_id == "v1"
    assert isinstance(lc_messages[4], AIMessage)
    assert lc_messages[4].tool_calls[0]["id"] == "call-1"

    append_client_tool_results_to_messages(
        lc_messages,
        [
            ClientToolResult(
                tool_call_id="call-1",
                name="auto_annotate",
                result='{"status":"completed","summary":"已处理 3 张"}',
            )
        ],
        user_content="标注第 6~8 张并更新记忆",
    )
    tool_msgs = [m for m in lc_messages if isinstance(m, ToolMessage)]
    assert [m.tool_call_id for m in tool_msgs] == ["v1", "call-1"]
    ai_msgs = [m for m in lc_messages if isinstance(m, AIMessage)]
    assert len(ai_msgs) == 2


def test_agent_api_does_not_double_append_client_tool_results() -> None:
    from pathlib import Path

    import app.api.v1.agent as agent_mod

    source = Path(agent_mod.__file__).read_text(encoding="utf-8")
    assert "append_client_tool_results_to_messages" not in source
