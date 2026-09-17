"""本地服务依赖注入：Settings + 本地 token 鉴权。

LR_AGENT_LOCAL_TOKEN 由 Electron 主进程在 spawn 子进程时通过环境变量注入，
渲染层请求时携带 `Authorization: Bearer <token>`。失败关闭：未配置 token 时
拒绝所有 API 请求（仅 /health 保持开放），避免本机其它进程或网页调用该服务。
"""

import hmac
import logging
import os
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

SettingsDep = Annotated[Settings, Depends(get_settings)]

LOCAL_TOKEN_ENV = "LR_AGENT_LOCAL_TOKEN"
_BEARER_PREFIX = "bearer "


def get_expected_local_token() -> str | None:
    return (os.environ.get(LOCAL_TOKEN_ENV) or "").strip() or None


async def require_local_token(request: Request) -> None:
    """校验本机服务访问 token。"""
    expected = get_expected_local_token()
    if expected is None:
        logger.error(
            "LR_AGENT_LOCAL_TOKEN 未配置：拒绝 API 请求（仅 /health 可用）"
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="local_token_not_configured",
        )

    header = request.headers.get("authorization") or ""
    provided = (
        header[len(_BEARER_PREFIX):].strip()
        if header.lower().startswith(_BEARER_PREFIX)
        else ""
    )
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="unauthorized",
        )
