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
