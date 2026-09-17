"""本地 User stub。

云端 SQLAlchemy User 模型的轻量替代：Agent 工具（如 get_account_summary）
只需要读取用户基本字段，本地服务无数据库，由 Electron 在 client_context 中
携带账号信息；未登录时使用匿名 stub。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field


@dataclass
class User:
    email: str
    id: uuid.UUID = field(default_factory=uuid.uuid4)
    email_verified: bool = False
    username: str | None = None
    display_name: str | None = None
    # 兼容云端模型字段；本地服务不使用，仅避免调用方传参报错
    password_hash: str = ""
    is_active: bool = True
