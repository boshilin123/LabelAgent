# 阶段 5 前置探针结果（S5-probe，2026-09-23）

脚本与原始输出（均在 `LR-Agent\vendor\local-agent\experiments\`）：

| 探针 | 脚本 | 原始输出 |
|------|------|----------|
| 1 `ToolRuntime.stream_writer` + `"custom"` | `probe_stage5_stream_writer.py` | `probe_stage5_stream_writer.out.txt` |
| 2 `after_model` 注入合成 AI + ToolMessage | `probe_stage5_after_model_vision.py` | `probe_stage5_after_model_vision.out.txt` |

环境：`.venvs\langchain-migration`，langchain 1.4.2 / langchain-core 1.6.4 / langgraph 1.2.12，工作目录 `LR-Agent\vendor\local-agent`。
两个脚本都是**假模型**（`ScriptedChat`，覆写 `bind_tools`/`_agenerate`/`_astream`），零网络、零真实 provider。

---

## 探针 1 结论

| # | 问题 | 结论 |
|---|------|------|
| 1a | 工具函数声明 `runtime: ToolRuntime` 并能调 `runtime.stream_writer(payload)`？ | **能**（`custom` 在 `stream_mode` 里时） |
| 1b | `"custom"` 缺席时 writer 是不是 no-op？ | **是**：被注入的是一个本地 `pass` 函数，调用不抛错、**零帧**（静默丢弃） |
| 2 | 分片形状 / `ns` / 到达顺序 | 形状 `{"type":"custom","ns":<tuple>,"data":<payload>}`；`ns` 恒为 `()`，**不标识工具作用域**；顺序 = `updates[model]` → `custom` → `messages`(ToolMessage) → `updates[tools]` |
| 3 | payload 是否原样 | **原样**（含嵌套 list / None / bool / float / 中文键值） |
| 4 | 与 `context_schema=AgentContext` + `build_business_middleware` 共存 | **共存**，工具仍恰好执行一次，`runtime.context` 是真 `AgentContext` |
| 5 | 工具在 `asyncio.to_thread` 里写帧 | **安全**（writer 走 `aioloop.call_soon_threadsafe`，`main.py:3285-3297`） |

源码支点：`langgraph/pregel/tool_node.py:841-851`（构造 `ToolRuntime(stream_writer=runtime.stream_writer…)`）、
`langgraph/prebuilt/tool_node.py:2020-2022`（`runtime` 形参识别）、
`langgraph/pregel/main.py:3283-3297`（`"custom" in stream_modes` → 真 writer）、
`langgraph/pregel/main.py:3300-3303`（否则 `def stream_writer(c): pass`）、
`langgraph/pregel/main.py:4234-4235`（v2 事件 `{"type","ns","data"}`）。

**原始分片（探针 1 A 组，逐字）**：

```
  3  custom    ns=() data={'marker': 'A', 'seq': 1, 'payload': {'kind': 'subagent_text_delta', 'text': '中文 payload ✓', 'nested': [1, 2, [3, [4, {'deep': None}]], True, False], 'none': None, 'float': 1.5, 'unicode_key_中文': {'a': [1, 2, 3]}}}
  4  custom    ns=() data={'marker': 'A', 'seq': 2, 'flat': 'second frame'}
  5  messages  ns=() node=tools cls=ToolMessage content='{"ok": true, "marker": "A"}'
  6  updates   ns=() nodes=['tools'] data={'tools': {'messages': [ToolMessage(...)]}}
```

**对阶段 5 的含义**

1. `stream_mode` 必须包含 `"custom"`，否则子代理事件**静默消失**（无异常、无帧）——适配器侧无法自检，必须在阶段 4 适配器里对模式清单做断言。
2. `ns` 恒为 `()`，**与 `messages`/`updates` 的 ns 完全相同**（备忘第 10 行「`ns` 标识工具作用域」不成立）。适配器**只能靠 payload 字段与到达顺序**判定来源，不能靠 `ns`。
3. 自定义帧在 `updates[model]` 之后、`tools` 的 `ToolMessage`/`updates[tools]` 之前到达 → 「`tool_start` → `tool_result`」可以按到达顺序原样输出（备忘 §3 要求）。
4. 若 `ToolRuntime` 注入最终不可用，退路（`wrap_tool_call` 里写 `request.runtime.stream_writer`）**不需要**——注入可用，无需退路。但保留 `Runtime.context` sink 作为并发隔离手段仍有意义（见下）。

**UNRESOLVED**：`ns` 在**嵌套子图**内是否非空（未测；阶段 5 已确定不用嵌套 `create_agent`，故不影响）。

---

## 探针 2 结论

| # | 问题 | 结论 |
|---|------|------|
| 1 | 是否真的产生第二次模型调用？ | **是**，恰好 +1 次；**不进 `tools` 节点** |
| 2 | 能工作的精确形状 | `[AIMessage(content="", tool_calls=[{"name":…,"args":{…},"id":FAKE,"type":"tool_call"}]), ToolMessage(content=display, tool_call_id=FAKE, name=…)]`，**AI 在前、ToolMessage 在后，id 必须一致** |
| 3 | 第二调用仍无 tool call 时会不会死循环？ | **会**（`GraphRecursionError`）；必须有 state 守卫 |
| 4 | 与 `build_business_middleware` 的相互作用 | **无冲突**：`BusinessRoundMiddleware.after_model` 返回 `None`，不把它当计划；两种排序都安全 |
| 5 | SSE `updates` 如何区分合成视觉轮 | 出现 `updates["<VisionMiddleware>.after_model"]`（含 `messages` + `vision_attempted`）且**没有** `updates["tools"]` |

源码支点：`langchain/agents/factory.py:1950-1957`（`tool_message_ids` 过滤）、`:1970-1972`（回跳 model）、
`:1703-1718`（`model_to_tools` 目的地含 `loop_entry_node`）、`:1789-1800`（after_model 节点链，列表末位先执行）。

### Q2 六种形态实测

| shape | model_calls | `tools` 节点 | 说明 |
|-------|-------------|--------------|------|
| `ai_then_tool`（AI 带 tool_call + id 匹配的 ToolMessage） | 2 | **无** | ✅ 唯一正确形态 |
| `tool_then_ai`（顺序颠倒） | 2 | **有** | ❌ 伪调用被 `Send` 给 `tools`，产生 `Error: read_image_for_vision is not a valid tool` 的 `ToolMessage(status="error")` |
| `wrong_id`（ToolMessage id 不匹配） | 2 | **有** | ❌ 同上 |
| `ai_only`（只注合成 AI，无 ToolMessage） | 2 | **有** | ❌ 同上 |
| `only_tool`（只注 ToolMessage） | **1** | 无 | ❌ 不回跳（最后一条 AI 仍是无调用那条 → END） |
| `status_error` / `no_name` | 2 | 无 | ✅ `ToolMessage.status` 与 `name` **不参与**判定，只有 `tool_call_id` 参与 |

### Q3 终止性

- 有 state 守卫（`vision_attempted`）→ 2 次模型调用后正常结束。
- 无守卫 → `recursion_limit=12` 时报 `GraphRecursionError`，已跑 6 次模型调用 = **确认会无限循环**。

### Q4 与阶段 2 栈的相互作用（最高价值）

`updates` 观测（`extra` 位置，即 vision 在中间件列表末位 → `after_model` **最先**执行）：

```
  5  updates   nodes=['model']
  6  custom    data={'type': 'tool_start', ...}
  7  custom    data={'type': 'tool_result', ...}
  8  messages  node=VisionFallbackProbe.after_model cls=AIMessage content=''
  9  messages  node=VisionFallbackProbe.after_model cls=ToolMessage tcid=lr-vision-fallback-1
 10  updates   nodes=['VisionFallbackProbe.after_model'] data={'…': {'messages': [AIMessage(…tool_calls=[{…,'id':'lr-vision-fallback-1'}…]), ToolMessage(…tool_call_id='lr-vision-fallback-1')], 'vision_attempted': True}}
 11  updates   nodes=['ModelCallLimitMiddleware.after_model'] data={'…': {'thread_model_call_count': 1, 'run_model_call_count': 1}}
 12  updates   nodes=['BusinessRoundMiddleware.after_model'] data={'…': None}      ← 无计划、无 jump
 13-15 updates  nodes=['BusinessRoundMiddleware.before_model'|'ModelCallLimitMiddleware.before_model'|'BudgetWrapUpMiddleware.before_model']
 16-18 messages/updates  node=model        ← 第二次模型调用
 19  updates   nodes=['VisionFallbackProbe.after_model'] data={'…': None}          ← 守卫拦住，不再触发
```

- `BusinessRoundMiddleware.after_model` 实测**看不到**合成调用：`extra` 排序下它看到的是注入的 `ToolMessage`（`plan_round` 对非 `AIMessage` 返回空计划，`round_plan.py:249-255`）；`stack_first` 排序下它看到的是真实的无调用 `AIMessage`（同样空计划）。**两种排序都返回 `None`，不合批、不门禁、不注入、不 jump。**
- 结构上二者互斥：兜底只在「本轮 `tool_calls` 为空」时触发，而 `BusinessRoundMiddleware` 只在有调用时出计划。
- **`jump_to="model"` 不必要**（实测未加时 2 次调用 + 无 `tools` 节点；显式加也正常，但 `VisionFallback` 若不带 `@hook_config`，`jump_to` 会被静默忽略）。
- **不变量**：vision middleware 必须放在 `build_business_middleware(..., extra=[...])` 里（列表末位），这样 `BusinessRoundMiddleware.after_model` 仍是 `loop_exit_node` 并保留 `jump_to` 控制权（`factory.py:1789-1800`）。

### Q7 预算交互（备忘风险 4）

`BudgetWrapUpMiddleware.before_model` 与 `ModelCallLimitMiddleware` **把兜底那次调用照常计数**：

- `max_tool_rounds=0`（`wrap_up_at=2`）+ 兜底触发 → call#2 的输入末尾**多出一条** `HumanMessage("工具调用预算已用完。请基于以上进展直接给出最终回答，不要再调用工具。")`。模型调用总数仍是 2（与「第一轮就调真实工具」的基线 Q7b 相同），即兜底**占用**了收尾轮而不是新增一轮。
- `max_tool_rounds=1`（`wrap_up_at=3`）→ 无收尾消息，不受影响。

### 新发现的守卫 bug（备忘未列）

朴素实现（只在**真正触发**时置 `vision_attempted`）在「**第一轮调了真实工具、第二轮无调用**」时会**误触发**兜底：实测 `model_calls=3`、多出 2 条 custom 帧。旧路径语义是「**第一轮**无 tool call」（`assist_service.py:158-167`）。
修正做法：`after_model` **每次都无条件落盘轮次计数**，只在 `round == 1` 时触发。实测修正后 `model_calls=2`、`tools` 节点照常、零 custom 帧。
注意：我第一版修正代码把计数写在「触发分支」里，第一轮有工具时 `return None` 导致计数丢失，第二轮又被当成首轮（`model_calls=3`）——**计数必须无条件落盘**。

---

## 备忘未列的新风险

1. **合成 `AIMessage` 会被回放到 `messages` 流**：`langgraph/pregel/_messages.py:106-120`（v1 handler，直接 `astream` 用的就是它）在 `on_chain_end` 里把**节点输出里的 `BaseMessage`** 也发到 messages 流；v2 handler（`:307-334`）只跳过 `ToolMessage`，**仍然会发** `AIMessage`。实测 `messages` 事件 `node=VisionFallbackProbe.after_model cls=AIMessage content=''`。阶段 4/5 适配器若把 `messages` 里的 AI 消息一律映射为 `text_delta`，会多出**一条空 delta**；v1 下合成 `ToolMessage` 也会泄漏（可能造成重复 `tool_result`）。需要按 `langgraph_node` 后缀 `.after_model` 或按 `content == ""` 过滤。
2. **`ns` 不能用于来源判定**（见探针 1）。
3. **`"custom"` 缺席是静默失败**（无异常、无帧），必须在适配器里断言模式清单。
4. **轮次守卫必须无条件落盘**（见上）。
5. `ToolRuntime` 形参的 `ModelRequest`/序列化告警是外观性的（`ProbeContext`/`AgentContext` 均出现 `PydanticSerializationUnexpectedValue(field_name='context')`），工具行为正常，不要据此判失败；`tool.get_input_schema().model_json_schema()` 会直接抛 `PydanticInvalidForJsonSchema`，但 `convert_to_openai_tool` 走的是 `tool_call_schema`（已实测输出正确、不含 `runtime`），真实 `ChatOpenAI.bind_tools` 不受影响。
