<p align="center">
  <a href="https://github.com/MarisaMagic/LR-Agent">
    <img alt="LR-Agent Logo" width="200" src="./assets/icon.png">
  </a>
</p>

<h1 align="center">LR-Agent</h1>

## 项目简介

基于 Electron + React + FastAPI + LangChain 的多模态 AI 智能标注平台。

支持矩形框、旋转框、多边形、关键点、图像/文本分类、Caption、指令遵循、思维链与实体识别等标注场景，以及支持多轮对话、长短期记忆、MCP 工具使用、Agent Skills 使用。

智能体基于 Tool-Use-Loop 自主规划，按需调用工作区检索、自动标注、会话与工作区记忆、子代理、Skill 技能、MCP 工具等完成任务。

---


## 核心功能

### 用户登录

![](./assets/LR-Agent-imgs/user-login-01.png)


### 环境配置向导

> 可以根据向导完成 AI Agent 本地编排、预训练模型推理的环境配置。也可自行安装，然后自动检测环境是否满足要求。

![](./assets/LR-Agent-imgs/install-environment-1.png)


### 任务创建

> 可自定义任务路径、任务类型（应用预设）、标签设置等。

![](./assets/LR-Agent-imgs/create-task-1.png)


### 任务列表

> 左侧可查看创建的任务列表，每个人物更多选项可进行自定义配置。

![](./assets/LR-Agent-imgs/annotate-tasklist-01.png)


### 查看与标注内容

> 支持图像-矩形框、图像-多边形、图像-caption 以及 多种其它图像、文本任务的内容查看与手动标注。

![](./assets/LR-Agent-imgs/annotate-img-1.png)
![](./assets/LR-Agent-imgs/annotate-img-2.png)
![](./assets/LR-Agent-imgs/annotate-img-3.png)
![](./assets/LR-Agent-imgs/annotate-text-1.png)
![](./assets/LR-Agent-imgs/annotate-text-2.png)

### 标注列表

> 右侧栏标注列表可查看数据已有的标注

![](./assets/LR-Agent-imgs/annotate-list-1.png)
![](./assets/LR-Agent-imgs/annotate-list-2.png)


### 标注导出

> 标注任务的更多选项中，可导出目前已有的标注。支持多种可用于后续模型训练的格式。

![](./assets/LR-Agent-imgs/annotation-export.png)


### 预训练模型配置

> 可配置目前已支持图像任务类型所用的预训练模型，包括 YOLO、SAM。

![](./assets/LR-Agent-imgs/annotate-pretrained-models-1.png)
![](./assets/LR-Agent-imgs/annotate-pretrained-models-2.png)


### 大模型配置

> 可配置 OpenAI 兼容端口大模型，可选择子代理配置。支持多模态视觉探针检测大模型是否具备视觉能力。

![](./assets/LR-Agent-imgs/annotate-llm-1.png)
![](./assets/LR-Agent-imgs/annotate-llm-2.png)


### MCP

> 可配置 MCP 远程接入外部工具。支持添加 MCP 广场中的预设工具，也支持自定义端点。支持 Streamable HTTP / SSE。

![](./assets/LR-Agent-imgs/annotate-mcp-1.png)
![](./assets/LR-Agent-imgs/annotate-mcp-2.png)


### Skills

> 可查看本地安装的 Agent Skills。缺口：目前仅做了渐进式读取 Skills 中的文档，暂时不支持脚本运行。

![](./assets/LR-Agent-imgs/annotate-skills-1.png)


### AI Agent

> 支持在 AI Agent 对话中切换 Ask / Agent 模式。可自由输入问题，例如辅助标注、查阅文档、编辑文件、检索内容、下载模型、运行命令等需求。AI Agent 通过 Tool-Use-Loop 自主调用工具完成任务。

![](./assets/LR-Agent-imgs/annotate-agent-1.png)
![](./assets/LR-Agent-imgs/annotate-agent-2.png)
![](./assets/LR-Agent-imgs/annotate-agent-3.png)
![](./assets/LR-Agent-imgs/annotate-agent-4.png)

> 另外，支持启动子代理完成一些只读任务。

![](./assets/LR-Agent-imgs/subagent-1.png)
![](./assets/LR-Agent-imgs/subagent-2.png)


### 快捷 LLM 推理

> 快捷 LLM 推理仅用于单条数据 / 单张图片的标注生成。

![](./assets/LR-Agent-imgs/annotate-fast-1.png)


### 质量面板

> 可查看标注任务下的标注情况，包括标签分布、标注覆盖率等。另外，可以生成质量看板报告。缺口：目前仅支持部分图像任务。

![](./assets/LR-Agent-imgs/annotate-quality-1.png)



---


## 应用端本地部署（开发者）

### 前置环境

- Node.js ≥ 18，npm ≥ 7
- Conda（本机 Agent 编排、预标注推理）

### 安装前端依赖

```bash
# 在项目根目录安装前端依赖
npm install
```

### 本机 Python 环境依赖

Electron 会自己拉起 AI Agent 编排、预训练模型标注两个服务，一般不用手动开进程。如果没有自己预先安装，可以在启动项目时根据向导安装 Agent 编排、预训练模型标注所需环境。

### local-agent（AI Agent 编排）

```bash
conda create -n lr-agent-local python=3.12 -y
conda activate lr-agent-local
pip install -r vendor/local-agent/requirements.txt
```

### inference（预训练模型标注，可选）

源码在 `vendor/inference`。有 NVIDIA 显卡用 GPU 清单，否则用 CPU。

```bash
conda create -n lr-agent-inference python=3.12 -y
conda activate lr-agent-inference
pip install -r vendor/inference/requirements-gpu.txt
# 或：pip install -r vendor/inference/requirements-cpu.txt
```

---


## 服务端本地部署（建议）

服务端做了简易的账号注册、登录功能。[LR-Agent-backend](https://github.com/MarisaMagic/LR-Agent-backend)

部署方式具体可见后端项目 README。建议 `docker compose up -d --build` 一键快速部署后端服务。

---


## 启动应用

```bash
npm run dev
```

dev server 已在 1212 端口时，只开窗口：

```bash
npm run dev:open
```

完整开发链（端口检查 + 编译 main + renderer）：

```bash
npm start
```

## 打本机安装包

```bash
npm run package
```
