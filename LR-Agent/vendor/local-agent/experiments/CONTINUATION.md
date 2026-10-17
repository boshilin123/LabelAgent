# Agent 框架迁移验证续报（2026-09-23）

本文件更新 `README.md` 中的初次实验结论。**仍不切换生产 Agent 入口**；
所有新增验证都在后端，且未改现有依赖或标注数据。

## 已通过的验收点

- 新增 `tests/test_agent_migration_contract.py`：固定现有后端的
  `preparing → tool_start → tool_pending` SSE 载荷、下一次请求注入工具结果
  后的继续推理，以及取消后不发起客户端工具。两项测试通过。
- `python -m experiments.langchain_policy_spike`：复用现有
  `check_call_allowed`，用框架 middleware 拦截待确认提案时的文件写入，
  及确认后对已落盘路径的重复标注。两项场景通过。
- `python -m experiments.langchain_batch_spike`：用 `after_model`
  middleware 将同轮两次 `auto_annotate` 合并为一次、路径去重。通过。
- `python -m experiments.langchain_sse_spike`：将单个标注工具的框架暂停／
  恢复事件映射到当前后端 SSE 字段与顺序。通过。

先前实验仍可用 `python experiments/langchain_agent_spike.py` 和
`python experiments/langchain_parity_probe.py` 复现。后一实验表明：
**未加业务 middleware 的框架默认会执行两次相同范围的工具调用。**

完整的现有后端测试结果：`304 passed, 2 skipped, 1 warning`。

## 尚未满足生产切换条件

1. 现有“被合并调用”会产生 `coalesced` ToolMessage 与 SSE 反馈；框架合并
   实验只验证一次执行，没有等价复现这些反馈。
2. SSE 适配仅覆盖单个待执行标注工具。多工具同轮、文件提案的 token/chunk
   增量、只读子代理事件、错误／取消／超时序列尚未对照。
3. 实验使用内存 checkpointer；当前后端按请求重建消息，不依赖该内存状态。
   还需明确跨进程重启、持久化和幂等策略，不能把一次进程内 resume 视为等价。
4. 当前后端固定 `langchain-core==1.4.0`；本次框架实验的
   `langchain==1.4.2` 要求 `langchain-core>=1.6.3` 并引入 LangGraph。
   依赖升级与现有代码回归仍需单独验证。

后续应优先做新旧后端事件序列的参数化对照测试，并为多工具合并、
取消／重试、重启恢复设置明确验收。只有等价且维护成本下降，才替换主链路。
