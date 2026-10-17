# 阶段 4 SSE 事件适配设计备忘（实施规格）

> **状态**：只读预研，**尚未写任何代码**。本文件是阶段 4 的实施规格草案，实施后须以测试结果替换"预期"表述。
> **来源**：子代理 P4 只读预研（2026-09-23）。"旧路径"结论引用 `路径:行号`；"框架"结论引用**已安装包**源码路径与符号。路径相对 `LR-Agent\vendor\local-agent`。
> **可信度标注**：未标注=已核对源码；标 **inferred**=尚未用运行代码验证。
> **本文件已被复核**（4 条强断言逐条独立验证）：
> 1. `CONFIG_KEY_STREAM_MESSAGES_V2` 仅由 `astream_events` 内部设置（`langgraph/pregel/main.py:3548,3603`），判定点在 `main.py:2813-2818`；框架 docstring 明写「direct `graph.stream(stream_mode="messages")` callers keep the v1 `AIMessageChunk` shape」（`pregel/_messages.py:268-272`）→ **成立**。
> 2. v2 handler 跳过 `ToolMessage`，v1 不过滤（`_messages.py:307-314`）→ **成立**。
> 3. `document_proposal` 在后端**零生产者**（仅 `app/schemas/agent.py:200/204/215` 的映射引用）→ **成立**。
> 4. `experiments/langchain_multitool_spike.py:27-42` 的 `MultiCallModel` 只实现 `_generate`、**无流式** → `compare_agent_contract.py` 从未触达 messages 流 → **成立**。

---

## 1. 来源事件清单（框架侧）

入口：`agent.astream(input, config, stream_mode=["messages","updates"], version="v2")` → `StreamPart`（`langgraph/types.py:352-362`；mode 全集 `types.py:131-133`）。

| 项 | 事实 | 依据 |
|----|------|------|
| `messages` 分片形状 | `data=(message, metadata)`；**直接 `astream` 时 `data[0]` 是 `AIMessageChunk`，不是协议事件 dict** | `types.py:297-308`；`main.py:2813-2820`；`pregel/_messages.py:268-272`（**已复核**） |
| (a) 文本增量 | `AIMessageChunk.content`；**存在尾随空 chunk**（`content=""`, `chunk_position="last"`），恒空、不重复文本 | `_messages.py:104`；`langchain_core/language_models/chat_models.py:816-832` |
| (b) reasoning | `additional_kwargs["reasoning_content"]`，形状同旧路径 | `langchain_core/messages/base.py:40-42` |
| (c) 工具参数分片 | `chunk.tool_call_chunks[]`，字段 `name/args/id/index`；首块带 `id`，后续 `id=None`，`index` 每轮从 0 重编号 | `langchain_core/messages/ai.py:427` |
| (d) 工具结果 | `ToolMessage` 同时在 messages 流（`node="tools"`）与 `updates["tools"]["messages"]`；**v1 handler 不过滤 ToolMessage** | `_messages.py:307-334`（**已复核**） |
| (e) 停下等客户端工具 | **独立** `updates` 分片 `{"__interrupt__": (Interrupt(id,value),)}`，且**无** `updates["tools"]` | 实测；`middleware/human_in_the_loop.py:481` |
| 节点名 | `"model"` / `"tools"`；after_model 为 `"{name}.after_model"` | `langchain/agents/factory.py:1543/1547`、`:1789` |

实测分片顺序：model chunks → `updates["model"]`（携带 `AIMessage.tool_calls`，args 已是 dict）→（后端工具执行）→ `updates["tools"]` → 下一轮。

> **追加要求（阶段 5 反向依赖，2026-09-23 回写）**：`stream_mode` 必须**追加 `"custom"`**，即 `stream_mode=["messages","updates","custom"]`。原因：阶段 5 的只读子代理事件要靠工具的 `runtime: ToolRuntime` 参数经 `runtime.stream_writer(payload)` 在带内转发，而 `custom` 分片走的是通用分支，形状为 `{"type": "custom", "ns": ns, "data": payload}`（`langgraph/pregel/main.py:4219-4235`；`Runtime.stream_writer` 字段见 `langgraph/runtime.py:116`）。适配器据此把 `type == "custom"` 的 `data` 直通为 `StreamEventPayload`（`subagent_*` 等）。注意：`custom` 分片与 `messages`/`updates` 的**相对到达顺序**尚未验证（阶段 5 备忘 §5 风险 2，需探针），必要时由适配器按 `langgraph_step` 排序。未使用 `custom` 时该模式无副作用，故本条对阶段 4 自身的行为无影响。

---

## 2. 映射表（只填 snake_case 字段，重命名一律交给 `to_sse_dict()`）

| 框架来源 | 产出 | 备注 |
|---|---|---|
| messages / `AIMessageChunk.content` | `text_delta(content)` | **原样复用** `events_from_chunk(chunk, emit_tool_chunks=False)` |
| … `additional_kwargs["reasoning_content"]` | `reasoning_delta(content=str(v))` | 同一 chunk 内 text **先于** reasoning，顺序不可改（`stream_adapter.py:12-25`） |
| … `tool_call_chunks` | 交给 `ProposalStreamInterceptor.on_chunk` → 仅 `file_proposal_start/_delta`、`file_edit_delta` | **绝不**在此处发 `tool_start` |
| `ToolMessage`（messages 与 `updates["tools"]` 双源，按 `tool_call_id` 去重） | `tool_result(tool_call_id, result)`；失败写工具补 `file_proposal(status="dismissed")`，成功补 `file_proposal_start` + 200 字长 `file_proposal_delta` + `file_proposal` | 照抄 `tool_loop.py:282-337`；**不得统一摘要化**（阶段 0 §8-6） |
| `updates["model"\|"*.after_model"]["messages"][-1].tool_calls` | 有序调用表 → `tool_start(tool_call_id, name, arguments=json.dumps(args, ensure_ascii=False, indent=2))`；被合并/门禁者 → `tool_result(status="coalesced"/"phase_blocked")` | |
| `updates["__interrupt__"]` | 轮末标记 → 中断调用发 `tool_start` + `tool_pending(client_tool_calls=[…])` | |
| 适配器自身 | 首帧 `preparing(stage="streaming")` | 对齐 `assist_service.py:36` / `chat_service.py:13` |

**重命名（`app/schemas/agent.py`，不要在适配器里手工拼 camelCase）**：`tool_call_id`→`toolCallId`(:189-190)；`client_tool_calls`→**双写** `clientToolCalls` + `toolCalls`(:239-249)；`image_path`→`suggestedRelativePath`（四类提案事件）否则 `imagePath`(:199-203)；`summary`→`title`（`detail` 兜底 :204-208）；`mode`→`operation`(:209-217)；`old_path`→`oldPath`(:218-222)。

**事件类型全量**：`preparing / text_delta / reasoning_delta / tool_start / tool_result / tool_pending / file_proposal_start / file_proposal_delta / file_edit_delta / file_proposal / subagent_{start,text_delta,tool_start,tool_result,done}`，外加 HTTP 层的 `done`。`document_proposal` 虽被 `to_sse_dict` 引用但**后端无生产者**（**已复核**），勿新增。

---

## 3. 顺序契约

| 场景 | 精确序列 | 基线出处 |
|---|---|---|
| 普通文本轮 | `preparing{streaming}` → `text_delta`* → `done` | `tests/test_agent_baseline_contract.py:238` |
| 工具轮 | deltas → 按**模型调用序** `tool_start(t1),tool_result(t1),tool_start(t2),tool_result(t2)`（即使后端并行执行）→ 下轮 deltas → `done` | `:294-299`、`:370-377` |
| `tool_pending` 收轮 | （deltas）→ 模型序内的 `tool_start/tool_result`（含被合并/门禁者）→ 每个 ASYNC 调用 `tool_start` → `tool_pending`（`clientToolCalls`+`toolCalls`）→ `done`，**且不再发起第二次模型调用** | `:450-456`、`:492` |
| 取消 | SSE 仅 `[{"type":"done"}]`（HTTP 层在 `yield` **之前**检查） | `app/api/v1/agent.py:486-487`；`:1294-1320` |

**三条硬约束**
1. 适配器**不得**发 `done` —— 唯一产地是 `app/api/v1/agent.py:498`（阶段 0 §8-7）。
2. 适配器**不得**发 `preparing(stage="mcp")` —— 由 HTTP 生成器在调用 `stream_assist` 之前发出（`agent.py:358-368`；`tests/test_chat_stream_preparing.py:73-80` 要求它是首帧）。
3. 适配器必须是**素 async generator**，除取消判定外不吞异常，否则 HTTP 层契约失效。

---

## 4. 提案流式

真实 `AIMessageChunk` 直接喂 `on_chunk` 已被实验验证（`experiments/langchain_proposal_spike.py:83-92`：`["file_proposal_start","file_proposal_delta","file_proposal_delta"]` 且 `suggestedRelativePath == "notes/report.md"`）。

要点：
1. **每次模型调用新建拦截器**（`assist_service.py:102-105`）——`index` 每轮从 0 重编号；框架的扁平流要求适配器在 `metadata["langgraph_step"]` / model-update 边界重置实例，`on_chunk` 内部的 call_id 重置（`proposal_streamer.py:156-162`）只作兜底。
2. 转义 / `\uXXXX` 代理对 / 被拆开的 JSON 字符串全部由 `_extract_json_string` + `_decode_unicode_escape` 处理，**无需改动**。
3. 尾随空 chunk 会调用 `on_chunk` 但 `tool_call_chunks` 为空 → 零事件。
4. 三类帧必须与 `test_agent_baseline_contract.py:737-752` 逐字节相同（`file_proposal_start` 的 `summary=image_path=rel_path`、`detail="0"`、`mode` 仅 edit；`file_proposal_delta` 累积减已发；`file_edit_delta` 的 old/new 增量合并）。

---

## 5. `error` 帧：**建议不加**

理由：① 阶段 0 已把「无 `error` 帧」写进断言（`test_agent_baseline_contract.py:1285`，且 `:1252-1257`/`:1279-1285` 是**整表相等**，加帧直接红）；② `agent.py:147/500` 只有 `try/finally`，全仓唯一 `error` 生产者是 `annotation_quality.py:67`；③ 阶段 4 门槛是「客户端无需改动」，新帧类型即协议变更，超出本阶段；④ 计划 §5-阶段 4 要求保留的事件里没有 `error`。

代价：框架新增的失败模式（工具异常默认中止、`GraphRecursionError`、middleware/checkpointer 异常、interrupt 误用）会表现为**截断且无 `done`**，可诊断性不优于旧路径。

**不带协议变更的对冲**：把框架失败模式在带内转成旧等价信号 —— 工具异常 → 错误 `tool_result` 错误 JSON（`ToolErrorMiddleware` 等价物，`experiments/langchain_error_spike.py:17-34`）；预算耗尽 → 旧「无工具最终答复」（**不能**用 `ModelCallLimitMiddleware` 的固定文案）；recursion limit 调高。真正新增 `error` 应作为阶段 7 的显式提案，**新旧两侧同时加**并配套前端状态机。

---

## 6. 对照工具必须改造（实证缺陷）

`experiments/compare_agent_contract.py` 的覆盖面**极窄**，且有一条被忽略的事实（**已复核**）：

- 其脚本化模型 `MultiCallModel`（`experiments/langchain_multitool_spike.py:27-42`）**只实现 `_generate`，没有流式** → 该脚本**从未触达 messages 流**，只比较 `updates` 派生的工具帧。
- 断言对象是 `ToolLoopRunner.execute_round` 而非 `stream_assist`，也不经 HTTP 层。

**未覆盖**：(1) `text_delta`/`reasoning_delta`；(2) `tool_call_chunks` 分片（故四场景里 `file_proposal_*` 恒为零）；(3) SYNC 工具执行路径；(4) resume 第二个 HTTP 轮；(5) 取消；(6) 预算耗尽；(7) MCP 不可用；(8) `done` 与 `preparing(mcp)`；(9) 真实 provider 分片。

**强化要求**：让候选适配器成为生产模块并被 harness import（不再用 `_adapt_first_turn`）；新增**流式**脚本化模型（文本 + reasoning + 跨 chunk 拆分的 tool args）与用 `interrupt()` 实现的 ASYNC 工具；对照 `stream_assist` 而非 `execute_round`；两侧都过 `_stream_local_chat`；用阶段 0 十类样例参数化；**每次对照同时记录测试集指纹**（阶段 0 §1.1 的漂移事故教训）。

---

## 7. 风险与不可知（标 **inferred**）

- **inferred** 真实 provider（ChatOpenAI/DeepSeek）的 `tool_call_chunks` 分片粒度与 `index` 跨轮复用行为（阶段 0 §8-8 明确未验证）。
- **inferred** 适配器 `break` 后被弃置的框架流是否继续执行工具 —— 旧路径有轮内取消点（`assist_service.py:99/112/173/184`、`tool_loop.py:438/646`），框架无等价保证。**必须在 `finally` 中 `cancel()`/`aclose()` 该 astream task。**
- **inferred** 真实超时下 `get_tool_runner` 分区与框架 ToolNode 执行的并发时序是否等价。
- **已核实但极易踩**：若改用 `astream_events`，`data[0]` 会变成协议事件 dict，`isinstance(message, AIMessageChunk)` 全部为假 → **静默零事件**（不报错）。适配器只使用 `astream(stream_mode=["messages","updates"], version="v2")`。

---

## 8. 阶段 4 实施清单

> **集成决定（2026-09-23，阶段 2/4a 实测）**：第 6 项所需的**权威「本轮计划」不需要走 `custom` 帧**——`middleware.py:279` 的 `after_model` 返回值里已经带 `{"round_plan": plan}`，因此适配器从 `updates` 流（该节点更新）直接读取 `BusinessRoundState.round_plan`（含 `round_plan_message_id` 供幂等），并把 `end_after_round` / `round_executed` 作为回合终止的判据。`custom` 流模式仍按 §1 的「追加要求」保留，但只服务阶段 5 的子代理事件。任何 `custom` 计划帧只作提示，**不得**作为唯一来源。

| # | 实施项 | 证明用例 |
|---|--------|---------|
| 1 | 新建 `app/agent/langchain_runtime/sse_adapter.py`，公开 `async def stream_agent_events(agent, *, messages, config, client_context=None, task_phase_ctx=None) -> AsyncIterator[StreamEventPayload]`（不改 `stream_assist` / `stream_adapter.py`） | — |
| 2 | `_iter_parts()` 用 task 包装 `astream`，`finally` cancel + gather | `::TestCancelAbandonsFrameworkStream`（工具执行 0 次） |
| 3 | `_delta_events(chunk)` → 直接 `events_from_chunk(chunk, emit_tool_chunks=False)` | `::TestDeltaOrder`、`::TestTrailingEmptyChunk` |
| 4 | 按轮重建 `ProposalStreamInterceptor` | `::TestProposalAcrossRounds`（复用 `test_proposal_streamer.py` 的分片喂法） |
| 5 | `_resolve_round_calls(updates)` + `_tool_results(parts)`（双源去重） | `::TestRoundCallExtraction` |
| 6 | `_emit_round_tail(calls, results, interceptor, ctx)`：照抄 `tool_loop.py:499-620` 的同轮规则 + `emit_tool_pending` | `::TestSyncRound`、`::TestMixedSyncAsync`、`::TestCoalescedAndBlocked`（全量载荷断言） |
| 7 | 首帧 `preparing{streaming}`；**不发** `done` / `preparing(mcp)` | 直接复用 `tests/test_chat_stream_preparing.py`、`::TestMcpUnavailable`（不改一行） |
| 8 | `_framework_error_policy()`：不新增 `error` 帧 | `::TestFrameworkErrorEmitsNoErrorFrame`（部分帧、无 `done`、无 `error`） |
| 9 | 改造 `experiments/compare_agent_contract.py`（见 §6） | 十类样例参数化 + 指纹记录 |
| 10 | 双环境验收：`langchain-migration` / `langchain-baseline` 各 `python -m pytest -q`（基线 324 passed / 2 skipped），再跑 `python -m experiments.compare_agent_contract` | 门槛：逐事件一致；无重复、漏发或提早的 `tool_pending` |
