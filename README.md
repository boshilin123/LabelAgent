# LabelAgent / LR-Agent

基于 LR-Agent 的本地智能标注与 Agent 学习项目。桌面端使用 Electron / React，Agent 使用 FastAPI、LangChain `create_agent` 和 LangGraph，本地 YOLO 等模型负责推理；用户审核提案后应用标注。

项目主线是工作区工具调用、模型推理、SSE 流式交互和人工确认闭环。**本项目不需要 RAG，不引入向量知识库或向量数据库。** SQLite、Markdown Memory 和认证后端 PostgreSQL 各自承担现有职责。

## 部署与运行

- [Windows 本地部署方案](docs/本地部署方案.md)：首次安装、正式依赖、Docker 初始化和模型配置。
- [手工逐步启动与调试](docs/手工逐步启动与调试.md)：逐层检查后端、Agent、推理和桌面端。
- [新用户首次跑通流程](docs/新用户首次跑通流程.md)：Ask → Agent → 自动标注 → 人工确认 → 文件核验。
- [日常启动与故障排查](docs/日常启动与故障排查.md)。
- [2026-10-17 主流程验收记录](docs/2026-10-17本地主流程验收记录.md)：真实模型、YOLO、确认写盘与重启回读。
- [LangSmith / Studio 调试](docs/LangSmith-Studio-本地调试.md)：可选追踪与独立只读图调试。

完成首次安装后，在 PowerShell 中运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\Study\LR-Agent\scripts\start-lr-agent.ps1
```

缺少 LangSmith Key 不阻止启动。显式关闭追踪可添加 `-DisableTracing`。模型 Key 在桌面端“大模型配置”中填写，使用 Electron safeStorage 加密保存，不提交到 Git。

## 目录与版本

- `LR-Agent/`：桌面端、Local Agent 与 inference。
- `LR-Agent-backend/`：认证与用户资料 API；PostgreSQL、Redis、MinIO 配套容器。
- `scripts/`：本机启动、状态检查与环境相关脚本。
- `docs/`：中文部署、学习和验收记录。
- `demo/`、`weights/`：演示项目和 Git LFS 模型；本机专用数据按 `.gitignore` 排除。

当前默认引擎为 `candidate`，正式安装入口为 `LR-Agent/vendor/local-agent/requirements.txt`。`requirements-migration.txt` 仅保留为历史脚本兼容入口；`legacy` 是可选回退路径。迁移阶段文档是历史证据，当前部署以本页链接的部署方案为准。

本仓库保留上游许可与作者信息；个人学习与改造提交推送到 `boshilin123/LabelAgent`。
