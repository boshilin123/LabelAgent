"""LR-Agent-local 本地配置。

仅保留 Agent 编排相关字段；账号 / 数据库 / Redis / MinIO / SMTP 等云端配置
仍由 LR-Agent-backend 持有，本地服务不涉及。
"""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "LR-Agent Local"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"

    # 本地服务只监听 127.0.0.1，CORS 默认放开 Electron renderer
    cors_origins: list[str] = ["http://localhost:1212"]

    # Assist 工具循环（可用 AGENT_MAX_TOOL_ROUNDS / AGENT_SUBAGENT_MAX_TOOL_ROUNDS 覆盖）
    agent_max_tool_rounds: int = 30
    agent_subagent_max_tool_rounds: int = 12
    # MCP 工具发现结果缓存时长（秒）：避免每条消息都重新建连列工具。
    # 过期后走 stale-while-revalidate（先返回旧列表、后台刷新），所以这里可以放长。
    agent_mcp_tools_ttl_seconds: float = 1800.0

    # 上下文 / 读取限制
    agent_chat_vision_max_edge: int = 1280
    agent_chat_vision_jpeg_quality: int = 85
    agent_read_file_max_bytes: int = 524_288
    agent_read_file_max_lines: int = 2000
    agent_read_document_max_pages: int = 30
    agent_grep_max_results: int = 100
    agent_grep_max_files_scanned: int = 1000
    agent_list_dir_max_entries: int = 80

    # 功能开关
    agent_mutation_enabled: bool = True

    # 标注 LLM
    annotation_llm_temperature: float = 0.0
    annotation_prepare_temperature: float = 0.1
    # 生成类标注（caption/分类等）发送给 LLM 的图片压缩参数
    annotation_llm_image_max_edge: int = 1280
    annotation_llm_image_jpeg_quality: int = 85
    annotation_vision_map_concurrency: int = 3
    annotation_vision_map_validate: bool = True
    annotation_vision_map_max_retries: int = 1
    annotation_label_pool_preflight: Literal["off", "auto", "always"] = "auto"
    annotation_label_pool_preflight_min_extra: int = 2


@lru_cache
def get_settings() -> Settings:
    return Settings()
