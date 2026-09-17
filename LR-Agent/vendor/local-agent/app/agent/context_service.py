"""对话上下文服务：Assist resume 与 chat 系统提示词。"""

from __future__ import annotations

import json

from langchain_core.messages import AIMessage, ToolMessage


CHAT_SYSTEM_PROMPT = """在 LR-Agent 系统内回答用户问题。结合【你的身份】中的模型信息作答，勿自称独立产品助手或其它未配置的模型。"""

RESUME_NEXT_HINT = (
    "客户端工具已结束。不要重复调用刚才同一个 tool_call。"
    "若 proposal_pending=true：提案未 Keep All、未写盘，不要声称已标注/已删除/已写入。"
    "改或删已有标注必须调用 mutate_annotation。"
    "若还要给其他文件做新标注，再调用 auto_annotate 并传入新的 paths。"
    "不要 memory_write progress.md 或 annotated-files.md。"
)

RESUME_APPLIED_NEXT_HINT = (
    "客户端工具已结束，用户已 Keep All：提案已写盘，file_written=true。"
    "可用 read_file_annotation 核对落盘结果；如任务要求报告，用 write_workspace_file 生成。"
    "报告中的每个数字必须来自工具返回或提案明细，禁止估算。"
    "不要对已写盘文件重复调用 auto_annotate 整文件重标；"
    "核对发现错标/漏标/重复框时，用 mutate_annotation 定向修正（带上 paths 或 annotation_ids）。"
    "提案已确认落盘，禁止再要求用户确认、Keep All 或查看提案。"
    "不要 memory_write progress.md 或 annotated-files.md。"
)


def _tool_call_id(tool_call: object) -> str:
    if isinstance(tool_call, dict):
        return str(tool_call.get("id") or tool_call.get("tool_call_id") or "").strip()
    return str(getattr(tool_call, "id", "") or "").strip()


def unanswered_tool_call_ids(lc_messages: list) -> set[str]:
    declared: set[str] = set()
    answered: set[str] = set()
    for message in lc_messages:
        if isinstance(message, AIMessage):
            for tool_call in message.tool_calls or []:
                call_id = _tool_call_id(tool_call)
                if call_id:
                    declared.add(call_id)
        elif isinstance(message, ToolMessage) and message.tool_call_id:
            answered.add(str(message.tool_call_id))
    return declared - answered


def enrich_resume_tool_result(result: str, *, proposals_applied: bool = False) -> str:
    """为 resume 的客户端工具结果补上 next_hint（已有则保留）。

    proposals_applied=True（用户已 Keep All）时同步修正 proposal_pending /
    file_written 标志，避免模型把已落盘提案误判为未确认。
    """
    try:
        data = json.loads(result)
    except json.JSONDecodeError:
        return result
    if not isinstance(data, dict):
        return result
    # 谎报防护：skipped/未生成提案的 mutate（Dismiss 后或被门禁拦下）不能标成已写盘。
    if proposals_applied and data.get("proposal_pending") is True:
        data["proposal_pending"] = False
        data["file_written"] = True
        data["next_hint"] = RESUME_APPLIED_NEXT_HINT
    elif not str(data.get("next_hint") or "").strip():
        data["next_hint"] = RESUME_NEXT_HINT
    return json.dumps(data, ensure_ascii=False)


def append_client_tool_results_to_messages(
    lc_messages: list,
    client_tool_results: list,
    *,
    user_content: str = "",
    proposals_applied: bool = False,
) -> list:
    """Resume 时补齐客户端工具的 ToolMessage；已有对应 AIMessage 时不再重复插入。"""
    if not client_tool_results:
        return lc_messages

    unanswered = unanswered_tool_call_ids(lc_messages)

    for ctr in client_tool_results:
        result = enrich_resume_tool_result(ctr.result, proposals_applied=proposals_applied)
        if ctr.tool_call_id in unanswered:
            lc_messages.append(
                ToolMessage(content=result, tool_call_id=ctr.tool_call_id),
            )
            unanswered.discard(ctr.tool_call_id)
            continue

        args: dict = {"user_request": user_content.strip()}
        try:
            parsed = json.loads(ctr.result)
            if isinstance(parsed, dict) and parsed.get("user_request"):
                args["user_request"] = str(parsed["user_request"])
        except Exception:
            pass
        lc_messages.append(
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": ctr.tool_call_id,
                        "name": ctr.name,
                        "args": args,
                    },
                ],
            ),
        )
        lc_messages.append(
            ToolMessage(content=result, tool_call_id=ctr.tool_call_id),
        )
    return lc_messages
