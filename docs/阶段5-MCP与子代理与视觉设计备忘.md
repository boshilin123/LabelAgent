# 阶段 5 设计备忘（MCP / 只读子代理 / 视觉兜底）

> **状态**：只读预研，**尚未写任何代码**。本文件是阶段 5 的实施规格草案。
> **来源**：子代理 P5 只读预研（2026-09-23）。路径相对 `LR-Agent\vendor\local-agent` 或 `.venvs\langchain-migration\Lib\site-packages`。
> **可信度标注**：未标注=已核对源码；标 **inferred**=尚未用运行代码验证。
> **本文件已被复核**（4 条关键支点独立验证，全部成立）：
> 1. 官方 1.4.2 **没有** `SubagentMiddleware` —— `langchain/agents/middleware/__init__.py:1-100` 的 21 个导出中无子代理/文件系统类；唯一设施是 `_subagent_transformer.py` 的 `SubagentTransformer`（`factory.py:33` 导入、`:1852` 注册），只服务 `astream_events` 的 `run.subagents`。
> 2. `Runtime.stream_writer` 字段存在（`langgraph/runtime.py:116`，默认 `_no_op_stream_writer` :206）。
> 3. 视觉兜底做成 `after_model` 的机制成立 —— `factory.py:1970-1972` 框架注释逐字为「AIMessage has tool calls, but there are no pending tool calls which suggests the injection of artificial tool messages. **Jump to the model node**」。
> 4. `custom` 分片走通用分支，形状为 `{"type": mode, "ns": ns, "data": payload}`（`langgraph/pregel/main.py:4219-4235`）。

---

## 1. MCP：留在 FastAPI 前置阶段

**唯一调用点** `app/api/v1/agent.py:372` 位于两条路径之前；`TestMcpUnavailable` 整体 patch 的正是 `app.api.v1.agent.load_mcp_tools_from_servers`（`tests/test_agent_baseline_contract.py:1211`）。**搬进 candidate builder 会使该 patch 失效 = 改基线测试。**

连接 / 发现 / TTL 缓存 / stale-while-revalidate / 单台失败隔离 / 跨 server 重名去重 / `disabled_tools` / `should_expose_mcp_tool` 全部继续复用 `app/agent/tools/mcp_client.py:192-293`（失败隔离 `:250-263`；重名 `:170-189`；禁用 `:274-277`；隐藏 `:108-124`）。

| 要点 | 事实 | 依据 |
|------|------|------|
| 首帧 `preparing(stage="mcp")` | 仅当配置了 MCP 时，由 HTTP 生成器在发现**之前**发出；candidate 分支必须逐字保留这 14 行，**适配器不得自己发** | `agent.py:355-368`；`tests/test_chat_stream_preparing.py:73-88`（无配置时要求该帧**不出现**）；阶段 4 备忘 §3 硬约束 2 |
| 失败不阻断 | loader 抛错由 `except Exception` 兜住，本轮存活、无 `error` 帧、本地工具非空且按名排序 | `agent.py:370-427`；阶段 0 实测 `test_agent_baseline_contract.py:1230-1285` |
| 确定性进入绑定列表 | 合并 → `sorted(tools, key=lambda t: t.name)`；请求内绑定的**名字集合不变** | `agent.py:403-421`、`:433-436`；`TestReadOnlyTools`（`:1176`）；阶段 2 备忘 §3 |
| 唯一允许的工具集变化 | 预算收尾轮 `override(tools=[])` | 阶段 2 备忘 §4.3；`assist_service.py:183` |
| 能力唯一性断言 | `registry.py:553-562` 只检查本地工具；MCP 事后合并且 `_infer_mcp_capability` 恒返回 `None`（`mcp_client.py:127-135`）→ **对 MCP 实际不设防** | 属**既有缺口**：阶段 5 **不修**，也不新增跨源断言（会引入计划外行为差异） |

---

## 2. 只读子代理：保留外层单一工具包装

**不要**改用嵌套 `create_agent`：内层 token 会混进同一 flat `stream_mode="messages"` 流，污染父 `text_delta`；且 `SubagentTransformer` 只在 `astream_events` 生效，而阶段 4 备忘 §7 已判定不得改用 `astream_events`。**结论：`explore_readonly` 仍是普通工具，内部继续跑现有 `ExploreReadonlyRunner`。**

逐条对照旧行为：

| 需求 | 旧实现 | 依据 |
|------|--------|------|
| 拿不到写入工具 | `resolve_explore_inner_names` 白名单减法 + `filter_explore_inner_tools/_fn_map` 双过滤；越权调用回 `"此工具不可用于只读查阅。"` | `explore_readonly.py:27-58,68-72,87-114`；`tool_loop.py:340-355`；实证 `test_explore_readonly.py:238-301`（write/self/memory 三计数器必须为 0） |
| 自带预算 | `settings.agent_subagent_max_tool_rounds`（默认 8），父预算不参与 | `explore_readonly.py:259-261` |
| 可取消 | 内层每轮开头与每次工具前查 `is_cancelled`；父侧在 `finally` 中 `task.cancel()` + `gather` | `explore_readonly.py:268-270,278,358-362,398-410`；`tool_loop.py:149-181` |
| 轨迹不入父消息链 | 父仅得到 `subagent_done.summary` → 一条 `ToolMessage`；内层 `messages` 是局部变量 | `tool_loop.py:190`（docstring 明写）、`:250-261`；`explore_readonly.py:253-256` |
| 父 `subagent_*` 事件不变 | `tool_start(explore_readonly)` → `subagent_start` → `subagent_text_delta`* → `subagent_tool_start/result`* → `subagent_done` → `tool_result`；并发时由 `_merge_async_iterators` 合并 | `tool_loop.py:191-215,241-262,664-700` |

**内层事件的带内通道（2026-09-23 探针已实测确认，不再是 inferred）**：内层事件经工具的 `runtime: ToolRuntime` 参数 → `runtime.stream_writer(payload)` 送出，**必须给 `stream_mode` 追加 `"custom"`**。实测结论：

| 事实 | 依据 |
|------|------|
| 工具声明 `runtime: ToolRuntime` 后注入生效，`stream_writer(payload)` 可用 | 识别点 `langgraph/prebuilt/tool_node.py:2020-2022`；注入点 `langgraph/pregel/tool_node.py:841-851` |
| **`stream_mode` 不含 `"custom"` 时，注入的是一个本地 `pass` 函数 → 静默丢弃、零帧、零异常** | `langgraph/pregel/main.py:3300-3303`（同步版 `:2857-2860`）——**阶段 4/5 适配器必须硬断言模式清单** |
| 分片形状 `{"type":"custom","ns":(),"data":payload}`；**`ns` 恒为 `()`，不标识工具作用域** | `main.py:4234-4235` + 探针原始输出 |
| payload 原样存活（嵌套 list/None/bool/float/中文键值逐字节相等） | 探针 A 组 |
| 到达顺序：`updates[model]` → `custom`×N → `messages`(ToolMessage, node=tools) → `updates[tools]` | 探针原始输出 |
| 在 `asyncio.to_thread` 内写帧安全（`call_soon_threadsafe`） | `main.py:3285-3297`——直接支撑 `assist_vision` 的 to_thread 形态 |
| 与 `context_schema=AgentContext` + `build_business_middleware` 共存，工具恰好执行 1 次 | 探针 Q4 |

**因此**：原「退路方案（wrap_tool_call 队列 / Runtime.context sink）」**可丢弃**。但必须做到两点：① 适配器把 `"custom"` 作为**硬断言**（缺了会静默丢帧）；② **不要**用 `ns` 归因来源，只能靠 payload 内容 + 到达顺序。

---

## 3. 视觉兜底：放 middleware 的 `after_model`

**触发语义（延续旧路径）**：首轮、非 resume、`provider_is_vision`、`vision_fn` 存在、`user_content` 命中图片正则，且解析出的路径确为存在的图片。旧触发点是「**第一轮无 tool call**」（`assist_service.py:158-167`），**不是**「进模型前」——`tests/test_vision_bootstrap.py:6-9` 明确禁止 `try_bootstrap`。依据：`vision_bootstrap.py:42-46`、`assist_vision.py:36-57`。

**为何不能放调用侧**：无 checkpointer 时框架不把累积消息链交回调用方（`_handle_model_output` 只返回 delta，`factory.py:1194-1220`），调用侧无法发起「同一消息链的第二次 astream」。

**做法**：`after_model` middleware 先按 `stream_vision_tool_execution` 的语义用 `asyncio.to_thread` 调 `read_image_for_vision`（`assist_vision.py:78-82`），再返回「合成 `AIMessage`（带伪 vision tool_call，id 形如 `lr-vision-fallback-*`）+ `ToolMessage(display_result)`」；`_make_model_to_tools_edge` 第 6 步对「有 tool_calls 但无 pending」的 AI 消息回跳 model（`factory.py:1950-1957,1970-1972`），等价于旧路径的 `continue`。多模态 `HumanMessage` 同批追加（`build_multimodal_user_message`，`assist_vision.py:96-104`；`chat_message_builder.py:53-80`）。

**事件顺序必须保住**：`tool_start` → `tool_result` → 图片消息（`assist_vision.py:71-104`）。帧由 `runtime.stream_writer` 发出，适配器按到达顺序输出。**inferred**：`after_model` 注入的帧与框架 `updates["model"]` 的到达顺序需探针确认，必要时由适配器按 `langgraph_step` 排序。

**模型主动调用路径**：`tool_loop.py:339-347` 的多模态 `HumanMessage` 应放在 `wrap_tool_call` 的中间件里（工具返回后追加消息）。**inferred**：`wrap_tool_call` 只能返回 `ToolMessage`，追加 `HumanMessage` 可能需走 `ExtendedModelResponse`（`middleware/types.py:34`）——两条路径落点不同，实现时分别验证。

读图失败仍是 `"工具执行失败: {exc}"`（`assist_vision.py:81-82`），**不得新增 `error` 帧**。

---

## 4. 门槛与测试映射

| 需求 | 证明用例 | 需扩展？ |
|------|---------|---------|
| 单台失败不影响其他 | `test_mcp_servers.py:92-99` | 否（loader 不改） |
| 重名冲突 / 能力冲突 / 禁用工具 | `test_mcp_servers.py:102-127,158-171,214-229` | 否 |
| 首帧 `preparing(mcp)` + 无 `error` 帧 + 本地工具有序 | `test_agent_baseline_contract.py:1230-1285`、`test_chat_stream_preparing.py:73-88` | **扩展**：加 candidate 入口的同类 HTTP 用例（复用 `_collect_sse` 的 patch 点，断言绑定工具来自 candidate builder） |
| 只读轮零写入、写工具仍在 bind 列表 | `TestReadOnlyTools`（`:1091-1176`） | **扩展**：候选侧断言改为 `bound_tool_names` 稳定性（阶段 2 备忘 §7 风险 1） |
| 子代理越权 / 预算 / 取消 | `test_explore_readonly.py:74-125,128-153,238-301` | 否（纯函数与 runner 未改） |
| 父 `subagent_*` 序列不变 | `test_explore_readonly.py:359-451` | **扩展**：加 candidate 适配器版，断言九类事件名与 `tool_call_id` 对齐 |
| 视觉 should_load 四分支 | `test_vision_bootstrap.py:12-53`、`test_assist_vision.py:4-7` | 否 |
| 视觉兜底端到端（有图 / 无图 / 读失败） | **缺**：现有测试只覆盖决策与路径解析 | **新增**三条候选侧集成用例 |

---

## 5. 风险与未知

**已由探针 settle（不再是风险）**：

1. ~~`ToolRuntime` 注入可用性~~ → **可用**（见 §2 表）。
2. ~~`"custom"` 与 `updates`/`messages` 的相对到达顺序~~ → 实测 `updates[model] → custom×N → messages(ToolMessage) → updates[tools]`；`ns` 恒为 `()`。

**探针新发现的风险（5 条，两条最要紧）**：

1. **合成 `AIMessage` 会被回放到 `messages` 流**：v1 handler 发节点输出中的任何 `BaseMessage`（`langgraph/pregel/_messages.py:106-120`），v2 handler 只跳过 `ToolMessage`、**仍发 `AIMessage`**（`:307-334`）。实测帧：`messages node=VisionFallbackProbe.after_model cls=AIMessage content=''` 与同节点 `cls=ToolMessage`。→ **适配器必须按 metadata 的 `langgraph_node` 过滤掉后缀为 `.after_model` 的帧**，否则会多出一条空 `text_delta`、甚至重复 `tool_result`。
2. **视觉兜底的轮次守卫必须无条件落盘计数**：朴素实现（只在真正触发时置 `vision_attempted`）在「第一轮调了真实工具、第二轮无调用」时会**误触发**兜底（实测 `model_calls=3`、多 2 条 custom 帧）；旧语义是「**第一轮**无 tool call」（`assist_service.py:158-167`）。修正后 `model_calls=2`。写计数时提前 `return None` 会丢计数。
3. **预算交互已量化**：兜底那次模型调用被 `BudgetWrapUpMiddleware` / `ModelCallLimitMiddleware` 照常计数；`max_tool_rounds=0` 时 `wrap_up_at=2`，兜底轮正好撞上收尾轮，call#2 输入末尾会多出「预算已用完」的 `HumanMessage`（调用总数仍 2，属占用而非新增）。`max_tool_rounds=1` 不受影响。
4. **视觉兜底 middleware 必须放在 `extra=[...]` 末位**：以保住 `BusinessRoundMiddleware` 作为 `loop_exit_node` 的 jump 控制权（`factory.py:1789-1800`）。实测两种排序都不冲突（`BusinessRoundMiddleware.after_model` 对此返回 `None`），但末位是结构性保证。
5. `ToolRuntime` 的 `field_name='context'` pydantic 序列化告警是外观性的；`tool.get_input_schema().model_json_schema()` 会抛 `PydanticInvalidForJsonSchema`，但 `convert_to_openai_tool` 走 `tool_call_schema`，真实 `ChatOpenAI.bind_tools` 不受影响（已存记忆 `ins_1b579cbe`）。

**仍未验证**：`ns` 在嵌套子图内是否非空（未测；本阶段已确定不用嵌套 `create_agent`，不影响落地）。

---

## 6. 阶段 5 实施清单（按依赖序）

| # | 实施项 | 证明 |
|---|--------|------|
| 1 | ~~**探针**：工具内 `ToolRuntime.stream_writer` + `stream_mode=["messages","updates","custom"]` 的到达形状与顺序~~ **已完成（2026-09-23）**：全部 YES；`custom` 缺席时静默丢弃；`ns` 恒 `()` | `experiments/probe_stage5_stream_writer.py` + `.out.txt` |
| 2 | ~~**探针**：`after_model` 注入「合成 AI + ToolMessage」是否回跳 model~~ **已完成（2026-09-23）**：YES，恰好 +1 次模型调用、不进 `tools` 节点；唯一可用形状 = **AI（伪 tool_call，id 形如 `lr-vision-fallback-*`）在前 + id 匹配的 ToolMessage 在后**；顺序颠倒/id 不匹配/只注 AI 都会把伪调用送进 `tools`（得到 `not a valid tool`），只注 ToolMessage 则不回跳；无守卫会无限循环（`recursion_limit=12` 时 `GraphRecursionError`） | `experiments/probe_stage5_after_model_vision.py` + `.out.txt`、`experiments/PROBE-STAGE5-FINDINGS.md` |
| 3 | 阶段 4 适配器追加 `"custom"` 分片处理 + `subagent_*` 直通 | candidate 版 `test_explore_readonly.py:359-451` |
| 4 | `ExploreToolRuntimeAdapter`：把 `ExploreReadonlyRunner.stream` 包成带 `ToolRuntime` 的工具 | candidate 版 `test_explore_readonly.py:238-301`（写工具零执行） |
| 5 | `VisionFallbackMiddleware`（`after_model`） | `test_vision_bootstrap.py` 四分支 + 新增端到端三条 |
| 6 | `VisionToolResultMiddleware`（`wrap_tool_call`，追加多模态消息） | 新增候选侧用例 |
| 7 | MCP：candidate 入口复用 `agent.py:355-436` 前置段，不改 loader | `TestMcpUnavailable` 两例 + `test_chat_stream_preparing.py`（**不改一行**） |
| 8 | 组合测试（MCP 失败 + 只读子代理 + 视觉兜底同轮，只读路径零写入） | 新增 `TestStage5Combined` |
| 9 | 双环境全量 `python -m pytest -q` 并记录测试集指纹 | 门槛：baseline `324 passed, 2 skipped` 不变 |

> **反向依赖提醒**：第 3 项意味着阶段 4 已冻结的适配器接口要**追加** `"custom"` 流模式——已回写 `docs/阶段4-SSE适配设计备忘.md` §1。
