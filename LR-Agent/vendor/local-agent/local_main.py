"""LR-Agent-local 入口：本机 Agent 编排服务。

由 Electron 主进程 spawn，仅监听 127.0.0.1。
承担 Assist 工具循环 SSE、标注 / 数据分析 / 质量报告 LLM 编排；
用户认证与资料管理仍由云端 LR-Agent-backend 负责。
"""

import logging
import os
import sys

import uvicorn
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.deps import require_local_token

logger = logging.getLogger(__name__)


def configure_utf8_console() -> None:
    """尽量让 stdout/stderr 在 Windows 控制台使用 UTF-8。"""
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title=settings.app_name,
        debug=settings.debug,
    )

    cors_origins = [origin.strip() for origin in settings.cors_origins if origin.strip()]
    # allow_credentials=True 与通配符 origin 组合会让任意站点携带凭据访问，直接拒绝启动
    if any(origin == "*" for origin in cors_origins):
        raise RuntimeError(
            "cors_origins 不能包含 '*': allow_credentials=True 时禁止通配符"
        )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(
        api_router,
        prefix=settings.api_v1_prefix,
        dependencies=[Depends(require_local_token)],
    )

    @app.get("/health", tags=["health"])
    async def health_check() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()

if __name__ == "__main__":
    configure_utf8_console()

    port = int(os.environ.get("LR_AGENT_LOCAL_PORT", "8765"))
    uvicorn.run(
        "local_main:app",
        host="127.0.0.1",
        port=port,
        reload=False,
        use_colors=True,
    )
