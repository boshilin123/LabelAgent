"""写文件 / 局部替换工具的 tool_call_chunks 流式拦截器。

在 LLM astream 过程中，按 tc_index 递增解析 JSON 参数，实时发射提案 SSE 事件：
  - write_workspace_file → file_proposal_start + file_proposal_delta（content 增量）
  - str_replace_workspace_file → file_proposal_start(mode=edit) + file_edit_delta
    （old_string / new_string 增量，前端据此渲染变更区域的局部 diff）

注意：tc_index 每个推理轮次都从 0 重新编号，拦截器实例不能跨轮复用
（assist_service 每轮新建实例）。作为兜底，on_chunk 依据 tool_call id
检测同一 tc_idx 上的新调用并自动重置状态，防止上一轮的 rel_path /
content_sent_len 残留导致提案 delta 错标路径、丢失新内容前缀。
"""

from collections.abc import AsyncIterator

from app.schemas.agent import ClientContextInput, StreamEventPayload
from app.agent.tools.workspace_path import (
    is_lr_agent_relative,
    normalize_write_display_path,
)

WRITE_TOOL_NAME = "write_workspace_file"
EDIT_TOOL_NAME = "str_replace_workspace_file"

_HEX_DIGITS = set("0123456789abcdefABCDEF")


def _decode_unicode_escape(buf: str, u_pos: int) -> tuple[str | None, int]:
    """解码以 buf[u_pos]（'u' 字符）开头的 \\uXXXX 转义。

    返回 (解码文本, 从 u_pos 起消耗的字符数)；序列不完整时返回 (None, 0)，
    由调用方暂停解析、等待更多分片后整体重解析。支持代理对。
    """
    hex_part = buf[u_pos + 1 : u_pos + 5]
    if len(hex_part) < 4:
        return None, 0
    if any(ch not in _HEX_DIGITS for ch in hex_part):
        # 非法转义：按字面输出并跳过，避免解析卡死
        return "u", 1
    cp = int(hex_part, 16)
    if 0xD800 <= cp <= 0xDBFF:
        low_esc = buf[u_pos + 5 : u_pos + 7]
        low_hex = buf[u_pos + 7 : u_pos + 11]
        if (
            low_esc == "\\u"
            and len(low_hex) == 4
            and all(ch in _HEX_DIGITS for ch in low_hex)
            and 0xDC00 <= int(low_hex, 16) <= 0xDFFF
        ):
            low = int(low_hex, 16)
            combined = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00)
            return chr(combined), 11
        return "\ufffd", 5
    if 0xDC00 <= cp <= 0xDFFF:
        # 孤立低代理
        return "\ufffd", 5
    return chr(cp), 5


def _extract_json_string(buf: str, key: str) -> tuple[str | None, bool]:
    """从可能不完整的 JSON 缓冲区中提取字符串字段值。

    处理标准 JSON 转义（\\n \\t \\r \\\\ \\" \\uXXXX），返回 (解码后的字符串, 是否已闭合)。
    若 key 尚未出现则返回 (None, False)；
    若出现但字符串值未闭合引号则返回 (已累积部分, False)；
    若字符串值已闭合引号则返回 (完整值, True)。
    """
    idx = buf.find(f'"{key}"')
    if idx == -1:
        return None, False
    try:
        colon = buf.index(":", idx)
        quote = buf.index('"', colon + 1)
    except ValueError:
        return None, False
    result: list[str] = []
    i = quote + 1
    while i < len(buf):
        c = buf[i]
        if c == "\\" and i + 1 < len(buf):
            nxt = buf[i + 1]
            if nxt == "u":
                text, consumed = _decode_unicode_escape(buf, i + 1)
                if text is None:
                    break
                result.append(text)
                i += 1 + consumed
                continue
            esc: dict[str, str] = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"'}
            result.append(esc.get(nxt, nxt))
            i += 2
        elif c == '"':
            return "".join(result), True
        else:
            result.append(c)
            i += 1
    return ("".join(result) if result else None), False


class ProposalStreamInterceptor:
    """拦截 LLM astream 的 tool_call_chunks，实时生成 file_proposal SSE。"""

    def __init__(self, client_context: ClientContextInput | None = None) -> None:
        # client_context 用于把模型给的 relative_path 归一为与工具结果定稿
        # 事件一致的显示路径（绝对路径/./ 前缀/反斜杠都会被归一），
        # 否则前端按路径匹配提案块会裂成两张卡片。
        self.client_context = client_context
        # fp_states: tc_index → {args_buf, title_sent, content_sent_len, rel_path, call_id}
        self.fp_states: dict[int, dict] = {}

    @staticmethod
    def _new_state(call_id: str = "", kind: str = "write") -> dict:
        return {
            "args_buf": "",
            "title_sent": False,
            "kind": kind,
            "content_sent_len": 0,
            "old_sent_len": 0,
            "new_sent_len": 0,
            "rel_path": "",
            "call_id": call_id,
        }

    @staticmethod
    def _merge_args(state: dict, tc_args: str) -> None:
        """合并参数分片，兼容增量式与累积式两种 provider 行为，重复投递幂等。"""
        if not tc_args:
            return
        buf = state["args_buf"]
        if tc_args.startswith(buf):
            # 首个分片或累积式 provider
            state["args_buf"] = tc_args
        elif buf.startswith(tc_args):
            # 已见前缀的重复投递，忽略
            return
        else:
            state["args_buf"] = buf + tc_args

    def on_chunk(self, chunk) -> list[StreamEventPayload]:
        """处理一个 AIMessageChunk，返回需要产出的 SSE 事件。"""
        events: list[StreamEventPayload] = []
        for tc in chunk.tool_call_chunks or []:
            tc_name = tc.get("name")
            tc_args = tc.get("args") or ""
            tc_idx = tc.get("index")

            if tc_idx is None:
                continue

            if tc_name in (WRITE_TOOL_NAME, EDIT_TOOL_NAME):
                tc_id = tc.get("id") or ""
                kind = "edit" if tc_name == EDIT_TOOL_NAME else "write"
                state = self.fp_states.get(tc_idx)
                if state is None:
                    state = self.fp_states[tc_idx] = self._new_state(tc_id, kind)
                elif tc_id and state.get("call_id") and tc_id != state["call_id"]:
                    # 同一 tc_idx 上出现了新的 tool_call：重置状态。否则
                    # 上一轮的 rel_path 会错标本轮 delta 的归属路径，
                    # content_sent_len 会吞掉新内容的前缀。
                    state = self.fp_states[tc_idx] = self._new_state(tc_id, kind)
                elif state.get("kind") != kind:
                    state = self.fp_states[tc_idx] = self._new_state(tc_id, kind)
                self._merge_args(state, tc_args)
            elif tc_idx in self.fp_states and tc_args:
                self._merge_args(self.fp_states[tc_idx], tc_args)

            if tc_idx in self.fp_states and self.fp_states[tc_idx]["args_buf"]:
                state = self.fp_states[tc_idx]
                if not state["title_sent"]:
                    rel_path, rel_closed = _extract_json_string(
                        state["args_buf"], "relative_path"
                    )
                    if rel_path and rel_closed:
                        state["title_sent"] = True
                        if is_lr_agent_relative(rel_path):
                            state["suppressed"] = True
                        else:
                            state["rel_path"] = normalize_write_display_path(
                                self.client_context, rel_path
                            )
                            events.append(
                                StreamEventPayload(
                                    type="file_proposal_start",
                                    summary=state["rel_path"],
                                    image_path=state["rel_path"],
                                    detail="0",
                                    mode=(
                                        "edit"
                                        if state["kind"] == "edit"
                                        else None
                                    ),
                                )
                            )

                if state.get("suppressed"):
                    continue

                if state["kind"] == "edit":
                    events.extend(self._edit_delta_events(state))
                    continue

                content, _ = _extract_json_string(state["args_buf"], "content")
                if content is not None and len(content) > state["content_sent_len"]:
                    delta = content[state["content_sent_len"]:]
                    state["content_sent_len"] = len(content)
                    if delta:
                        events.append(
                            StreamEventPayload(
                                type="file_proposal_delta",
                                content=delta,
                                image_path=state.get("rel_path"),
                            )
                        )
        return events

    @staticmethod
    def _edit_delta_events(state: dict) -> list[StreamEventPayload]:
        """提取 old_string / new_string 增量，合并为一个 file_edit_delta 事件。"""
        buf = state["args_buf"]
        old_delta: str | None = None
        new_delta: str | None = None
        old_val, _ = _extract_json_string(buf, "old_string")
        if old_val is not None and len(old_val) > state["old_sent_len"]:
            old_delta = old_val[state["old_sent_len"]:]
            state["old_sent_len"] = len(old_val)
        new_val, _ = _extract_json_string(buf, "new_string")
        if new_val is not None and len(new_val) > state["new_sent_len"]:
            new_delta = new_val[state["new_sent_len"]:]
            state["new_sent_len"] = len(new_val)
        if not old_delta and not new_delta:
            return []
        return [
            StreamEventPayload(
                type="file_edit_delta",
                image_path=state.get("rel_path"),
                old_delta=old_delta,
                new_delta=new_delta,
            )
        ]

    def collected_paths(self) -> set[str]:
        """返回拦截器已发送过 file_proposal_start 的显示路径集合（已归一化）。"""
        return set(self.streamed_paths_by_call_id().values())

    def streamed_paths_by_call_id(self) -> dict[str, str]:
        """call_id → 已流式过 start 的显示路径（已归一化）。

        tool_loop 定稿时用它抑制重复的 start/假 delta burst；工具报错时
        据此对已出卡的路径补发 dismissed 终态，避免卡片悬挂。
        无 call_id 的状态无法关联回具体调用，不进入本映射。
        """
        streamed: dict[str, str] = {}
        for state in self.fp_states.values():
            args_buf = state.get("args_buf", "")
            rel_path, rel_closed = _extract_json_string(args_buf, "relative_path")
            if (
                rel_path
                and rel_closed
                and state.get("title_sent")
                and not state.get("suppressed")
            ):
                call_id = state.get("call_id") or ""
                streamed[call_id] = state.get("rel_path") or (
                    normalize_write_display_path(self.client_context, rel_path)
                )
        return streamed
