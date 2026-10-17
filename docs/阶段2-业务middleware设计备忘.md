# 阶段 2 业务 middleware 设计备忘（实施规格）

> **状态**：只读预研，**尚未写任何代码**。本文件是阶段 2 的实施规格草案，实施后须以测试结果替换"预期"表述。
> **来源**：子代理 P2 只读预研（2026-09-23）。所有"旧路径"结论引用 `路径:行号`；所有"框架"结论引用**已安装包**的实际源码路径与符号。
> **可信度标注**：正文未标注者=已核对源码；标 **inferred** 者=尚未用运行代码验证。
> **本文件已被复核**：`factory.py:1953-1957`（注入 ToolMessage 可剔除 pending tool_call）、`model_call_limit.py:201-208`（超限固定答复）、`tool_retry.py:159-161`（默认会重试未分类异常）、`factory.py:1432-1439`（`final_tools` 为空走 `model.bind()`）四条引用经逐字复核**成立**。

> ## ⚠️ 实施期修正（2026-09-23，S2 实测；验收记录见 `docs/阶段2-验收记录.md` §5）
> 本节修正优先于下文正文；正文中与本节冲突的表述**以本节为准**。
> 1. **顺序修正**：`BusinessRoundMiddleware` 必须放在 `middleware` 列表**首位**（正文 §1 写的第 4 位是错的）。原因：`after_model` 逆序执行且 `loop_exit_node` 是列表里第一个带 `after_model` 的中间件；`ModelCallLimitMiddleware.after_model` 返回的 dict **不含 `jump_to`**，若它后执行会静默抹掉我方 `jump_to` → 被抑制的 ASYNC 调用**照常在后端执行**。最终列表：`[BusinessRoundMiddleware, ModelCallLimitMiddleware(run_limit=max_tool_rounds + 2, exit_behavior="end"), ToolErrorMiddleware, ToolRetryMiddleware, BudgetWrapUpMiddleware]`。
> 2. **机制补充**：`after_model` 返回含 `messages` 的 dict 会**无条件**路由到 `tools` 节点；**只靠注入不足以保证零执行**，纯抑制轮必须显式改道，且必须有 `awrap_tool_call` 对 `ToolRunner.ASYNC` 的**无条件语义拦截**作为决定性保证。
> 3. **`jump_to="model"` 会死循环**：`_resolve_jump("model")` 返回 `loop_entry_node`，无 `before_model` 时它就是 `"model"` 自身 → 需要 message-id 重入守卫。
> 4. **`@hook_config(can_jump_to=[...])` 是硬要求**（正文 §1 未提）：`factory.py:2067-2091` 只在 `can_jump_to` 非空时才把该 hook 的边建成条件边，否则 `jump_to` 被**静默忽略**（症状：混合轮多出一次模型调用）。
> 5. **预算计数为 `max_tool_rounds + 2`**（正文 §4 的 `+1` 是错的）：按 `+1` 会吃掉最后一次工具轮（`max_tool_rounds=1` → 1 次执行 / 2 次模型调用；基线要求 2 次执行 / 3 次调用）。语义澄清：计数指**已发生的模型调用数**。
> 6. **兜底轮必须同时清空 `tool_calls` 与 `tool_call_chunks`**（仅 `override(tools=[])` 不足）。
> 7. **正文 §2「每个 `tool_call_id` 必有结果」不成立**：只有**被调度**的调用需要结果；存活挂起调用没有 `ToolMessage`（旧路径同样没有）。
> 8. 旧路径只对 `already_completed` 与 `phase_blocked` 追加 `ToolMessage`；候选侧额外注入 `coalesced`/`duplicate_call` 仅为阻止其进入 `tools` 节点（纯字段判定），副作用安全。
> 9. 写类工具失败的**显示层摘要化**属阶段 4 适配器职责，不落在 middleware。
> 10. 正文 §7 风险 3（并行只读落序）已由探针升级为**实测事实**：执行顺序 == 模型给出的顺序。

---

## 1. middleware 清单与顺序

`create_agent(model, tools, middleware=[...])`（`langchain/agents/factory.py:1040-1096` 收集并按 hook 类型链式组合）

```python
middleware=[
  ModelCallLimitMiddleware(run_limit=max_tool_rounds + 2, exit_behavior="end"),        # [0]
  ToolErrorMiddleware(on_error=_old_err, aon_error=_old_err_async, tools=SYNC_NAMES),  # [1]
  ToolRetryMiddleware(max_retries=2, tools=RETRYABLE_READONLY,
      retry_on=(ConnectionError, TimeoutError), on_failure="error",
      backoff_factor=2.0, initial_delay=1.0, max_delay=60.0, jitter=True),              # [2]
  BusinessRoundMiddleware(...),   # 自定义 [3]：after_model + wrap_tool_call
  BudgetWrapUpMiddleware(...),    # 自定义 [4]：before_model + after_model + wrap_model_call
]
```

顺序依据（不同 hook 的折叠方向不同）：

- `wrap_model_call` / `wrap_tool_call`：**列表首个 = 最外层**（`middleware/types.py:515/609/683/766`；`factory.py:1052-1056,1154-1161`）。
- `before_model`：**按列表顺序**，入口为 `[0]`（`factory.py:1650-1651,1767-1784`）→ 硬上限先判，`[4]` 的 before_model 后跑（此时 `run_count=N+1<N+2`，不会误跳 end）。
- `after_model`：**逆序**（model → `[-1]` → … → `[0]`，`factory.py:1789-1800`）→ 实际执行序 `[4]→[3]→[0]`。
- `ToolErrorMiddleware` 必须在 `ToolRetryMiddleware` **外层**：retry 需在内层且 `on_failure="error"`，异常才会交给 error middleware（`middleware/tool_error.py:58-60`）。

**不使用**：`HumanInTheLoopMiddleware`（基于 `interrupt()`，`human_in_the_loop.py:12,481`）与 `thread_limit`（依赖跨 run 状态，`model_call_limit.py:33-34,103-107`）——无 checkpointer 时无法恢复/不累积，与 `run_limit` 等价；计划 §3 已排除 checkpointer（官方未在代码中断言必需，**inferred**）。仅 `[3]`、`[4]` 需自写。

---

## 2. 同轮决策（工具执行前）

`after_model` 读 `state["messages"][-1].tool_calls` 计算「本轮计划」并写入自定义 state 字段；`wrap_tool_call` 通过 `request.state` 落地——`ToolCallRequest.state` 在执行时从 channels 水合（`langgraph` `tool_node.py:1298-1312`），**包含 `after_model` 的写入**。

**严格复刻旧 `execute_round` 的顺序**（`app/agent/assist/tool_loop.py`）：

| 步骤 | 旧路径行号 | 候选实现 |
|------|-----------|---------|
| already_completed 过滤 | 458-487 | `after_model` 读取已完成集合（阶段 3 跨请求播种） |
| 标注写 / 工作区写同轮互斥 | 491-520 | 有标注写时，全部 `WORKSPACE_WRITE_TOOLS` → `status="phase_blocked"`（理由 509-512） |
| `check_call_allowed` 门禁 | 522-539 | 执行层唯一门禁（见 §3） |
| SYNC/ASYNC 拆分 | 541（`tool_dispatcher.py:17-25`） | 按工具能力判定 |
| 多 `auto_annotate` 合并 | 543-593 | paths 首见序并集；`all_files` 取 OR；`write_mode` 任一为 `replace_matching` 则替换（548-567） |
| 同范围去重 | 595-617 | `scope_key=(name, extract_call_paths(args))`（含 `scope_hint`、`coerce_str_list`，`task_phase.py:154-165`）；重复者 `status="duplicate_call"`（理由 605） |

被合并/被抑制调用的反馈：按 `_yield_blocked_call` 产生 `build_tool_result(ok=False, status="coalesced", summary="本次调用已并入第一个 auto_annotate（paths 合并为 {paths}），请勿重复发起。")`（401-427, 576-585）。

**机制**：被抑制调用的 `ToolMessage` 由 `after_model` 直接以 `{"messages":[...]}` 注入；框架据 `tool_call_id` 把它们从 `pending_tool_calls` 剔除，**永不进入 ToolNode**（`factory.py:1953-1957,1963-1964`）——官方 `ToolCallLimitMiddleware` 同法（`middleware/tool_call_limit.py:411-420`）。合并后的首个调用用 `handler(request.override(tool_call={**request.tool_call, "args": merged_args}))` 改写参数（`override` 见 `tool_node.py:170-199`）。

> ⚠️ **hook 顺序（2026-09-23 实测 + 源码复核，重要）**：`after_model` **早于 tools 节点**执行，而且 model→tools 的路由决策就挂在该 after_model 节点上——`factory.py:1543/1547` 建 `model`/`tools` 节点、`:1789` `graph.add_edge("model", "<最后一个>.after_model")`、`:1664-1665` `loop_exit_node = "<第一个>.after_model"`、`:1703` `model_to_tools_destinations = ["tools", exit_node]`。
> **推论：不得在同一轮的 `after_model` 里用 `jump_to="end"` 结束回合——那会静默跳过 SYNC 工具的执行。** 正确的回合终止是**两段式**：本轮 `after_model` 只注入合成 `ToolMessage`（抑制 ASYNC/被合并/被门禁的调用，SYNC 照常进 tools 节点），**下一轮**由 `before_model` 再 `jump_to="end"`（`factory.py:1775-1784` 允许 `before_model` 跳转）。该两段式属阶段 3，详见 `docs/阶段3-跨请求续跑设计备忘.md`。

> ⚠️ **阶段 1 早停必须被取代**：`app/agent/langchain_runtime/runtime.py:172-189` 的 `_client_calls_in()` 只按**工具名**判定，`:273-283` 一旦出现客户端工具名就 `break`；混合同轮 `[SYNC, ASYNC]` 会因此在 tools 节点执行前断流，**SYNC 工具零执行**，与阶段 0 基线冲突。阶段 2 必须以本节 `after_model` 注入机制取代该早停。

**并发安全**：middleware 实例跨并发 run 共享，本轮计划**不得存 `self`**，只放 state 通道。每个 `tool_call_id` 必有结果由框架保证。

**事件顺序约束**：被并者的 `tool_start/tool_result` 先于首个的 `tool_start/tool_pending`（575-585 vs 716-719）；middleware 不能直接 yield，改用 `runtime.stream_writer`（`middleware/types.py:1200-1217`）发帧，由适配器统一排序。

---

## 3. 阶段门禁：执行层唯一

单一执行层门禁：`BusinessRoundMiddleware` 调 `check_call_allowed(name, args, ctx)`（`task_phase.py:177-233`），拒绝时逐字返回旧理由。

**不得**在 `wrap_model_call` 里 `override(tools=...)` 隐藏工具：基线要求写工具仍在 bind 列表（`tests/test_agent_baseline_contract.py::TestReadOnlyTools`），`app/api/v1/agent.py:429-436` 明示保持列表稳定以命中 system prompt 前缀缓存；`blocked_tool_names`（`task_phase.py:168`）生产中从未被调用（仅 `tests/test_task_phase.py` 引用，且计划 §5-阶段 2 已标注废弃）。

结论：计划行动 1 的「调用前隐藏」应按基线解释为**工具列表不动**，门禁 = `after_model` 拦截 + `wrap_tool_call` 兜底二次检查。

---

## 4. 预算收尾

`ModelCallLimitMiddleware` 单独**不等价**：超限时注入固定 `AIMessage("Model call limits exceeded: …")`（`model_call_limit.py:203-208`）；旧路径是追加 `HumanMessage` 后**无工具**再调一次（`assist_service.py:170-188`），`astream_calls == max_tool_rounds + 2`（基线测试断言）。

自定义件 `BudgetWrapUpMiddleware`：

1. `after_model` 自增自定义计数；
2. `before_model` 在计数 == `max_tool_rounds + 1` 时返回 `{"messages":[HumanMessage("工具调用预算已用完。请基于以上进展直接给出最终回答，不要再调用工具。")]}`（对应 `assist_service.py:175-182`）；
3. `wrap_model_call` 在收尾模式 `request.override(tools=[], tool_choice=None)` —— `factory.py:1432-1439` 在 `final_tools` 为空时只 `model.bind()` 不 `bind_tools`，与 `assist_service.py:183` 的 `llm.astream(messages)` 等价（**已逐字复核**）；再把返回的 `ModelResponse.result` 的 `tool_calls` 置空，使 `_make_model_to_tools_edge` 走 end（`factory.py:1950-1951`）→ 复刻「兜底轮 tool_call 不执行」；
4. `run_limit=max_tool_rounds + 2` 仅作硬上限。

---

## 5. 工具错误与重试

- **不可重试**：标注写入（`task_phase.py:23-25`）与工作区写入（26-33）。
- **可重试**：仅只读（`tool_loop.py:69-80`），且**必须显式** `retry_on`：默认 `default_retry_on` 会重试「所有未分类异常」（`tool_retry.py:159-161`，已逐字复核），会把基线的 `RuntimeError("磁盘炸了")` 重试成 4 次，违反「恰好 1 次」；不匹配的异常立即 re-raise 且**不**走 `on_failure`（`tool_retry.py:334-336`）。同步路径 `time.sleep`（`tool_retry.py:349`）会阻塞事件循环，本项目只走 `awrap_tool_call`（:413）。
- **对模型呈现的错误文本**必须复用既有管线：普通工具 `工具执行失败: {exc}`（`tool_loop.py:100-104` + `:280`）；未注册工具 `未知工具: {name}`（86-90）——`request.tool is None` 即未注册（`tool_node.py:138-141`），因为框架默认只把 `ToolInvocationError` 转成 `ToolMessage`、其余 re-raise（`tool_node.py:383-391,753`）。
- 写类工具失败**不做摘要化**（`tool_loop.py:275-280` 缺 `else`）。
- **不得引入 `error` SSE 帧**：`StreamEventPayload.type` 是自由字符串（`schemas/agent.py:139-142`），但 chat/stream 全链路从不发 `error`（`agent.py:556/585` 是流前 `JSONResponse`）；基线显式断言其缺席。官方 `ToolMessage(status="error")`（`tool_error.py:168-173`）≠ SSE `error` 帧。

---

## 6. 不可复刻 / 风险（含证据）

1. **`bind_tools` 调用次数**：候选每次模型调用都会 bind（`factory.py:1432-1436`），旧路径只在开头 bind 一次（`assist_service.py:38`，基线断言 `bind_tools_calls == 1`）→ **候选侧断言必须改用 `bound_tool_names` 稳定性**，否则产生假失败。（已核实）
2. **`ToolMessage.status`**：官方置 `"error"`，旧路径默认 `"success"`（`tool_loop.py:287`）；路由只看 id（`factory.py:1946-1957`），逐对象比较会出现差异。（已核实）
3. **并行只读落序**：候选每个 tool_call 单独 `Send`（`factory.py:1963-1964`），writes 按 task path 稳定排序（`langgraph/pregel/_algo.py:253-256`）。确定性成立，但「等于模型给出的顺序」为 **inferred**，需探针验证。
4. **`already_completed` 跨请求去重**：依赖请求级 `client_tool_results`（`assist_service.py:83-93`、`tool_loop.py:458-461,469-487`），hook 看不到 resume 状态 → 阶段 3 播种；阶段 2 只覆盖同 run。
5. **`tool_choice="any"` 伪代码兜底**（`tool_loop.py:107-131,380-399`）：触发依赖扫描已流出的正文并改用非流式 `ainvoke`；`wrap_model_call` 可 `override(tool_choice="any")`（`factory.py:1435`）但看不到流式正文。**inferred：可改写，语义不等价。**
6. **视觉兜底与取消无对应 hook**：取消必须留在调用侧 `astream` 迭代（`assist_service.py:99-112,173-174`；基线 `TestCancel` 钉住 `astream_calls` 与被弃帧）；视觉兜底（158-167）属阶段 5。

---

## 7. 阶段 2 实施清单（按依赖序）

| # | 实施项 | 证明用例 |
|---|--------|---------|
| 1 | 纯函数「本轮计划」层（复用 `task_phase` + `tool_dispatcher`） | `TestMultipleTools::test_two_parallel_read_tools_keep_order_and_ids` |
| 2 | `after_model` 注入 coalesced / duplicate_call / phase_blocked 的 `ToolMessage`（顺序同 `execute_round`） | `TestDismissAndReject::test_all_dismissed_clears_gate_and_allows_replanning` + `experiments/compare_agent_contract.py` 四场景 |
| 3 | `wrap_tool_call` 兜底门禁 + 合并参数改写 | `TestReadOnlyTools::test_read_only_rounds_emit_no_proposal_and_never_run_write_tools` |
| 4 | `check_call_allowed` 执行层门禁 | `tests/test_task_phase.py` 同类断言 |
| 5 | `ToolErrorMiddleware` 文本映射 + 未知工具分支 | `TestToolError::test_raising_tool_becomes_error_tool_result_without_retry`、`::test_unknown_tool_reports_error_json` |
| 6 | 收窄 `ToolRetry`（只读 + 显式 `retry_on` + `on_failure="error"`） | `TestToolError::test_raising_tool_becomes_error_tool_result_without_retry`（恰好 1 次） |
| 7 | `BudgetWrapUp` + `ModelCallLimitMiddleware(run_limit=N+2)` | `TestBudgetExhausted::test_exhaustion_forces_final_answer_and_counts_executions`、`::test_wrapup_tool_call_is_ignored` |
| 8 | 适配器不发 `error` 帧、`done` 归属不变 | `TestToolError::…without_retry`、`TestMcpUnavailable::test_mcp_empty_result_keeps_turn_alive` |
| 9 | ASYNC 挂起结束本轮（阶段 3 边界；阶段 2 先保证零后端执行） | `TestMultipleTools::test_sync_and_async_tool_same_round_executes_sync_then_pends` |

> **对照测试的强制约定**：候选侧复用阶段 0 的 `ScriptedChat` 时，`bind_tools_calls` 与 `ToolMessage.status` 两处**必然**与旧路径不同（风险 1/2）。阶段 2/4 的对照测试必须改为断言 **`bound_tool_names` 稳定性**、`tool_call_id` 对齐、`tool_result` 载荷与事件序列，否则会产生假差异。
