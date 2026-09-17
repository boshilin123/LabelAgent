# LR-Agent Local

本机 Agent 编排服务，由 Electron 客户端 spawn，仅监听 `127.0.0.1`。

> 本服务内嵌于客户端仓库 `vendor/local-agent/`：开发模式由主进程从
> `app.getAppPath()/vendor/local-agent` 启动，打包后随客户端分发至
> `resources/local-agent`。

## 架构定位

- **LR-Agent-local（本服务）**：Assist 工具循环 SSE、标注 / 质量报告 LLM 编排
- **LR-Agent-backend（云端）**：仅用户认证与资料管理（auth / users）
- **LR-Agent-inference（`vendor/inference`）**：本地预训练模型推理（YOLO / SAM2 / Keypoint）

API Key 由前端在请求体中直传（BYOK），仅用于本次 LLM 调用，不落库、不经云端。

## 技术栈

- FastAPI + Uvicorn（仅 bind 127.0.0.1）
- LangChain（Assist 工具循环、标注 LLM 编排）
- langchain-mcp-adapters（连接 Electron 本地 MCP Server）

## 快速开始

### 1. Conda 环境

```bash
conda create -n lr-agent-local python=3.12 -y
conda activate lr-agent-local
pip install -r requirements.txt
```

也可设置环境变量让 Electron 自动查找：

- `LR_AGENT_LOCAL_PYTHON` — Python 可执行文件完整路径
- `LR_AGENT_LOCAL_CONDA_ENV` — conda 环境名（默认 `lr-agent-local`）

### 2. 启动

```bash
python local_main.py
# 或
uvicorn local_main:app --host 127.0.0.1 --port 8765
```

端口通过环境变量 `LR_AGENT_LOCAL_PORT` 覆盖（默认 8765）。

- 健康检查：http://127.0.0.1:8765/health
- OpenAPI 文档：http://127.0.0.1:8765/docs

## 项目结构

```
app/
├── agent/               # Assist / 标注 LLM 编排（与 backend 同源迁移）
├── api/v1/              # 路由（无认证、无 Redis 限流）
├── core/                # 精简 Settings、依赖注入
├── models/              # User stub（本地无数据库）
└── schemas/             # Pydantic DTO
local_main.py            # FastAPI 入口
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/agent/chat/stream` | Assist SSE 流式对话 |
| POST | `/api/v1/agent/chat/cancel` | 取消 Assist 任务 |
| POST | `/api/v1/agent/annotation/batch-prepare` | 批量标注范围+计划 |
| POST | `/api/v1/agent/annotation/mutation-prepare` | 标注变更准备 |
| POST | `/api/v1/agent/annotation/map-detection-boxes` | 检测框标签映射 |
| POST | `/api/v1/agent/annotation/judge-detection-labels` | 整图评分复核 |
| POST | `/api/v1/agent/annotation/map-heuristic` | 启发式映射（无 LLM） |
| POST | `/api/v1/agent/annotation/llm-generate` | 通用 LLM 生成代理（caption/cot/instruction 等） |
| POST | `/api/v1/agent/annotation-quality/*` | 质量报告 LLM 服务 |

## 与 backend 的差异

| 维度 | backend（云端） | local（本服务） |
|------|----------------|-----------------|
| 认证 | JWT + `CurrentUser` | 无（本机单用户） |
| 限流 | Redis | 无 |
| 数据库 | PostgreSQL | 无 |
| 配置 | 完整 `Settings` | 精简 `Settings`（仅 agent/annotation 字段） |
| 监听 | `0.0.0.0` | `127.0.0.1` |

## 测试

```bash
pytest
```

测试不依赖 PostgreSQL / Redis / MinIO。
