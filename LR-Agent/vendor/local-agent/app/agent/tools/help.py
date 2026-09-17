"""LR-Agent 应用功能说明，供 get_lr_agent_help 工具返回。"""

LR_AGENT_HELP = """# LR-Agent 功能概览

- **资源管理器**：浏览本地文件夹与文件
- **标注任务**：创建与管理图像标注项目
- **预训练模型**：配置用于辅助标注的模型
- **大模型配置**：添加 OpenAI 兼容 API（如通义、DeepSeek）
- **Agent 面板**：右侧对话助手，可搜索/读取工作区代码与文档、看图、查已有标注、写文件提案（确认后落盘）；大范围摸底可用 explore_readonly

**Ask 模式**：问答、搜索代码、读文本/文档、看图；标注任务中还可查已有标注。不修改文件、不写入标注。
**编辑器 Agent**：可改代码/文档（提案确认后落盘），不能标注。
**标注任务 Agent**：批量检测与提案；标注变更（改标签/删框）；报告/文档（Markdown）。
执行批量写入或变更标注请传入明确 paths（或用户明确要求全部时 all_files=true）；查某张图已有标注在 Ask 即可。"""


def get_lr_agent_help(topic: str | None = None) -> str:
    """按 topic 关键词返回功能说明；无 topic 时返回完整概览。"""
    if not topic or not topic.strip():
        return LR_AGENT_HELP
    needle = topic.strip().lower()
    if "标注" in needle or "annotation" in needle:
        return (
            "标注任务在左侧活动栏「标注任务」中创建。"
            " **Ask**：分析与建议，不修改文件、不执行批量标注。"
            "**标注 Agent**：新增/重写用 auto_annotate，改已有标注用 mutate_annotation。"
            "**编辑器 Agent**：只改代码/文档，不能标注。"
        )
    if "模型" in needle or "model" in needle:
        return "预训练模型在左侧「预训练模型」面板配置，供标注工作区推理使用。"
    if "agent" in needle or "对话" in needle:
        return "Agent 在右侧活动栏打开，在「大模型配置」中添加 OpenAI 兼容 API Key 即可使用。"
    return LR_AGENT_HELP
