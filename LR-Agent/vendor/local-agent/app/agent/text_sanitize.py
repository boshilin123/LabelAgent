# 学习导航：清理可能导致 UTF-8 编码或 JSON 写入失败的孤立代理字符，供消息与标注载荷复用。
"""Unicode normalization for LLM-generated text."""

from __future__ import annotations

from typing import Any


# 删除不完整的 UTF-16 代理字符，保留正常文本，避免后续序列化出错。
def sanitize_unicode_text(text: str) -> str:
    """Remove lone UTF-16 surrogates that break downstream parsers."""
    if not text:
        return ""
    text = text.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return text.replace("\ufffd", "")


# 递归处理字典、列表中的字符串；数字、布尔值等其他类型保持原值。
def sanitize_json_value(value: Any) -> Any:
    """递归清洗快照/JSON 中的字符串，避免沙箱 UTF-8 写盘失败。"""
    if isinstance(value, str):
        return sanitize_unicode_text(value)
    if isinstance(value, dict):
        return {
            sanitize_unicode_text(k) if isinstance(k, str) else k: sanitize_json_value(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [sanitize_json_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(sanitize_json_value(item) for item in value)
    return value
