# 学习导航：从模型回答文字中尽力提取 JSON 对象，兼容回答被代码块或额外文字包围的情况。
"""Extract JSON objects from LLM text responses."""
from __future__ import annotations

import json
import re
from typing import Any


# 先尝试直接解析，再尝试大括号包围的片段；失败或非对象类型时返回空字典。
def extract_json_object(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        raw = re.sub(r"^json\s*\n", "", raw, flags=re.IGNORECASE)
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        return {}
    try:
        data = json.loads(match.group(0))
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}
