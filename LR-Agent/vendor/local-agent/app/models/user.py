# 学习导航：本地工具所需的轻量 User 数据结构，只保留兼容字段；本文件不是云端数据库用户表。
"""本地 User stub。

云端 SQLAlchemy User 模型的轻量替代：Agent 工具（如 get_account_summary）
只需要读取用户基本字段，本地服务无数据库，由 Electron 在 client_context 中
携带账号信息；未登录时使用匿名 stub。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field


# 用 dataclass 保存本次工具构造需要的用户信息，本地入口通常注入匿名用户。
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
