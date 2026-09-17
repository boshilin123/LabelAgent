"""LR-Agent-local 测试配置：无数据库 / Redis / SMTP 依赖。"""

import os

os.environ.setdefault("APP_ENV", "testing")

from app.core.config import get_settings

get_settings.cache_clear()
