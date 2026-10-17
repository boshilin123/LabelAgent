# Runtime 运行时与项目实现学习笔记

> 2026-10-17 阅读提示：本文保留早期架构分析作为学习记录；当前默认已是 `create_agent` / LangGraph，LangSmith 为可选追踪，正式部署以《本地部署方案》为准。本项目不接入 RAG；原文中的相关设想不再属于开发范围。

## 1. 为什么要学习 Runtime

这里的 Runtime 可以先理解为：**Agent 真正开始工作以后，负责把用户请求、模型、工具、状态和存储连接起来的运行环境。**

模型本身只能接收一组消息并返回文本或工具调用。一个完整 Agent 还必须解决下面的问题：

- 这次请求属于哪个用户、工作区和项目？
- 应该把哪些历史消息发给模型？
- 模型请求调用工具时，由谁执行？
- 工具执行以后怎样继续让模型推理？
- 执行到一半需要用户确认时，怎样暂停和恢复？
- 应用重启以后，哪些数据仍然存在？
- 怎样避免模型重复执行已经完成的操作？

处理这些问题的代码和基础设施，合起来就是广义上的 Agent Runtime。

## 2. 行业里更常见的是框架 Runtime，还是自定义 Runtime

两种方式都很常见，不能简单地说某一种才符合规范。

### 2.1 简单 Agent：使用框架更常见

如果业务只是普通问答、少量工具调用、RAG 或简单审批，通常会使用 LangChain `create_agent`、LangGraph、OpenAI Agents SDK 等框架。

使用框架的主要价值不是少写一个模型请求，而是直接获得：

- 统一的 State 数据结构。
- 模型和工具之间的循环。
- 流式事件。
- Checkpoint 和断点恢复。
- Human-in-the-loop 暂停与继续。
- 重试、路由、追踪和调试能力。

这些能力如果全部自己实现，代码量和维护成本都会迅速增长。

### 2.2 深度业务系统：自定义或混合方案很常见

实际业务经常有框架无法直接表达的领域逻辑。例如 LabelAgent 需要：

- Electron 桌面端与本地文件系统。
- 图片标注和标注提案。
- Keep All / Dismiss / Undo。
- 标注文件变更前后的 checkpoint。
- 本地推理模型。
- 客户端工具与 Python 工具混合执行。
- 文件修改提案先展示、后写盘。
- 当前画布、选中标注和项目标签等 UI 状态。

这些功能不可能只靠一个通用 Agent 框架完成。因此常见的生产方案是：

> 使用框架承担通用编排，用自定义代码承担领域能力、安全边界和用户界面。

也就是说，“自定义代码很多”并不等于设计错误；关键要看自定义部分是否有清晰边界、稳定接口、持久化策略和可测试性。

### 2.3 对 LabelAgent 的判断

LabelAgent 当前采用的是：

> LangChain 消息与工具抽象 + 自定义 React/Electron/Python Runtime

它没有使用 LangGraph 的 `StateGraph`、`Runtime`、`ToolRuntime`、`context_schema` 或 checkpointer。

这不属于“不符合行业规范”，但属于**功能增长后出现明显架构债务的自定义 Runtime**。它能运行，也有不少正确的工程设计，但核心编排职责分布较散，新人阅读成本较高。

## 3. 什么是 Context、State 和 Store

可以用一次出差来理解这三个词。

### 3.1 Context：本次出差的身份和条件

例如：

- 你是谁。
- 要去哪个城市。
- 当前负责哪个客户。
- 公司允许报销什么。
- 可以使用哪些交通工具。

这些信息主要帮助执行者理解“当前环境”，通常不会在执行步骤之间被随意修改。

在 Agent 中，Context 常用于保存：

- 用户 ID。
- 工作区路径。
- 当前项目。
- 模型配置。
- 权限和运行模式。
- 当前可用的工具或外部服务。

### 3.2 State：出差过程中不断变化的进展

例如：

- 已购买机票。
- 正在等待审批。
- 已到达酒店。
- 报告写到第三部分。

State 描述“任务现在进行到哪里”，会随着执行不断变化。

在 Agent 中，State 常用于保存：

- 对话消息。
- 当前节点或任务阶段。
- 工具调用和工具结果。
- 正在运行、等待确认、完成或失败等状态。
- 中间分析结果。

### 3.3 Store：出差结束后仍然保存的档案

例如：

- 报销记录。
- 客户档案。
- 出差报告。
- 以后仍然有用的偏好。

Store 的核心特征是跨请求或跨会话存在。

在 Agent 中，Store 常用于保存：

- 会话和消息。
- 用户长期记忆。
- 业务结果。
- 执行 checkpoint。
- 可检索的文档或向量。

## 4. 模型上下文窗口与 Runtime Context 不是一回事

这两个概念很容易混淆。

### 4.1 模型上下文窗口

模型上下文窗口是某次 LLM API 调用真正收到的内容，包括：

- System Prompt。
- 用户与助手的历史消息。
- 工具定义。
- 工具调用结果。
- 图片或其他多模态输入。

它受到 token 数量限制。内容过长时，需要裁剪、摘要或按需检索。

### 4.2 Runtime Context

Runtime Context 是应用提供给执行过程的环境信息，例如：

- 当前工作区路径。
- 当前标注项目。
- 用户选择的工作模式。
- 当前打开的文件。
- Memory 作用域。

Runtime Context 不一定全部直接发给模型。应用可以只取其中一部分生成 Prompt，也可以只让工具函数在后台使用。

## 5. LabelAgent 的 Context 实现

项目中有两类上下文。

### 5.1 对话上下文

核心文件：

- `LR-Agent/src/renderer/services/turnContext.ts`
- `LR-Agent/src/renderer/services/contextPreparer.ts`

#### `buildTurnContextFromState()`

作用：从会话 State 中整理出模型能够理解的对话历史。

它会：

1. 按 `messageIds` 找到用户和助手消息。
2. 跳过正在流式生成的消息，因为它还没有完成。
3. 从消息 blocks 中抽取文本。
4. 对没有普通文本的标注消息生成简短预览。
5. 默认只保留最近 20 轮。
6. 将历史格式化为“用户：……”“助手：……”。
7. 将最终 transcript 限制在约 12,000 字符内。

输出的 `TurnContext` 包含：

- `lines`：所有有效对话行。
- `windowedLines`：窗口裁剪后保留的行。
- `transcript`：格式化后的对话文本。
- `summary`：更早历史的摘要。
- `currentUserContent`：本轮用户输入。

#### `prepareChatContext()`

作用：在真正调用模型前控制上下文长度。

主要流程：

1. 调用 `buildTurnContextFromState()`。
2. 用字符数除以 3 粗略估算 token。
3. 如果模型声明了上下文窗口，通过 `deriveMaxContextTokens()` 取窗口的 10% 作为会话历史预算，并限制在 8K～48K。
4. 当使用量超过预算的 85%，且历史轮数足够时，将即将被挤出的旧消息交给模型生成摘要。
5. 只把摘要之后的近期消息发送给主模型。
6. 摘要失败时退化为普通窗口裁剪，不阻塞用户发消息。

这里解决的是“历史越来越长，不能全部放进模型”的问题。

### 5.2 运行环境上下文

核心文件：

- `LR-Agent/src/renderer/services/agentClientContextBuilder.ts`
- `LR-Agent/src/renderer/services/agentClientContext.ts`
- `LR-Agent/vendor/local-agent/app/schemas/agent.py`
- `LR-Agent/vendor/local-agent/app/agent/context_snapshot.py`

#### `buildClientContextPayload()`

作用：在前端收集本轮 Agent 工作需要的环境信息。

它收集：

- `workspaceRoot`：当前打开的工作区根目录。
- `activeFilePath`：用户当前查看的文件。
- `activeAnnotationProjectId`：当前标注项目 ID。
- `annotationProjectSnapshot`：项目名称、模态、标注类型、标签和检测模型等快照。
- `agentMode`：Ask 或 Agent。
- `workMode`：普通编辑器或标注工作台。
- 当前选中的标注。
- MCP Server 地址和配置。
- 项目指令。
- Memory 索引。
- Skills catalog。
- 待确认提案台账和结构化提案状态。

这里使用“快照”一词，是因为发送请求时会复制一份当时的项目状态；后续 UI 再变化，不会自动改变已经发出的请求。

#### `buildApiClientContext()`

作用：将 TypeScript 使用的驼峰字段转换成 Python API 使用的下划线字段。

例如：

- `workspaceRoot` → `workspace_root`
- `activeFilePath` → `active_file_path`
- `proposalStates` → `proposal_states`

它是前端数据模型与后端请求协议之间的适配器。

#### `ClientContextInput`

它是 Python Pydantic Schema。作用是在请求进入 local-agent 时验证 Context 的字段类型，避免后续代码收到任意形状的数据。

#### `build_assist_system_prompt()`

作用：将 Context 中需要让模型知道的信息组装成 System Prompt，包括：

- 模型身份。
- 当前任务规则。
- 当前项目快照。
- 文件编辑纪律。
- 标注工具调用纪律。
- 项目指令。
- Skills catalog。
- 工作区长期记忆索引。
- 待确认提案台账。

本项目没有 LangGraph `ToolRuntime`。工具需要的 Context 是在注册工具时通过 Python 闭包或函数参数绑定进去的。

## 6. LabelAgent 的 State 实现

### 6.1 React 会话 State

核心文件：

- `LR-Agent/src/renderer/context/AgentChatContext.tsx`
- `LR-Agent/src/shared/agentTypes.ts`

`AgentChatProvider` 是前端 Agent 功能的总控制器，保存：

- 所有会话 `sessions`。
- 消息 `messagesBySession`。
- 当前会话和标签页。
- 正在编辑的消息。
- 当前模式。
- 是否正在准备上下文。
- 消息流式状态。
- 提案状态。

#### `sendMessage()`

这是用户点击发送以后最重要的入口函数。它负责：

1. 检查输入和当前会话。
2. 检查当前任务是否仍在执行。
3. 创建用户消息和 assistant 占位消息。
4. 将消息写入 UI State 和 SQLite。
5. 加载项目指令、Memory 和 Skills。
6. 构建 Context。
7. 裁剪或摘要对话历史。
8. 创建并启动 Chat Job。

因为职责很多，这也是当前代码看起来集中的原因之一。

#### `applyStreamEventToBlocks()`

作用：把后端不断返回的 SSE 事件归并成 UI 中可显示的消息块。

例如：

- `text_delta` 追加助手文本。
- `reasoning_delta` 追加思考内容。
- `tool_start` 创建或更新工具卡片。
- `tool_result` 保存工具结果。
- `annotation_proposal` 创建待确认标注提案。
- `awaiting_confirmation` 将消息改成等待确认。

它可以理解为一个 reducer：输入旧 State 和事件，产生新 State。

### 6.2 Job State

核心文件：

- `LR-Agent/src/renderer/services/agentJobRegistry.ts`

`RunningJob` 保存当前正在运行任务的：

- `AbortController`：用于取消网络请求和工具执行。
- 事件监听器。
- 当前 `JobState`。
- 所属会话。
- 等待恢复的工具结果。
- 恢复函数。

状态变化大致是：

```text
Registered
  → Streaming
  → ToolPending
  → Resuming
  → AwaitingConfirm
  → Done / Error / Cancelled
```

#### `startChatJob()`

作用：创建任务并选择执行路径。

- 没有工作区和工具需求时，可以直接请求 LLM。
- 有工作区或标注项目时，通过 local-agent 执行工具循环。

#### `runLoop()`

作用：完成“模型 → 工具 → 模型”的循环。

1. 将会话消息转换成后端消息。
2. 请求 local-agent SSE。
3. 接收模型输出。
4. 如果收到 `tool_pending`，执行客户端工具。
5. 将结果提交回后端继续推理。
6. 如果产生待确认提案，暂停为 `AwaitingConfirm`。

#### `runClientTool()`

作用：执行必须留在 Electron 客户端的工具，例如自动标注、标注修改和终端命令。

这些工具不能简单放在 Python 服务中，因为它们需要访问当前 UI 项目、Electron 能力、本地进程或用户确认。

### 6.3 Python 单次请求 State

核心文件：

- `LR-Agent/vendor/local-agent/app/agent/assist_service.py`
- `LR-Agent/vendor/local-agent/app/agent/assist/tool_loop.py`
- `LR-Agent/vendor/local-agent/app/agent/assist/task_phase.py`

#### `stream_assist()`

作用：建立一轮 Python 侧的模型与工具循环。

它创建：

- 当前消息列表。
- `ToolLoopRunner`。
- 视觉自动加载器。
- 提案流式拦截器。
- 已完成工具 ID 集合。

#### `ToolLoopRunner.execute_round()`

作用：处理模型当前一轮返回的 tool calls。

- 解析工具名和参数。
- 拦截不允许的调用。
- 并行执行允许并行的只读工具。
- 执行普通同步工具。
- 将异步客户端工具转成 `tool_pending`。
- 把工具结果追加为 `ToolMessage`，供下一轮模型继续推理。

#### `derive_task_phase()`

作用：根据提案事实推导当前任务阶段。

- 有 pending 标注提案 → `AWAIT_CONFIRM`。
- 有 applied 标注提案 → `VERIFY`。
- 没有相关提案 → 不启用阶段门禁。

这里没有直接保存 `phase`，而是每次从 `proposal_states` 重新计算。这叫派生状态，可以减少“阶段字段与真实提案状态不一致”的问题。

#### `check_call_allowed()`

作用：执行工具前做确定性安全检查。

例如：

- 尚未 Keep All 时，禁止继续写文件或重复标注。
- 已落盘后，禁止对同一文件再次整文件自动标注。
- 允许使用 `mutate_annotation` 定向修正具体标注。

这些规则放在代码中比只写进 Prompt 更可靠，因为模型即使没有遵守提示，也会被程序拦截。

## 7. LabelAgent 的 Store 实现

项目实际有多层 Store，每层保存不同性质的数据。

### 7.1 SQLite 会话 Store

核心文件：

- `LR-Agent/src/main/db/database.ts`
- `LR-Agent/src/main/db/sessionRepository.ts`
- `LR-Agent/src/main/db/messageRepository.ts`
- `LR-Agent/src/renderer/services/agentChatApi.ts`

Electron 使用 `sql.js` 创建本地 `lr-agent.db`。

主要保存：

- 会话。
- 消息。
- 消息 blocks。
- 模型和 provider。
- 对话摘要。
- 摘要覆盖位置。
- 提案状态。

`scheduleFlush()` 在数据库变化后等待 500ms 再写磁盘，避免每个流式事件都立即进行完整文件写入。应用关闭前会同步刷盘。

### 7.2 Markdown 长期记忆 Store

核心文件：

- `LR-Agent/src/main/memory/memoryStore.ts`
- `LR-Agent/src/renderer/services/agentMemory.ts`
- `LR-Agent/src/renderer/services/workspaceFactMemory.ts`

目录结构：

```text
userData/agent-memory/
└── projects/{annotationProjectId}/
    ├── MEMORY.md
    └── topics/
        ├── progress.md
        ├── annotated-files.md
        ├── preferences.md
        └── conventions.md
```

`MEMORY.md` 是短索引，会随请求注入 Prompt。具体 topic 通过 `memory_read` 按需读取。

这不是向量数据库，也不是语义检索。它使用“索引提示 + 精确读取文件”的渐进式披露方式。

### 7.3 标注领域真值 Store

真正的标注结果位于项目目录：

```text
.lr-agent/
├── project.json
└── annotations/
    ├── index.json
    └── files/*.json
```

它是业务事实来源。Memory 中的“已标多少文件”只是根据标注索引重新计算的派生信息，不应该反过来作为标注真值。

### 7.4 Undo Checkpoint Store

核心文件：

- `LR-Agent/src/main/checkpoint/turnCheckpointStore.ts`

主要函数：

- `captureCheckpoint()`：应用提案前保存旧内容。
- `recordCheckpointAfter()`：写盘后记录新内容 hash。
- `restoreCheckpoint()`：确认当前内容没有被其他操作改变后恢复旧内容。
- `discardCheckpoint()`：删除无用 checkpoint。

它通过 SHA-256 检查当前文件是否仍等于当时写入后的版本，从而避免 Undo 覆盖用户后来做出的修改。

这个 checkpoint 只用于文件和标注回滚，不是 LangGraph 的执行状态 checkpoint。

## 8. 一次真实请求的完整流程

```text
用户点击发送
  ↓
AgentChatProvider.sendMessage()
  ↓
创建用户消息和 assistant 占位消息
  ↓
prepareChatContext()
裁剪历史并按需生成摘要
  ↓
buildClientContextPayload()
收集工作区、项目、Memory、Skills、MCP 和提案状态
  ↓
startChatJob()
注册任务并建立取消、事件监听和恢复能力
  ↓
streamChatViaBackend()
POST /agent/chat/stream
  ↓
ClientContextInput
验证请求字段
  ↓
build_assist_system_prompt()
把需要让模型知道的 Context 组装为系统提示词
  ↓
stream_assist()
  ↓
ToolLoopRunner.execute_round()
模型输出 → 工具调用 → 工具结果 → 模型继续推理
  ↓
同步工具在 Python 执行
客户端工具通过 tool_pending 返回 Electron 执行
  ↓
若产生提案，进入 AwaitingConfirm
  ↓
用户 Keep All / Dismiss
  ↓
恢复同一 Job 或结束任务
  ↓
applyStreamEventToBlocks()
把 SSE 事件转换为 UI 消息块
  ↓
SQLite / Markdown Memory / .lr-agent / checkpoint 分层保存
```

## 9. 当前实现做得好的地方

### 9.1 Python local-agent 基本无状态

它不直接依赖会话数据库，而是从请求体取得消息和 Context。这让服务更容易重启、测试和独立运行。

### 9.2 请求 Schema 是显式的

TypeScript 有 `ClientContextPayload`，Python 有 `ClientContextInput`，比直接传任意字典可靠。

### 9.3 有确定性安全门禁

标注阶段限制不仅写在 Prompt 中，还由 `check_call_allowed()` 执行。

### 9.4 Human-in-the-loop 已经形成真实断点

提案不会立刻写盘，而是进入 `AwaitingConfirm`，等待用户 Keep All 或 Dismiss。

### 9.5 业务真值、会话和长期记忆分离

标注数据不会只存在模型消息或 Memory 中，降低了模型幻觉污染业务数据的风险。

### 9.6 Undo 有脏数据保护

Checkpoint 不会无条件覆盖磁盘上的新修改。

## 10. 为什么当前代码让人感觉散乱

这种感觉是有依据的，主要不是因为用了自定义 Runtime，而是以下边界还不够清晰。

### 10.1 `AgentChatProvider` 职责过多

它同时负责：

- UI State。
- 会话生命周期。
- 消息编辑。
- 上下文准备。
- Job 启动。
- SSE 消费。
- 提案确认与回滚。
- SQLite 持久化协调。

这类对象通常称为 God Object，即了解和控制太多系统细节的对象。

### 10.2 同一概念分布在多层

一条消息会同时存在于：

- React state。
- `stateRef`。
- SQLite。
- 发往 Python 的请求体。
- Python 的 LangChain messages。
- SSE 返回后的 MessageBlock。

这不是完全错误，但缺少一份明确的“谁是事实来源、何时同步、冲突如何解决”的架构约定。

### 10.3 Runtime Context 混入不同性质的数据

`ClientContextPayload` 同时包含：

- 环境身份。
- Prompt 内容。
- 安全敏感配置。
- MCP 凭据。
- Memory 索引。
- 提案业务状态。

它们生命周期和安全级别不同，长期更适合拆成多个明确对象。

### 10.4 等待确认的恢复能力只在进程内

`runningJobs` 是内存 Map。应用完全重启后：

- SQLite 中的消息仍然存在。
- 提案信息仍可能存在。
- 但原来的 `resumeWithResults` 函数和工具循环位置已经丢失。

因此它不是 durable execution。LangGraph checkpointer 的优势就是可以把图执行位置和 State 一起保存，并从中断位置继续。

### 10.5 缺少统一 Run/State 持久化模型

目前会话消息存得比较完整，但没有统一保存：

- run ID。
- 当前运行阶段。
- 已完成节点或工具。
- 重试次数。
- 中断原因。
- 恢复所需输入。

这会增加故障恢复和排查难度。

### 10.6 可观测性分散

虽然已有 debug logger 和大量事件，但还缺少统一 trace，把一次请求的前端 Job、Python 请求、模型调用、工具调用和写盘操作串成同一条链路。

## 11. 是否应该立刻迁移 LangGraph

不建议因为代码看起来散，就立刻整体重写成 LangGraph。

原因：

- 标注 UI、Electron 文件提案和本地推理仍然必须保留自定义实现。
- 一次性迁移容易引入行为回归。
- 当前功能已经能够运行，并有较多测试。
- 在没有先整理边界前，迁移可能只是把散乱代码换到新的框架文件中。

更稳妥的顺序是：先规范现有 Runtime，再决定是否用 LangGraph 替换核心编排。

## 12. 建议的渐进式整理方案

### 第一阶段：先明确概念和事实来源

定义三个独立类型：

```text
RuntimeContext
  只读的本轮环境与依赖

RunState
  当前一次任务可变化、可恢复的执行状态

PersistentStores
  会话、记忆、标注真值和 checkpoint 的统一访问入口
```

同时写清楚：

- React state 是 UI 投影，不是最终事实来源。
- SQLite 是会话与消息事实来源。
- `.lr-agent` 是标注业务事实来源。
- Markdown Memory 是可供 Agent 使用的长期辅助信息。

### 第二阶段：拆分 `AgentChatProvider`

可以逐步提取：

- `ChatSessionService`：会话创建、加载、编辑和删除。
- `ContextAssemblyService`：对话窗口、摘要、Runtime Context。
- `AgentRunController`：启动、停止、事件消费和恢复。
- `ProposalWorkflowService`：Keep All、Dismiss、Undo。
- `ChatPersistenceService`：SQLite 映射与写入。

React Context 最后只负责向组件暴露状态和用户操作。

### 第三阶段：增加持久化 Run 模型

为一次 Agent 执行保存：

- `runId`
- `sessionId`
- `status`
- `currentPhase`
- `pendingToolCalls`
- `completedToolResults`
- `interruptReason`
- `resumePayload`
- `createdAt` / `updatedAt`

并要求工具具有幂等键，避免恢复后重复写入。

### 第四阶段：再评估是否引入 LangGraph

如果以后出现以下需求，引入 LangGraph 的收益会明显增加：

- 多条复杂条件分支。
- 多个可恢复节点。
- 应用重启后继续执行。
- 跨机器 Worker。
- 更复杂的 Human-in-the-loop。
- 统一追踪、回放和时间旅行调试。

可以只让 LangGraph 接管 Python 编排层，Electron UI、客户端工具和领域 Store 继续保留。这样是混合迁移，不需要推翻整个项目。

## 13. 学习时建议重点区分的高级概念

### 13.1 Durable Execution

执行状态被持久化以后，即使进程重启，也能从上次中断处继续，而不是重新开始整轮任务。

### 13.2 Checkpoint

LangGraph checkpoint 保存的是图执行 State 和执行位置；本项目 checkpoint 保存的是文件修改前快照。两者名称相同，作用不同。

### 13.3 Human-in-the-loop

Agent 在敏感操作前暂停，等待用户批准、修改或拒绝，再恢复执行。

### 13.4 Idempotency

同一个工具请求即使因为重试执行两次，也不会造成重复写入或重复标注。这是实现可靠恢复的前提。

### 13.5 Derived State

能够从其他事实计算出来的数据不直接保存。例如任务阶段从提案状态推导，避免两份状态不一致。

### 13.6 Event Sourcing

不只保存最终结果，还保存导致状态变化的事件。系统可以通过事件重建状态、审计操作或回放故障。当前项目的 SSE 和 MessageBlock 已具有部分事件化特征，但还不是完整事件溯源系统。

### 13.7 Observability

使用统一 trace ID 记录一轮请求经过的模型调用、工具调用、耗时、错误、状态变化和写盘动作，帮助调试与性能分析。

## 14. 当前结论

LabelAgent 并不是“没有 Runtime”，而是 Runtime 没有以一个统一框架或目录出现。

它已经具备：

- Context 构建。
- 对话窗口和自动摘要。
- 消息与任务 State。
- 多轮工具循环。
- Human-in-the-loop。
- 长期记忆。
- 会话持久化。
- 业务真值存储。
- 文件级 Undo checkpoint。

它目前最主要的问题是：

> 编排职责、状态同步和持久化逻辑分布在多个层次，但没有统一的 Runtime 合约和清晰的事实来源说明。

因此最合理的改进方向是先“收边界、立契约、补恢复”，然后再决定是否将核心编排迁移到 LangGraph，而不是立即整体重写。

## 15. 参考资料

- LangChain 官方说明：LangChain Agent 建立在 LangGraph 原语上；需要更深定制时可直接使用 LangGraph。
  - https://docs.langchain.com/oss/python/learn
- LangGraph 官方 Thinking in LangGraph：State 应保存跨步骤需要的原始数据，可推导内容应在需要时计算。
  - https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph
- LangGraph Store/Checkpointer 示例：Checkpointer 保存图执行状态，Store 保存跨线程长期数据。
  - https://docs.langchain.com/oss/python/integrations/providers/aerospike
