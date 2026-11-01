# 学习导航：工具包的兼容导出入口，build_tools_p1 的实际实现在 registry.py；默认装配会按模式调用 build_tools_by_name_set。
from app.agent.tools.registry import build_tools_p1

__all__ = ["build_tools_p1"]
