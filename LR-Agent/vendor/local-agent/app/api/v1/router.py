# 学习导航：汇总聊天 Agent、标注处理和质量报告路由；local_main.py 再统一添加 /api/v1 前缀与 token 依赖。
from fastapi import APIRouter

from app.api.v1 import (
    agent,
    annotation_agent,
    annotation_quality,
)

api_router = APIRouter()
api_router.include_router(agent.router)
api_router.include_router(annotation_agent.router)
api_router.include_router(annotation_quality.router)
