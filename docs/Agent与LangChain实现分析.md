# LR-Agent Agent 与 LangChain 实现分析

> 2026-10-17 阅读提示：本文保留早期架构分析作为学习记录；当前默认已是 `create_agent` / LangGraph，LangSmith 为可选追踪，正式部署以《本地部署方案》为准。本项目不接入 RAG；原文中的相关设想不再属于开发范围。

> 分析对象：`LR-Agent/vendor/local-agent`（Python Agent 编排）、`LR-Agent/src`（Electron/React）、`LR-Agent-backend`（云端认证）
> 分析日期：以仓库当前工作区状态为准
> 配套文档：`docs/Runtime运行时与项目实现学习笔记.md`（Context / State / Store 视角）、`docs/智能体自学阶段规划.md`（学习路线视角）

本文与已有笔记的分工：

| 文档 | 视角 |
|------|------|
| `Runtime运行时与项目实现学习笔记.md` | 架构级：Context / State / Store、与 LangGraph 的差距、改进路线 |
| **本文** | **代码级：Agent 编排逐层实现 + LangChain 的真实用法与未用部分** |

---

## 一、结论先行

### 1.1 一句话概括

LR-Agent 的 Agent 层是 **「LangChain 消息与工具抽象 + 自研 Tool-Use-Loop 运行时」**。

LangChain 在这里**只被当作一个薄适配层**使用：它提供消息类型、工具抽象和 OpenAI 兼容客户端；而**循环控制、工具调度、人工确认（HITL）、断点恢复、阶段门禁全部是自研代码**。

### 1.2 LangChain 用到了什么 / 没用到什么

| 类别 | 是否使用 | 具体 |
|------|---------|------|
| `ChatOpenAI`（`langchain-openai`） | ✅ 核心 | LLM 客户端，`astream` / `ainvoke` / `bind_tools` / `bind` |
| 消息类型（`langchain-core.messages`） | ✅ 核心 | `SystemMessage` / `HumanMessage` / `AIMessage` / `ToolMessage` / `AIMessageChunk` |
| `StructuredTool`（`langchain-core.tools`） | ✅ 核心 | 全部工具的统一抽象 |
| `langchain-mcp-adapters` | ✅ | 把 MCP Server 的工具转成 `StructuredTool` |
| `langchain`（元包） | ❌ 未安装 | `requirements.txt` 只有 `langchain-core` |
| **LangGraph** | ❌ 未使用 | 无 `StateGraph` / `checkpointer` / `interrupt` |
| `AgentExecutor` / `create_react_agent` / `create_agent` | ❌ 未使用 | 循环自己写 |
| `with_structured_output` / `response_format` | ❌ **刻意回避** | 见 §3.6 |
| Output Parser（`PydanticOutputParser` 等） | ❌ 未使用 | 自研 `extract_json_object` + 白名单 + Pydantic 校验 |
| Memory 类（`ConversationBufferMemory` 等） | ❌ 未使用 | 自研 SQLite 会话 + Markdown 记忆 |
| Callbacks / LangSmith tracing | ❌ 未使用 | 自研 `agentDebugLogger` |
| VectorStore / Embeddings / Retriever | ❌ 未使用 | 项目当前**没有 RAG** |

> 验证方式：对 `vendor/local-agent` 全量正则检索 `langgraph|create_agent|AgentExecutor|langsmith|with_structured_output|PydanticOutputParser|VectorStore|embeddings` → **0 命中**。

### 1.3 依赖清单（`vendor/local-agent/requirements.txt`）

```
fastapi==0.136.3          uvicorn==0.47.0        pydantic==2.13.4
langchain-core==1.4.0     langchain-openai==1.2.2
langchain-mcp-adapters==0.3.0                    mcp==1.28.0
openai==2.40.0            pillow==12.2.0
pytest==9.0.3             pytest-asyncio==1.3.0  httpx==0.28.1
```

不装 `torch`、不装数据库驱动、不装 Redis —— 这是个**纯编排服务**。

### 1.4 代码规模与质量基线

| 项 | 值 |
|----|----|
| Python Agent 代码 | **7,852 行**（`vendor/local-agent/app/` 下 63 个 py 文件） |
| 最大单文件 | `tool_loop.py` 641 行、`workspace_file_reader.py` 640 行、`registry.py` 520 行 |
| 测试文件 | 37 个 |
| **实测测试结果** | **302 passed, 2 skipped（6.32s）** |
| 前端 Agent 代码 | `agentChatStore.ts` 1,278 行、`agentJobRegistry.ts` 966 行、`agentProposalApply.ts` 633 行 |
| 整个 `src/`（不含测试） | 418 个 ts/tsx 文件，69,261 行 |

结论：这不是一个玩具项目。**它有真实的工程约束、真实的边界处理和真实回归测试**。

---

## 二、系统全景

### 2.1 三个进程，职责切割清楚

```
┌──────────────────────────────────────────────────────────────┐
│ Electron 主进程                                               │
│  · MCP Server（StreamableHTTP，随机端口）  ← 工具宿主          │
│  · SQLite 会话库 / Markdown 记忆 / .lr-agent 标注真值 / 文件   │
│  · 推理子进程（YOLO / SAM2）  · 终端作业                       │
│  · spawn ↓                                     ↑ HTTP + Token  │
├──────────────────────────────────────────────────────────────┤
│ 渲染进程（React）                                             │
│  · agentJobRegistry.runLoop()  ← 客户端工具循环 + resume       │
│  · agentChatStore            ← SSE → MessageBlock reducer     │
│  · agentProposalApply        ← Keep All / Dismiss / Undo      │
└──────────────────────────────────────────────────────────────┘
                    │ POST /agent/chat/stream (SSE)
                    ▼
┌──────────────────────────────────────────────────────────────┐
│ local-agent（Python / FastAPI，127.0.0.1:随机端口）            │
│  · ToolLoopRunner  ← 服务端工具循环                            │
│  · 阶段状态机 / 提案拦截 / 子代理 / MCP 工具注入                │
│  · 无数据库、无用户体系 —— 每次请求自带全部上下文               │
└──────────────────────────────────────────────────────────────┘
                    │
                    ▼
             OpenAI 兼容 LLM（DeepSeek 等，Key 由前端 BYOK 直传）
```

关键点：**Agent 的"工具循环"横跨两段**——

- Python 侧 `ToolLoopRunner` 跑**服务端工具**（读文件、grep、写提案、子代理）；
- 渲染进程 `agentJobRegistry.runLoop()` 跑**客户端工具**（自动标注、改标注、终端命令、MCP 记忆）。

两者通过 `tool_pending` SSE 事件 + 重新 POST `/chat/stream`（带 `client_tool_results`）接力。**这就是本项目的 Human-in-the-loop 与"断点恢复"的物理实现**。

### 2.2 进程生命周期（`src/main/localAgent/serverProcess.ts`）

| 环节 | 实现 | 行号 |
|------|------|------|
| 端口 | **随机空闲端口**（`net.createServer().listen(0)`），非固定 8765 | :97-109 |
| 鉴权 | 每次启动 `randomBytes(32).toString('hex')` 生成 token，注入子进程 env 与渲染层 | :162-163 |
| Python 解析 | `LR_AGENT_LOCAL_PYTHON` → 用户覆盖 → `CONDA_PREFIX` → conda 候选 → 内嵌 venv → 系统 python | :59-94 |
| 健康检查 | 轮询 `/health`，20s 超时，300ms 间隔 | :111-140 |
| 状态推送 | `localAgent:status` 事件给所有窗口（向导/横幅消费） | :43-47 |
| 打包路径 | 开发 `app.getAppPath()/vendor/local-agent`；打包 `resources/local-agent` | :52-57 |

> ⚠️ **文档与代码漂移**：`vendor/local-agent/README.md` 第 82 行写"认证：无（本机单用户）"，但代码中 `app/core/deps.py` 强制要求 `LR_AGENT_LOCAL_TOKEN`，且**未配置时 fail-closed**（拒绝所有 API，仅 `/health` 开放）。实际设计比文档更安全，建议更新 README。

安全边界值得肯定：`local_main.py:44-47` 拒绝 `cors_origins` 含 `*` 的启动（避免 `allow_credentials=True` + 通配符），`deps.py:47` 用 `hmac.compare_digest` 做常量时间比较。

---

## 三、LangChain 的真实用法（逐 API 对照）

### 3.1 `ChatOpenAI` 初始化——两处工厂

**Assist 对话**（`app/api/v1/agent.py:165-173`）：

```python
llm = ChatOpenAI(
    model=body.model,
    api_key=body.api_key,
    base_url=base_url,
    streaming=True,
    temperature=0.7,
    timeout=120,
    extra_body=deepseek_extra_body,   # {"thinking": {"type": "disabled"}}
)
```

**辅助模型**（`agent.py:206-214`）：`aux_model/aux_api_key/aux_base_url` 三者齐全才启用，**未配置时跟随主模型**，供子代理查阅使用。

**标注管线**（`app/api/v1/annotation_agent.py:54-74`）：`_require_direct_llm()` 是唯一工厂，`timeout=120` 硬编码，缺失凭据 → 400。

> **DeepSeek Thinking 兼容处理**：`agent.py:150-163` 在模型名或 base_url 含 `deepseek` 时关闭 thinking，注释写明「避免多轮工具调用时 reasoning_content 回传兼容问题」。这正是学习规划阶段 0 记录的"处理 DeepSeek Thinking 模式与多轮工具调用的兼容问题"。
>
> ⚠️ **不一致**：`scripts/test-deepseek-tools.js:49` 的探针脚本用的是 `enable_thinking: false`，与运行时代码的 `extra_body.thinking` 写法不同。探针验证的开关与生产路径的开关并非同一参数，建议统一。

### 3.2 `bind_tools` —— 工具 Schema 如何交给模型

出现在 3 个位置，语义各不相同：

| 位置 | 写法 | 用途 |
|------|------|------|
| `assist_service.py:38` | `llm.bind_tools(tools)` | 主循环正常绑定 |
| `tool_loop.py:119` | `llm.bind_tools(tools, tool_choice="any")` | **强制**发起真实 tool call（伪代码兜底），仅触发一次 |
| `explore_readonly.py:258` | `self.llm.bind_tools(inner_tools)` | 子代理只读工具集 |

另有 `annotation_agent.py:311` 的 `llm.bind(max_tokens=body.max_tokens)` —— 这是 `bind` 而非 `bind_tools`，用于给单次调用追加参数，是 LangChain 的一个不太常见但很有用的用法。

### 3.3 消息类型用法

| 消息 | 构造位置 | 说明 |
|------|---------|------|
| `SystemMessage` | `agent.py:80-85`、`context_snapshot.py` | 系统提示 + 历史摘要 |
| `HumanMessage`（纯文本） | `agent.py:89-91` | 用户消息 |
| `HumanMessage`（多模态） | `chat_message_builder.py:76-79` | `content=[{"type":"text"...},{"type":"image_url","image_url":{"url": data_url}}]` |
| `AIMessage`（含 `tool_calls`） | `agent.py:103-112` | **从请求体重建历史轮次的工具调用**，resume 的关键 |
| `ToolMessage` | `tool_loop.py:287`、`context_service.py:89-116` | 工具结果回填，必须与 `tool_call_id` 对应 |
| `AIMessageChunk` | `stream_adapter.py` | 流式增量，含 `tool_call_chunks` |

**多模态注入方式有两种**，分工明确：

1. **模型主动索取**（主路径）：LLM 调 `read_image_for_vision` → `tool_loop.py:339-347` 在该 `ToolMessage` **之后**追加一条独立的多模态 `HumanMessage`（"【附图】请根据上图回答…"）。工具结果里用内部标记 `__vision_image_path__` 传递绝对路径，展示时由 `format_vision_tool_result_for_display` 抹掉。
2. **弱模型兜底**：`vision_bootstrap.py` —— 仅第一轮无任何 tool call 且用户话语里能正则出图片路径时触发。文件头注释解释了为什么不再无条件预加载：「系统替模型选图容易看错、浪费视觉 token」。

图片统一经 `asyncio.to_thread` 做「读盘 → 解码 → 缩放 → JPEG → base64」，避免 CPU 密集操作阻塞事件循环（`chat_message_builder.py:53-79`）。

### 3.4 `StructuredTool` —— 工具的三种执行器

`tool_registry_meta.py` 定义了调度单一真相源：

```python
class ToolRunner(str, Enum):
    SYNC     = "sync"      # 后端本轮执行完
    PROPOSAL = "proposal"  # 出提案 SSE，落盘由 Electron 确认
    ASYNC    = "async"     # 暂停 loop，Electron 执行后 resume
```

`ToolCapability` 枚举给每个内置工具分配**唯一能力**，并在 `registry.py:552-562` 用断言阻止能力冲突（防 MCP 与内置工具双轨注入同名能力）。`QUERY_CONTEXT` 是唯一允许多工具共享的能力。

`tool_fn_map()`（`registry.py:577-589`）把 `StructuredTool` 列表转成 `name → callable`：

```python
if tool.func is not None:
    mapping[tool.name] = tool.func
elif tool.coroutine is not None:
    mapping[tool.name] = _async_structured_caller(tool)   # MCP 工具只有 coroutine
```

**这是本项目自己补的一个 LangChain 缝隙**：`langchain-mcp-adapters` 转出来的工具只有 `coroutine` 没有 `func`，若只取 `func` 则会出现「`bind_tools` 看得见、执行时报未知工具」。注释明确记录了这一点。

### 3.5 流式事件适配（`stream_adapter.py`）

`events_from_chunk()` 把 `AIMessageChunk` 翻译成本项目的 `StreamEventPayload`：

- `chunk.content` 为 `str` → `text_delta`；为 `list`（部分网关的 content parts）→ 逐 part 提取 `type == "text"`；
- `chunk.additional_kwargs["reasoning_content"]` → `reasoning_delta`（**DeepSeek 思维链靠这个非标准字段透出**）；
- `chunk.tool_call_chunks` → `tool_start`（主循环传 `emit_tool_chunks=False`，因为提案流式拦截器需要自己消费 chunk，避免重复出卡）。

### 3.6 刻意不用结构化输出（重要设计取舍）

`app/agent/annotation/llm_invoke.py:1` 的模块 docstring 直说：

> LLM invoke helpers **without OpenAI json_schema (DeepSeek-compatible)**

配套证据：
- `annotation_agent.py:42-46` 把含 `response_format` / `json_schema` 关键词的错误翻译成 400「当前模型不支持结构化输出，请使用普通对话模型或更换提供商」；
- `invoke_json_model()` 在消息末尾追加固定句「只输出一个 JSON 对象，不要 markdown 代码块。」；
- 解析靠自研 `extract_json_object()`（剥 markdown 围栏 + 定位首个 JSON 对象）+ 白名单/夹取 + Pydantic `model_validate`。

**这是一次为了兼容性主动放弃框架能力的选择**：代价是自己维护三层解析防线，收益是能跑在任意 OpenAI 兼容端点上。

---

## 四、Agent 运行时逐层拆解

### 4.1 无状态设计（本项目最重要的一条架构决策）

`local-agent` **不存任何会话状态**。`app/api/v1/agent.py:1-5` 的模块 docstring：

> Session/chat CRUD and LLM provider config live in the Electron frontend (local SQLite storage + direct LLM API calls for simple chat).

每次 `/chat/stream` 请求都必须自带：完整消息历史（`body.messages`）、客户端上下文（`body.client_context`）、客户端工具结果（`body.client_tool_results`）。

**好处**：服务可随时重启、易测试、无需分布式会话。
**代价**：每轮 resume 都要把整段对话重新序列化/反序列化一遍；且"执行位置"只存在于前端内存（详见 §4.5）。

`_build_lc_messages_from_local()`（`agent.py:75-130`）负责重建：把 `role == "assistant"` 且带 `tool_calls` 的历史消息重建成 `AIMessage(content, tool_calls=[...])`，把 `role == "tool"` 重建成 `ToolMessage`（**`tool_call_id` 为空则直接跳过**，防脏数据）。

### 4.2 主循环（`assist_service.py:98-188`）

```python
for round_idx in range(max_tool_rounds + 1):        # 默认 30 轮
    interceptor = ProposalStreamInterceptor(...)    # 每轮新建！
    async for chunk in llm_with_tools.astream(messages):
        ... text_delta / reasoning_delta → yield
        ... interceptor.on_chunk(chunk) → file_proposal* → yield
        ... gathered = chunk if gathered is None else gathered + chunk
    async for event in loop.execute_round(gathered, full_text, messages, interceptor):
        if event.type == "tool_pending":
            yield event
            return                                  # 关键：结束 HTTP 轮次，等前端
```

三个细节值得学习：

1. **每轮新建拦截器**（注释在 `proposal_streamer.py:8-11`）：`tc_index` 每轮从 0 重新编号，复用实例会把上一轮的 `rel_path` / `content_sent_len` 残留到本轮，导致提案 delta 错标路径。
2. **`tool_pending` 直接 `return`**：不是 break，是整个 SSE 流结束 —— 把"等客户端"变成一个真正的 HTTP 断点，而不是服务端挂起等待。
3. **轮次耗尽兜底**（`:170-188`）：`for...else` 分支强制追加一条「工具调用预算已用完…不要再调用工具」的 `HumanMessage`，再跑一次无工具生成，避免回合在工具链中途无声结束。

### 4.3 单轮工具执行（`tool_loop.py:448-720`）

`execute_round()` 的执行顺序本身就是一份"工程护栏清单"：

| 阶段 | 行为 | 行号 |
|------|------|------|
| 1. 解析 | 仅用 API `tool_calls`；`completed_tools` 中的 id 被过滤 | :456-461 |
| 2. 伪代码兜底 | 正文写了 `auto_annotate(...)` 却没真实 tool call → `tool_choice="any"` 强制重试**一次** | :463-467 |
| 3. 全被过滤 | 为每个 api call 补 `already_completed` 的 `ToolMessage`，保证消息链完整 | :469-487 |
| 4. **同轮互斥** | 本轮含标注写入 → 拦截所有工作区写入（防"先写报告后标注"本末倒置） | :491-520 |
| 5. **阶段门禁** | `check_call_allowed()` 逐调用拦截，拦截转成错误反馈回给模型 | :522-539 |
| 6. **合并** | 同轮多个 `auto_annotate` 合并 `paths` 为一次批量；其余补 `coalesced` 反馈 | :543-593 |
| 7. **去重** | 同工具同范围只保留第一个 | :595-617 |
| 8. 并行只读 | 白名单（`grep/glob/read/list/help/describe`）走 `asyncio.gather` | :633-643 |
| 9. 顺序执行 | 其余 SYNC 工具逐个执行 | :645-662 |
| 10. 子代理 | `explore_readonly` 用 `_merge_async_iterators` 并行，各自独立收集摘要 | :664-714 |
| 11. ASYNC | `emit_tool_pending()` 产出 `tool_pending` | :716-719 |

**同步工具一律丢线程池**（`_invoke_tool_fn`，:91-98）：

```python
raw = await asyncio.to_thread(fn, **args)
```

注释解释了原因：「大范围 grep 会卡住整个服务的 SSE / 健康检查」。同一处理也复制到了子代理（`explore_readonly.py:136-140`）。这是单进程 asyncio 服务里非常容易被忽略的坑。

**拦截不是报错，是反馈**：被门禁/去重/合并拦下的调用，都会生成一个 `ok=False` 的 `ToolMessage` 回填进消息链（`_yield_blocked_call`，:401-427）。模型因此能"看到"自己为什么被拒，而不是凭空丢一次调用导致消息链 `tool_call_id` 对不上（OpenAI 会直接 400）。

### 4.4 阶段状态机（`task_phase.py`）—— 派生状态

不持久化 `phase` 字段，每次请求从 `client_context.proposal_states` **重新推导**：

```
有 pending 标注提案  → AWAIT_CONFIRM（禁止全部写工具）
有 applied 标注提案  → VERIFY（禁止对已落盘路径整文件重标）
无标注提案历史       → None（不启用任何门禁，老客户端/纯问答零行为变化）
```

门禁是**两级**的：
- **工具级**：`blocked_tool_names()` 在 `bind_tools` 时移除；
- **执行级**：`check_call_allowed()` 在执行前兜底。

`agent.py:429-436` 的注释说明了为什么最终选择执行级而非 bind 级：

> tools 列表保持稳定（按名称排序）：阶段门禁不在 bind 时增删工具，交由执行层 `check_call_allowed` 拦截

**理由**：工具列表稳定 → system prompt 前缀稳定 → 命中服务端前缀缓存。这是一个把"缓存命中率"写进架构决策的例子。

`AWAIT_CONFIRM` 的拒绝话术（:191-195）尤其值得读——它不是简单说"禁止"，而是告诉模型「请用一两句说明提案内容，提示用户 Keep All 或关闭提案后再继续」。**门禁同时承担了引导模型行为的职责**。

### 4.5 Human-in-the-loop 与 resume（跨进程断点）

完整接力链：

```
Python: emit_tool_pending()  →  SSE {type:"tool_pending", clientToolCalls:[...]}  →  return
   ↓
渲染: agentJobRegistry.ts:882-889   state = ToolPending
   ↓
渲染: runClientTool(...)  执行 auto_annotate / mutate_annotation / 终端命令 / MCP 记忆
   ↓
渲染: 若结果含 proposal_pending → state = AwaitingConfirm，存 pendingResumeResults，结束本轮
   ↓                                                          （等用户 Keep All / Dismiss）
渲染: 否则 runLoop(allResults)  →  重新 POST /chat/stream，带 clientToolResults
   ↓
Python: append_client_tool_results_to_messages()  补齐 ToolMessage，继续循环
```

关键代码：

- `agentJobRegistry.ts:961-971` —— **提案未落盘时不自动 resume**，注释写明理由：「避免提案未落盘时自动 resume，模型读到磁盘旧态而自我审查、重复标注」。这是从踩坑中总结出来的。
- `context_service.py:37-48` `unanswered_tool_call_ids()` —— 对比 `AIMessage.tool_calls` 与已有 `ToolMessage`，只补真正缺的那些，避免重复插入。
- `context_service.py:64-70` `enrich_resume_tool_result()` —— 用户已 Keep All 时**改写**结果里的 `proposal_pending: false / file_written: true`，并替换 `next_hint`。注释称之为「谎报防护」。
- `agentJobRegistry.ts:1011-1034` —— `resumeWithResults` 存在内存 Map，**应用重启后丢失**。这正是已有笔记指出的"不是 durable execution"。

### 4.6 子代理（`explore_readonly.py`）

一个**嵌套的、工具集被裁剪的**同级循环：

- 白名单工具集（`EXPLORE_READONLY_BASE_INNER` + 可选 `ANNOTATION_INNER`），黑名单里含 `explore_readonly` 自身（防递归）、全部写工具、`read_image_for_vision`；
- 独立 `SystemMessage`（"你是只读查阅子代理…禁止改文件、写标注"）；
- 最多 `agent_subagent_max_tool_rounds = 12` 轮；
- 结果截断 4000 字符（`_INNER_RESULT_LIMIT`）；
- 父循环用 `_merge_async_iterators`（`tool_loop.py:149-181`）把多个子代理的事件流**合并成一个队列**，因此"一次发起多个独立查阅会并行执行"；
- **只把中文摘要回传给父 Agent**，完整工具轨迹不写进父消息链 —— 这是标准的上下文隔离。
- `should_include_annotation_reads()` 会看父工具集里有没有标注工具，`work_mode == "editor"` 时直接排除。

子代理用 `aux_llm or llm`（`assist_service.py:52`）—— 轻量查阅可以配便宜模型。

### 4.7 提案流式拦截（`proposal_streamer.py`）—— 最"脏"也最见功力的部分

目标：**在 LLM 还在吐 token 的时候，就把写文件的 diff 实时渲染到 UI**。

难点：`tool_call_chunks` 里 `arguments` 是**不完整的 JSON 字符串流**。拦截器自己写了一个增量 JSON 字符串字段提取器：

- `_merge_args()`（:124-137）：兼容「增量式」与「累积式」两种 provider 行为，重复投递幂等；
- `_extract_json_string()`（:60-97）：从可能不完整的 JSON 缓冲里提取字符串字段，处理 `\n \t \r \\ \"` 和**完整 `\uXXXX` 转义**；
- `_decode_unicode_escape()`（:28-57）：处理 `\uXXXX`，**含 UTF-16 代理对合并**，序列不完整时返回 `(None, 0)` 让调用方暂停等待更多分片。

其它工程细节：
- `str_replace` 工具产出 `old_string` / `new_string` 两路增量（`file_edit_delta`），前端据此渲染局部 diff；
- 若写文件工具最终失败（如 `old_string` 未命中），`tool_loop.py:289-302` 会给已流式出卡的路径**补发 `dismissed` 终态**，否则用户点 Keep All 会把空内容写盘；
- `is_lr_agent_relative()` 判断是否 `.lr-agent/` 内部路径，是则 `suppressed`，不向用户出卡。

### 4.8 SSE 线协议（`app/schemas/agent.py:139-250` + `agent.py:485-498`）

**帧格式**：`data: <单行 JSON>\n\n`。**无 `event:` / `id:` / `retry:`，也无心跳**。`done` 帧恒为最后一帧（取消时也会发）。

字段名在 `to_sse_dict()` 里做 snake_case → camelCase 重命名，几处**非一一对应**的映射值得注意：

| 服务端字段 | 前端字段 | 备注 |
|-----------|---------|------|
| `tool_call_id` | `toolCallId` | :189-190 |
| `client_tool_calls` | **同时输出 `clientToolCalls` 与 `toolCalls`** | :239-249，双写 |
| `image_path` | `suggestedRelativePath`（提案类）/ `imagePath`（其他） | :199-203，按事件类型分叉 |
| `summary` | `title`（提案类） | :204-208 |
| `mode` | `operation`（提案类） | :209-217 |
| `summary_up_to_message_id` / `token_estimate` | `summaryUpToMessageId` / `tokenEstimate` | :185-188 —— **服务端当前从不设置，属预留** |

**事件顺序**（chat/stream）：

```
preparing(stage=mcp)?  →  preparing(stage=streaming)
  → text_delta | reasoning_delta | file_proposal_start | file_proposal_delta | file_edit_delta   （交错）
  → tool_start / tool_result / file_proposal   （逐工具轮）
  → tool_pending        （若需前端执行 —— 结束本次 HTTP）
  → …
  → done                （恒为最后一帧）
```

> ⚠️ **关键协议缺口：`/agent/chat/stream` 没有 `error` 事件。** `agent.py:147-503` 的 `_stream_local_chat()` 只有 `try/finally`，**没有 `except`**。内层异常直接冒泡 → `StreamingResponse` 断连 → 前端收不到 `done`，只能靠"流意外中断"判定失败，拿不到服务端错误 detail。
>
> 对照：唯一带 `error` 事件的流是质量报告（`annotation_quality.py:64-71`）。这说明**能力已存在，只是 chat 路径没接**。
>
> 另：**全部端点都没有 `response_model=`**。

---

## 五、工具系统

### 5.1 三种模式与工具集（`assist_mode_router.py`）

| 模式 | 触发条件 | 工具集 |
|------|---------|--------|
| **FULL** | `agent_mode == annotation` 且有项目快照且非编辑器 | 全量（含 `auto_annotate` / `mutate_annotation`） |
| **LIGHT** | 编辑器或仅有工作区 | 只读 + 写文件提案（无标注写入） |
| **ASK** | `agent_mode != annotation` | `FULL_TOOL_SET - WRITE_TOOL_NAMES`（**纯只读**） |
| **CHAT** | 无工作区无项目 | 无工具，走 `chat_service.stream_chat` |

`registry.py:549-550` 还有一层：`work_mode == "editor"` 时直接剥掉 `ANNOTATION_TOOL_NAMES`。

**默认安全**：Ask 模式即使有项目快照也只读。工具集是白名单而非黑名单。

### 5.2 工具清单（`registry.py:_build_all_tools`）

| 工具 | Runner | 说明 |
|------|--------|------|
| `get_account_summary` | SYNC | **不注入主 Agent**，只给子代理用 |
| `get_lr_agent_help` | SYNC | 应用帮助 |
| `describe_client_context` | SYNC | **不注入主 Agent**（信息已在 system prompt） |
| `describe_annotation_project` | SYNC | 标签树 + 检测模型列表 |
| `read_file_annotation` | SYNC | 读已有标注，**支持分页**（`annotation_offset/limit`，上限 500） |
| `read_workspace_file` | SYNC | 支持 `start_line/end_line`，流式窗口读大文件 |
| `grep_workspace` | SYNC | 正则搜索 |
| `glob_workspace` | SYNC | 递归列文件 |
| `list_workspace_directory` | SYNC | 列目录 |
| `read_image_for_vision` | SYNC | 视觉探针通过才可用 |
| `read_document_file` | SYNC | PDF/DOCX |
| `write_workspace_file` | PROPOSAL | 出提案，Keep All 才落盘 |
| `str_replace_workspace_file` | PROPOSAL | 精确片段替换 |
| `delete_workspace_file` | PROPOSAL | 删除提案 |
| `move_workspace_file` | PROPOSAL | 移动/重命名提案 |
| `auto_annotate` | **ASYNC** | schema 存根，实现体在 Electron |
| `mutate_annotation` | **ASYNC** | 同上 |
| `start_terminal_command` | **ASYNC** | 需聊天内批准 |
| `explore_readonly` | SYNC | 子代理入口 |

**Prompt 工程细节**：自定义 `SlimArgsModel` 基类（`registry.py:67-72`）重写 `model_json_schema` **递归剥掉 pydantic 自动生成的 `title` 字段**，注释写明「每字段省 ~30 字符的工具前缀」。字段描述只写参数语义，「何时填」的行为纪律集中放在系统提示的 `ANNOTATION_CALL_GUIDE`（`context_snapshot.py:125-133`）——避免同一套规则在 11 个字段描述里重复携带。

### 5.3 MCP 集成（`app/agent/tools/mcp_client.py`）

| 机制 | 实现 |
|------|------|
| 客户端 | `MultiServerMCPClient({name: conn}).get_tools()` |
| 本地 Server | Electron 内 `src/main/mcp/server.ts`，StreamableHTTP，端点强制 `/mcp` |
| 传输 | `streamable_http` 与 `sse` |
| 缓存 | 按「连接指纹」(url + transport + 排序 headers) 缓存，TTL 默认 1800s |
| 过期策略 | **stale-while-revalidate**：本轮用旧列表，后台 `asyncio.create_task` 刷新下一轮生效 |
| 失败降级 | 单台 server 连不上只跳过它，不影响其他 server 与主流程 |
| 去重 | 按 `ToolCapability` + 名称去重，不覆盖内置实现 |

`should_expose_mcp_tool()`（:108-124）做了权限分级：

```python
if tool_name.startswith("memory_"):
    if not workspace_memory_enabled:  return False     # 任务开关关闭 → 全禁
    if agent_mode != "annotation":    return tool_name == "memory_read"   # Ask 只读
    return True
```

**MCP Server 暴露的 9 个工具**（`src/main/mcp/server.ts`）：

| 工具 | 行号 | 说明 |
|------|------|------|
| `memory_read` | :181 | 读工作区记忆 topic |
| `read_agent_skill` | :210 | 读 SKILL.md 或附属文本 |
| `list_agent_skill_files` | :252 | 列 skill 目录文件 |
| `run_agent_skill_script` | :284 | **执行** skill 内 `scripts/` 脚本（仅 .py/.sh，120s 强杀，argv 原样传，无 shell） |
| `start_terminal_command` | :329 | 终端命令，**必须聊天内批准**；handler 直接返回 `approval_required`（真实入口在 Electron 前端，Agent loop 以 ASYNC runner 分派） |
| `read_terminal_output` | :366 | 按 cursor 增量读终端输出 |
| `kill_terminal_job` | :390 | 杀进程树 |
| `memory_write` | :407 | 覆盖偏好类 topic（禁止改 `progress.md` / `annotated-files.md`） |
| `memory_create` | :450 | 新建偏好类 topic |

> ⚠️ **文档漂移**：主 `README.md` 第 99 行写「缺口：目前仅做了渐进式读取 Skills 中的文档，暂时不支持脚本运行」，但 `run_agent_skill_script` 已实现。README 落后于代码。

安全设计值得注意：`start_terminal_command` 的工具描述明确写「Runs WITHOUT a shell: no pipes, redirections or command chains」，且执行前需用户批准、破坏性命令直接拒绝。

---

## 六、系统提示词组装（`context_snapshot.py`）

`build_assist_system_prompt()` 按**块**拼接，块顺序刻意设计（:224-225 注释）：

> 块顺序按"稳定在前、动态沉底"排列，让 system prompt 长前缀跨轮保持一致，以命中 DeepSeek / OpenAI 等服务端的前缀缓存：skills（稳定）先于记忆与台账（动态）。

拼接顺序：

```
【你的身份】            模型名 + 视觉能力状态（探针结果）
【任务】                WORKSPACE_ASSIST_TASK / ASSISTANT_TASK_BASE
【文件编辑纪律】         仅允许写工作区时注入（FILE_EDIT_GUIDE）
【当前标注项目快照】      标签树 + 检测模型（format_snapshot_for_prompt）
【标注调用纪律】         仅标注 Agent（ANNOTATION_CALL_GUIDE）
【编辑器模式】            work_mode == editor 时
【项目指令】             project_instructions
【可用 Skills】          skills_catalog（稳定）
【工作区记忆】           memory_index（动态）
<proposal_ledger>        待确认提案台账（最动态）
```

**几条"防幻觉"提示词值得单独摘出**：

```
- 未收到工具返回前，禁止输出执行结果、统计数字或完成声明；不得用文本假装执行了工具。
- 报告与汇总中的每个数字必须来自工具返回或提案明细，禁止估算或凭印象填写。
```

以及阶段块里的：

```
- 不要用 read_file_annotation 验证提案内容（磁盘仍是旧态，以提案台账为准）。
```

`format_runtime_identity_block()`（:53-72）会根据**视觉探针结果**决定提示词：探针未通过时明确写「不要声称能分析图片像素」。这是把"模型能力探测结果"注入身份认知的实用做法。

---

## 七、标注 Agent 管线（与 Assist 并列的另一条主干）

> 与 Assist 的 Tool-Use-Loop 不同，标注管线是 **「单次 LLM 出计划/意图 → 确定性执行 → 视觉映射 → 校验重试」** 的编排，不是自由循环。

### 7.1 端点（`app/api/v1/annotation_agent.py`）

| 端点 | 行号 | 作用 |
|------|------|------|
| `POST /mutation-prepare` | :89 | 改/删已有标注的意图解析 |
| `POST /batch-prepare` | :135 | 批量新增的「选图 + 计划」单次 LLM |
| `POST /map-detection-boxes` | :189 | 检测框 → 标签映射（视觉逐框 or 启发式） |
| `POST /map-heuristic` | :77 | 纯启发式映射（无 LLM） |
| `POST /llm-generate` | :299 | 通用生成（caption/cot/instruction，可带图） |

> ⚠️ `batch_prepare_service.py:6-8` 自述：当前几何标注主管线**并不调用本服务**（范围由 `auto_annotate` 的 `paths/all_files` 解析）。`batch-prepare` 是「已实现但未在主链路启用」的能力，改动它收益面可能低于预期。

### 7.2 五个系统提示词

| 提示词 | 位置 | 要点 |
|--------|------|------|
| `BATCH_PREPARE_SYSTEM` | `batch_prepare_service.py:30-64` | 一次输出完成「选图 + 计划」，内联完整 JSON schema；7 条选图规则，含「用户纠正时覆盖历史旧范围」 |
| `MUTATION_PREPARE_SYSTEM` | `mutation_prepare_service.py:15-78` | 覆盖 12 种标注类型，4 类 `mutation_kind`，12 种 target 选择器语义 |
| `CROP_VISION_SYSTEM` | `map_labels_service.py:40-43` | 「裁剪区域与候选标签不符时必须返回空 label_id」 |
| `PREFLIGHT_SYSTEM` | `label_candidate_resolver.py:22-24` | 「不要猜测图中没有的目标」 |
| `QUALITY_REPORT_COMPOSE_SYSTEM` | `quality_report_compose_service.py:13-22` | 固定 6 章 Markdown 报告，「数字必须来自 metrics/findings JSON，禁止编造」 |

### 7.3 三层解析防线

| 层 | 机制 |
|----|------|
| **L1 抽取** | `extract_json_object()` —— 全库唯一入口，剥围栏 + 定位首个 JSON 对象 |
| **L2 值域** | 路径白名单（`_filter_selected_paths` / `_filter_paths`）、枚举回退、模型 id 校验、`_clamp(conf/iou, 0.05, 0.95)`、标签 id 白名单、`notes[:200]`、`plan_steps[:12]` |
| **L3 Pydantic** | 严格 schema：`Literal` 枚举、`min_length`、`ge=0`，`model_validate` 失败 → 502 |

配套的 `coerce_null_string_fields()`（`llm_invoke.py:20-28`）把 LLM 误用的 JSON `null` 改成 `""`，避免 Pydantic 校验失败——**为模型输出习惯做的防御性适配**。

### 7.4 视觉映射的两条通路

**逐框裁剪（vision_crop）**：`_crop_boxes_from_image_bytes()`（`map_labels_service.py:80-120`）用 PIL 裁剪，四边 clamp 保证合法矩形，坐标是否归一化由「任一维度 > 1.5」判定；裁剪前 `_resize_image_for_llm(max_side=768)`（**硬编码**），输出 JPEG quality=85 的 data URL。

**整图**：preflight / llm-generate / assist 对话三处，走 `settings` 里的 `max_edge` / `jpeg_quality`。

**并发**：`asyncio.Semaphore(annotation_vision_map_concurrency)`（默认 3）限流；**重试轮强制 concurrency=1**，避免重试时互相抢标签。

**`label_vision_policy` 的语义**：`labels_require_vision_mapping()` 返回「**没有任何**标签名命中 COCO 80 类（+手工加的 `face`）」。即标签是 `Curry`/`James` 这类实例名时，启发式类名匹配必然失效 → 自动建议/开启视觉映射。

### 7.5 校验 + 定向语义重试（`_vision_map_with_validation_retry`）

四类 issue（`map_validation_service.py:98-184`）：

- `INVALID_LABEL_ID` —— 不在候选集
- `DUPLICATE_LABEL` —— **仅 instance_labels 时**才查（人物实例一对一）
- `REASON_CONTRADICTS_LABEL` —— reason 命中「无法确定/不符/not sure…」正则却仍返回了非空 label_id
- `REASON_NAME_MISMATCH` —— reason 里**恰好**出现 1 个候选标签名且与返回 id 不一致（0 个或 ≥2 个提及**故意跳过**，避免误报）

重试只重跑失败框（`retry_indices = sorted({i.box_index for i in issues})`），并把「已占用 label_id」作为 `reserved_label_ids` 注入提示词。

### 7.6 启发式路径 vs LLM 路径

`use_vision and llm is not None` → 视觉；否则 → 启发式（`heuristic_map_service.py`，三级规则：精确匹配 → 双向子串**唯一命中** → OCR 文本包含**唯一命中**）。

**两条路径语义不同，这是当前实现的一个真实缺口**：

| 维度 | 视觉 | 启发式 |
|------|------|--------|
| `ok` 含义 | 恒 `True` | `len(unmapped) < len(mappings)`（至少映射上一个） |
| 实例级去重 | ✅ `DUPLICATE_LABEL` 校验 | ❌ **完全没有** |
| 标签占用约束 | ✅ `reserved_label_ids` | ❌ 无 |
| 调试信息 | `label_pool_source` / `label_pool_debug` | 粗判 `scope` / `full` |

启发式路径**可以把同一个标签分配给任意多个框**，且无硬阻断，只在有未映射时给 hint。人物实例场景下这会直接产出错误标注。

### 7.7 其它已被识别的实现问题

按影响排序（均已在代码中定位）：

1. **`include_detection_labels` / `exclude_detection_labels` 在映射阶段不起实际过滤作用** —— `filter_label_candidates_by_scope()` 只读 `include/exclude_label_names`，detection 级字段仅出现在 prompt 的 scope_note 里。用户说"只标注人脸"能否生效，取决于正则能否推出 `include_label_names`（要求标签名**字面出现**且句中有"只/仅"）。
2. **静默降级**：单框视觉调用异常 → 空标签（`map_labels_service.py:163-164`）；整体裁剪异常 → 空 regions（:118-119，**无任何日志**）。两者都会让结果"看起来成功但大量未标注"。
3. **坐标归一化判定阈值粗糙**：`> 1.5` 才判像素坐标，`(1,1,1,1)` 这类小像素值会被误判为归一化。
4. **`annotation_agent.py:217-222` 为日志重复加载图片** —— 只为算一个 bool，服务内部又加载一次，大 base64 请求下是双倍解码开销。
5. **`invoke_json_model()` 的消息重组有损**（`llm_invoke.py:45-51`）："只输出一个 JSON"这句实际落在 `HumanMessage` 而非 `SystemMessage`；非 System/Human 消息（如 `ToolMessage`）会被丢弃；多条 Human 会被拼成一条。
6. **质量报告 48000 字符硬截断可能切断 JSON**（`quality_report_compose_service.py:30-32`），与提示词"数字必须来自提供的 JSON"存在冲突风险。
7. **无传输层重试/退避**，只有语义重试；`timeout=120` 硬编码。
8. **原始 LLM 响应可能落日志**（`llm_invoke.py:58-64`，截断 4000 字符）—— 生产环境需注意。
9. `_http_from_llm_error()` 用字符串匹配 `"response_format" in msg.lower()` 识别不支持结构化输出，属脆弱启发式（`annotation_agent.py:42`）。
10. `map_detection_boxes_to_labels_unified()` 的 `mime_type` 参数被接收但从未使用。
11. `_filter_selected_paths()` 的 reason 是死代码（恒返回 `""`）。

---

## 八、前端 / Electron 侧的 Agent 集成

### 8.1 职责分布

| 模块 | 行数 | 职责 |
|------|------|------|
| `agentChatStore.ts` | **1,278** | **SSE → MessageBlock reducer**（`applyStreamEventToBlocks`，:730） |
| `agentJobRegistry.ts` | **966** | **客户端工具循环**：`startChatJob`(:697) / `runLoop` / `runClientTool` / `resumeWithResults` / `JobState` |
| `agentProposalApply.ts` | 633 | Keep All / Dismiss / Undo 落盘 |
| `backendChatClient.ts` | 303 | `streamChatViaBackend()`(:219) —— SSE 消费 |
| `main/mcp/server.ts` | 595 | Electron 内 MCP Server（9 个工具） |
| `contextPreparer.ts` | 171 | 上下文预算与摘要触发 |
| `proposalLedger.ts` | 133 | 待确认提案台账 → 注入 system prompt |
| `turnContext.ts` | 132 | 历史窗口裁剪 |
| `agentClientContextBuilder.ts` | 115 | 收集 `ClientContextPayload` |
| `agentMemory.ts` / `workspaceFactMemory.ts` | — | Markdown 长期记忆 |
| `subagentBlocks.ts` | — | 子代理事件 → UI 块 |
| `agentDebugLogger.ts` | 14KB | 自研可观测性（代替 LangSmith） |

### 8.2 `JobState` 状态机（`shared/agentTypes.ts`）

```
Registered → Streaming → ToolPending → Resuming → AwaitingConfirm
                      ↘                                  ↘
                       Done / Error / Cancelled ←─────────┘
```

### 8.3 直接 LLM 通道（重要）

`startChatJob()` 会**分流**：

- **没有工作区、没有工具需求** → `localChatClient.ts` / 前端直接请求 LLM，**根本不经过 local-agent**；
- **有工作区或标注项目** → 走 local-agent 的 Tool-Use-Loop。

这意味着"普通问答"的延迟路径比"Agent 任务"短得多。`chat_service.stream_chat()`（`app/agent/chat_service.py`，仅 12 行）是 local-agent 侧对应的无工具分支。

### 8.4 前端上下文预算（`contextPreparer.ts` + `turnContext.ts`）

默认配置（`shared/agentTypes.ts:211-218`）：

```typescript
export const DEFAULT_CHAT_CONTEXT_CONFIG: ChatContextConfig = {
  maxContextTokens: 12_000,
  maxTurnsInWindow: 20,
  summarizeTriggerRatio: 0.85,
  // 必须 ≥ 摘要时保留的轮数（ceil(maxTurnsInWindow/2) = 10），
  // 否则触发条件可能通过但没有可驱逐的内容，摘要永远不会执行。
  minTurnsBeforeSummarize: 10,
};
```

流程：

1. `buildTurnContextFromState()` 整理历史：`windowMessages()` 按 `maxTurns × 2` 条消息滑窗（`turnContext.ts:67-74`），`MAX_TRANSCRIPT_CHARS = 12_000`（:26）；
2. **token 估算用 `chars / 3`**（中英混合粗估，`contextPreparer.ts:35`）；
3. 模型声明上下文窗口时，`deriveMaxContextTokens()` 取**窗口的 10%**，夹在 `MIN_BUDGET_TOKENS = 8_000` ～ `MAX_BUDGET_TOKENS = 48_000`（:76-78）；窗口未知则沿用 `maxContextTokens`；
4. 估算超过 `budget × 0.85` 且轮数 ≥ 10 时，把即将被挤出的旧消息交给模型生成摘要；
5. 摘要失败 → 退化为普通窗口裁剪，**不阻塞用户发消息**。

> 第 3 步的"10% 窗口"是个保守但有依据的选择：system prompt + 工具 schema + 图片会占掉大量预算，历史不能吃满窗口。

### 8.5 状态管理：SQLite 是唯一事实来源

| 层 | 角色 |
|----|------|
| 主进程 SQLite（`db/database.ts:197-247`） | **唯一事实来源**。`sessions`（含 `context_summary` / `summary_up_to_message_id` / `provider_id` / `model`）与 `messages`（含 **`blocks_json`** / `status` / `sort_index`） |
| React state | UI 投影 |
| localStorage（`lr-agent:agentChatUi`） | **仅崩溃恢复缓存**，按标注项目分片（`byProject`，工作区用哨兵键 `__workspace`），流式期间 500ms 尾沿节流 + `beforeunload` 强制 flush |

`agentChatApi.ts:56-106` 做行 ↔ 模型映射，`blocks_json` 解析失败降级为空数组。`messageIds` 惰性加载、会话先拉分页（注释在 `:197-198`、`:417-451`）——**为长会话做了明确的性能取舍**。

崩溃恢复策略（`AgentChatContext.tsx:232-259`、`agentChatStore.ts:291-353`）：

- 残留 `streaming` → 一律落 `stopped`；
- 残留 `awaiting_confirmation` → 落 `done` 并清 `activeJobId`。

⇒ **HITL 断点不跨重启续跑**，重启后只能靠 Keep All 栏应用"已生成但未落盘"的提案。这与 §4.5 的结论一致，是同一处债务的两个视角。

`runningJobs` 注册表（`agentJobRegistry.ts:42-56`）支持"先订阅后建 job"的 pending listeners（`:58-84`）——这就是 `attachJobListener` 必须先于 `startChatJob` 调用的原因。

### 8.6 MCP Server 的安全模型（三道门）

`src/main/mcp/server.ts` 是本机工具宿主，安全设计值得单独记录：

| 门 | 实现 | 行号 |
|----|------|------|
| 1. 只认本机 Host **且禁止任何 `Origin`** | hostname ∈ {127.0.0.1, localhost, ::1} 且 `!origin`（浏览器跨源一律拒） | :61-76 |
| 2. Bearer token 常量时间比较 | `randomBytes(32).toString('hex')`，每次启动重生成，仅注入渲染层 | :53-58, :78-85, :576 |
| 3. 请求体上限 4MB | — | :102-131 |

另有 `GET /health` 返回 `{ok:true, server:'lr-agent-local-mcp'}`（:599-603）。`transport.onclose` **只清 map 不调 `server.close()`**，注释说明否则 `Protocol.close() → transport.close()` 形成**同步死递归**（:506-512）——典型的踩坑记录。

配套的终端执行门禁（`src/main/exec/commandJobManager.ts`）同样严格：**无 shell**（`SHELL_METACHARS` 命中即拒）、危险命令 denylist（`rm -rf` / `format` / `mkfs` / `shutdown` / `git push --force` / `drop database`）、**cwd 锁定工作区**、并发上限 4、输出 128k 环形缓冲、超时默认 300s 上限 600s。

### 8.7 IPC 面

`src/main/preload.ts`（784 行）**不暴露通用 `send`/`invoke`**，只暴露逐方法接口（`contextBridge.exposeInMainWorld`）。事件通道走**白名单强校验**，不在集合内直接抛错（:9-35）：

```
window:maximize-change | window:fullscreen-change | theme:systemChanged
file-system:changed    | auth:resetPasswordDeepLink | env:install:progress
localAgent:status      | agent:terminal:event
```

窗口安全配置：`nodeIntegration:false, contextIsolation:true, sandbox:true`（`main.ts:792-800`）。渲染层**无法通过通用 fs 读取应用自身凭据文件**——`BLOCKED_SECRET_BASENAMES` 硬拦 `lr-agent.db` / `mcp.json` / `session_cache.dat` / `refresh_token.dat` / `environment.json`（`main.ts:308-327`）。

Agent 相关通道命名空间：`mcp:*`、`localAgent:getBaseUrl`、`agent:terminal:*`、`agent:skills:*`、`agent:memory:*`、`agent:checkpoint:*`、`db:providers:*`（含 `probeVision` / `probeContext`）。

### 8.8 进程编排与打包（补充）

- `main.ts:886-936` `app.whenReady()` 链：`initializeDatabase()` → `migrateSecrets()` → 注册 IPC → **`startMcpServer()` 与 `startLocalAgentServer()` 异步不阻断** → `createWindow()`。`before-quit`（:938-943）依次停工作区监听、MCP、local-agent、数据库。
- 解释器解析 **7 级优先级**，其中第 5 级 `~/.conda/environments.txt` 注册表兜底（`pythonDiscovery.ts:92-121`）注释说明是"anaconda 装在非用户盘符时固定候选全落空"的补救。
- `buildInferenceSpawnEnv()` 被 local-agent 与 inference 两个 spawn 共用（`preAnnot/inferenceProcess.ts:56-81`）：**删除继承的 `PYTHONHOME` / `PYTHONPATH`**（防 Anaconda base 劫持 import），强制 `PYTHONUNBUFFERED` / `PYTHONNOUSERSITE` / `PYTHONIOENCODING=utf-8`。
- `envInstaller.ts`（377 行）用 python-build-standalone 建 venv，阶段机 `pending → prepare-runtime → create-venv → install-deps → verify → done|failed|cancelled`，`requirementsHash` 幂等；含 **SAM-2 `git+https` → GitHub zip 改写**（避免无 git 机器装不上）。
- 打包：`package.json:281-312` `extraResources` 把 `vendor/local-agent → resources/local-agent`（排除 `tests`/`.env`/`__pycache__`）、`vendor/inference`、`assets/python-runtime` 一并分发。

### 8.9 渲染层与「平台能力」的边界

- **只有一个子代理** `explore_readonly`，不是通用 `task` 工具。子代理**没有独立会话 id**，唯一关联键是父 `toolCallId`；子代理 tab 的数据靠**纯内存遍历**（`subagentBlocks.ts:44-62` 扫 `messagesBySession`），不发请求。
- 渲染层还有一道**独立的模式兜底**（`agentJobRegistry.ts:548-559`）：即使模型绕过了服务端工具集，Ask 模式也会拒绝 `auto_annotate` / `mutate_annotation`。**双保险**。
- 终端批准是一个**模块级 Promise 桥**（`terminalApproval.ts:13-29`）：`runClientTool` → emit `terminal_approval` → `await requestTerminalApproval(id)`；用户点批准 → `window.electron.terminal.start`。拒绝以 `status:'skipped'` resume，**无副作用**。
- Block → 组件映射（`AgentAssistantMessage.tsx:307-404`），其中一处注释值得学习：`annotation_pipeline` 的 React key **强制带 index**，否则"key 复用导致卡片无限增多"（:345-361）。
- 配置入口在**左侧活动栏**而非设置页（`LeftPanel = 'llmProviders' | 'mcp' | 'skills'`，`ActivityBar.tsx:10-17`）。
- **Skills 没有安装器**：磁盘约定 `~/.agents/skills/<dir>/SKILL.md`，稳定标识是**目录名**；停用清单落 `<userData>/skills.json`，且是**硬禁用**（既不注入 prompt 也拒读 MCP 技能工具，`mcp/server.ts:165-173`）；"安装" = 用户手工放目录。
- **MCP 只有 `streamable_http` 与 `sse`，无 stdio**；`url` 不自动拼 `/mcp`；header 值用 `safeStorage` 加密，启动时 `migrateSecrets()` 幂等回写。**大 server 自动白名单**：probe 到工具数 > 20 时新发现的工具默认写入 `disabledTools`。
- provider 存 SQLite `llm_providers`（apiKey 走 `safeStorage` 加密列）。两个探针：上下文窗口（`contextProbe.ts`，**`manual` 来源时探测不覆盖**）与视觉（`visionProbe.ts`，合成 32×32 PNG）——**视觉探针不尊重 `manual`，每次覆盖**，与上下文探针行为**不对称**。

---

## 九、对照「智能体自学阶段规划」的源码索引

按 `docs/智能体自学阶段规划.md` 的阶段，把知识点落到具体位置：

### 阶段 3：LangChain 与上下文组织

| 知识点 | 源码位置 |
|--------|---------|
| `ChatOpenAI` 的封装作用 | `app/api/v1/agent.py:165-173` |
| System / Human / Assistant / Tool 消息 | `app/api/v1/agent.py:75-130`、`app/agent/stream_adapter.py` |
| 工具 Schema 如何提供给模型 | `app/agent/tools/registry.py:392-547` + `assist_service.py:38` 的 `bind_tools` |
| 工具调用 ID 的作用 | `app/agent/tool_invocation.py:27-59`、`context_service.py:37-48` |
| `AIMessage.tool_calls` | `app/api/v1/agent.py:94-112`（重建）、`explore_readonly.py:167-179` |
| `ToolMessage` 回填 | `app/agent/assist/tool_loop.py:287`、`:427`、`:710-714` |
| 消息历史顺序要求 | `tool_loop.py:469-487`（全被过滤时仍补齐 ToolMessage，否则 API 400） |
| 流式事件如何传到界面 | `app/agent/stream_adapter.py` → `agent.py:485-498`（SSE）→ `agentChatStore.ts` |
| temperature / timeout | `agent.py:170-172`（0.7 / 120）；标注侧 `config.py:49-50`（0.0 / 0.1） |
| **模型上下文 vs 应用状态** | `Context` 见 `schemas/agent.py:74-95`；`State` 见 `task_phase.py` 的派生状态 |

### 阶段 4：Agent 与 Tool-Use-Loop

| 知识点 | 源码位置 |
|--------|---------|
| Agent 与聊天机器人的区别 | `assist_service.py` 有循环，`chat_service.py` 只有 12 行 |
| Tool-Use-Loop 主体 | `app/agent/assist/tool_loop.py:429-720` |
| 工具注册与元数据 | `tools/registry.py` + `tools/tool_registry_meta.py` |
| 参数 Schema 与校验 | `registry.py:67-167`（`SlimArgsModel` + pydantic） |
| 只读 vs 修改型工具 | `assist_mode_router.py` 的 `WRITE_TOOL_NAMES` |
| Ask 模式与 Agent 模式 | `assist_mode_router.py:64-79` |
| 工作区路径与权限边界 | `tools/workspace_path.py` |
| 人工确认与待批准操作 | `assist/tool_loop.py:716-719` → `pending_emitter.py` → `agentJobRegistry.ts:894-975` |
| 工具失败 / 取消 | `_invoke_tool_fn:100-104`（异常转 JSON 结果）、`is_cancelled()` 贯穿 |
| 多轮工具调用 | `assist_service.py:98-188` |
| 中断、恢复、任务阶段 | `task_phase.py` + `context_service.py:73-117` |
| 工具成功但业务结果为空 | `map_labels_service.py` 的 `ok = len(unmapped) < len(mappings)` |
| 子 Agent 与主 Agent 边界 | `assist/explore_readonly.py` |
| 提案流式渲染 | `assist/proposal_streamer.py` |

### 阶段 6（LangGraph）的现状

项目**完全没有 LangGraph**。若要按规划做阶段 6 实验，最自然的切入点是把 `tool_loop.py` 的 `execute_round` 分支逻辑改写成 `StateGraph`，用 `interrupt()` 替代 `tool_pending` + 重新 POST 的接力，用 checkpointer 替代前端内存里的 `resumeWithResults`。

---

## 十、总结评价

### 10.1 做得好的地方

1. **无状态服务 + 显式 Schema**：请求自带全部上下文，服务可独立测试、重启、复用。`ClientContextInput` / `LocalChatStreamRequest` 边界清晰。
2. **确定性护栏优于提示词说教**：阶段门禁、工具白名单、路径白名单、写盘前提案，都在代码层强制执行。`task_phase.py` 的话术设计还兼顾了引导模型。
3. **HITL 是真实断点**，不是 UI 假动作：`tool_pending` 结束 HTTP 轮次，`AwaitingConfirm` 在提案落盘前不自动 resume。
4. **拦截即反馈**：被拒的调用会生成 `ToolMessage` 回填，既保证消息链合法，又让模型能自我纠正。
5. **性能意识贯穿细节**：同步工具进线程池、图片编解码进线程池、MCP 发现走 stale-while-revalidate、system prompt 稳定前缀命中缓存、`SlimArgsModel` 省 token。
6. **派生状态而非冗余字段**：`derive_task_phase()` 每次从提案事实重算，不会出现"阶段字段与真实状态不一致"。
7. **测试是真的**：302 个测试通过，且覆盖了 `tool_loop` / `task_phase` / `proposal_streamer` / `workspace_memory` 这些最容易回归的地方。

### 10.2 主要债务（按优先级）

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| 1 | **执行位置无法持久化**：`resumeWithResults` 只在内存，崩溃恢复把 `awaiting_confirmation` 直接落 `done` | `agentJobRegistry.ts:1011-1034`、`AgentChatContext.tsx:232-259` | 应用重启后无法从 `AwaitingConfirm` 继续，非 durable execution |
| 2 | **`/agent/chat/stream` 无 `error` 事件**：只有 `try/finally`，异常直接断连 | `agent.py:147-503`（能力已在 `annotation_quality.py:64-71` 存在） | 前端拿不到失败原因，只能判定"流中断" |
| 3 | **`/chat/cancel` 是死链路**：渲染层发 `client_job_id` 却从不调用 | 全 `src` 检索 `chat/cancel` **0 命中**；`stopJob()` 只 `controller.abort()`（`agentJobRegistry.ts:101-104`） | 服务端 `_cancel_events` 注册表在正常使用中几乎不触发，缺优雅取消链路 |
| 4 | **God Object**：`agentChatStore.ts` 1,278 行 / `agentJobRegistry.ts` 966 行 / `AgentChatContext.tsx` 2,677 行 | 文件规模 | 新人阅读成本高，改动易牵连 |
| 5 | **启发式映射路径无实例去重/占用约束** | `heuristic_map_service.py`（全文 67 行无 `used` 集合） | 人物实例场景会产出错误标注 |
| 6 | **多处静默降级为空标签** | `map_labels_service.py:118-119`（且无日志）、`:163-164` | 失败被伪装成"成功但未标注" |
| 7 | **标注管线的 detection 级 scope 字段未真正生效** | `annotation_scope.py:192-206` 只读 `include/exclude_label_names` | 用户"只标注 X"可能不生效 |
| 8 | **无 SSE 心跳**：首轮 MCP 同步发现可能静默数十秒 | `agent.py` 流内无 keepalive | 只有前端 `waiting-model` 计时器兜底 |
| 9 | **消息列表无虚拟化** | `AgentMessageList.tsx` 全量渲染 | 长会话 + 大量工具块时是全量 DOM |
| 10 | **可观测性分散**：无统一 trace ID | `agentDebugLogger.ts` + `log_annotation_agent` | 难以串起一次请求的完整链路 |
| 11 | **文档与代码漂移**：README 说"无认证"（实际有 token 且 fail-closed）、说"不支持 skill 脚本"（实际已支持） | `vendor/local-agent/README.md:82`、根 `README.md:99` | 误导新读者 |
| 12 | **终端输出无 ANSI 解码** | 全 `src` 检索 `stripAnsi` 0 命中 | pip/npm 类彩色输出显示转义序列 |
| 13 | **视觉探针不尊重 `manual`**，每次覆盖；上下文探针尊重 | `visionProbe.ts` vs `contextProbe.ts` | 两个探针行为不对称 |
| 14 | **DeepSeek 关闭 thinking 的写法两处不一致** | `agent.py:154` vs `scripts/test-deepseek-tools.js:49` | 探针验证的开关 ≠ 生产路径的开关 |

### 10.3 对学习路线的建议

- **阶段 3（LangChain）**：本项目的 LangChain 用法**刻意很浅**，恰好适合作为"框架到底替你做了什么"的对照组。建议把 `bind_tools` → `astream` → `tool_call_chunks` → `ToolMessage` 这一条链路手工重写一遍（规划里的"最小 LangChain 工具 Agent"），再回看 `tool_loop.py`，就能看清哪些是 LangChain 给的、哪些是本项目自己加的。
- **阶段 4（Tool-Use-Loop）**：`tool_loop.py:448-720` 是全项目信息密度最高的 270 行，建议逐段配 `tests/test_tool_loop.py`（29KB）对照读——**测试本身就是行为规格说明书**。
- **阶段 5（记忆与 RAG）**：当前是"索引提示 + 精确读取文件"的渐进式披露，**没有向量检索**。缺口明确，适合做最小 RAG 实验。
- **阶段 6（LangGraph）**：不建议整体重写。最小侵入的切口是只让 LangGraph 接管 `tool_loop.py` 这一层，Electron UI、客户端工具、领域 Store 保持不变 —— 这也正是既有笔记 §12 的结论。

---

## 附：验证记录

| 项 | 命令 / 方式 | 结果 |
|----|------------|------|
| LangChain 版本 | `python -c "import langchain_core; print(langchain_core.__version__)"` | `1.4.0` |
| LangGraph 等未使用 | 全量正则检索 `langgraph\|create_agent\|AgentExecutor\|langsmith\|with_structured_output\|VectorStore` | 0 命中 |
| 测试套件 | `pytest -q`（`vendor/local-agent`） | **302 passed, 2 skipped, 6.32s** |
| 依赖清单 | `vendor/local-agent/requirements.txt` | 见 §1.3 |
| 代码规模 | `app/**/*.py` 与 `src/**/*.ts(x)`（排除测试） | 7,852 行 / 69,261 行 |
| 「Cancel 是死链路」 | 全 `src` 检索 `chat/cancel` | 0 命中（`client_job_id` 仅 2 处，均只发送） |
| 「无 error 事件」 | 通读 `agent.py:147-503` | 确认只有 `try/finally`，无 `except` |
| 「启发式无去重」 | 通读 `heuristic_map_service.py`（67 行） | 确认无 `used`/`seen` 集合 |
| 「detection scope 不生效」 | 通读 `annotation_scope.py:188-206` | 确认只读 `include/exclude_label_names` |
| 前端上下文预算 | 通读 `contextPreparer.ts` / `turnContext.ts` / `agentTypes.ts:211-218` | 20 轮 / 12,000 字符 / chars÷3 / 10% 窗口夹 8K–48K / 85% 触发 |

> 前端/Electron 部分的结论来自对 `serverProcess.ts`、`mcp/server.ts`、`agentJobRegistry.ts`、`contextPreparer.ts`、`turnContext.ts`、`agentTypes.ts`、`main.ts`、`preload.ts` 等文件的实际阅读与交叉验证；上表列出的是其中容易出错、因此单独复核过的关键结论。
