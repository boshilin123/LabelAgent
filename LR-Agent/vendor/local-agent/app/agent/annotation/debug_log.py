# 学习导航：统一标注链路的结构化日志，使用 stage 区分准备、映射、重试等步骤。
"""Structured logs for batch annotation debugging (uvicorn terminal)."""
from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


# 把阶段、说明和额外字段写入日志，便于追踪一次标注处理的输入条件与结果。
def log_annotation_agent(stage: str, message: str, **fields: Any) -> None:
    if fields:
        try:
            extra = json.dumps(fields, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            extra = str(fields)
        logger.info("[annotation_agent] [%s] %s | %s", stage, message, extra)
    else:
        logger.info("[annotation_agent] [%s] %s", stage, message)
