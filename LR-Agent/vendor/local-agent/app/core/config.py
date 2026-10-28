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

    # 阶段 7 后端受控引擎开关（环境变量 AGENT_ENGINE，与其它 agent_* 字段同规则）：
    #   candidate（**阶段 8 行动 5 已切换为默认**）= app/agent/langchain_runtime/entry.py
    #                 的候选入口（官方 create_agent 承接模型—工具循环）；
    #   legacy                                    = 旧 /chat/stream 原路径，保留为回退开关。
    # 前端不参与选择。
    # ⚠️ 依赖前提：`candidate` 需要运行环境安装 `langchain` / `langgraph`
    #   当前正式环境是 .venvs\langchain-main，安装入口为 requirements.txt；
    #   只有 langchain-core 的旧环境不满足当前默认内核的依赖要求。
    # 切换依据见 docs/阶段8-对照度量.md（§6 清单）与 docs/阶段{4,5,7}-验收记录.md。
    agent_engine: Literal["legacy", "candidate"] = "candidate"

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
