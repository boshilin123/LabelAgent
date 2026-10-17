# LangChain Agent 后端迁移验证（2026-09-23）

> 2026-10-17 当前入口：默认引擎已是 candidate。本文以下为早期实验记录；日常回归使用 `python -m experiments.compare_agent_contract`。部署以根目录 `docs/本地部署方案.md` 为准。

后续验证已完成；请优先阅读 [最终后端验证结论](VERIFICATION-2026-09-23.md)。
下文保留首次实验记录。

结论：**暂不切换生产主链路**。实验只证明框架可以承接最小的
`auto_annotate → tool_pending → 外部结果 → 继续推理` 循环，尚未证明现有
业务约束和流式协议等价。

## 实验范围与复现

两个脚本均为隔离实验，不被应用导入，不调用 YOLO，也不修改标注数据。
使用独立临时环境中的 `langchain==1.4.2` 运行：

```text
python experiments/langchain_agent_spike.py
python experiments/langchain_parity_probe.py
```

- `langchain_agent_spike.py`：用脚本化模型发起一次 `auto_annotate`，在工具中
  `interrupt`，再用 `Command(resume=...)` 注入外部结果。结果：通过。
- `langchain_parity_probe.py`：验证框架能够产出流式 `updates`；同轮两次相同
  范围的工具调用默认执行两次。结果：流式能力通过，业务去重不等价。

## 与现有后端的差距

1. `auto_annotate` 当前是客户端工具 schema 存根。后端发送 `tool_pending` 并
   结束本轮 HTTP/SSE，请求恢复时注入工具结果；实验只验证了框架内部的
   interrupt/resume，没有验证既有 HTTP 请求、事件载荷和错误处理的兼容性。
2. 现有 `ToolLoopRunner` 会合并同轮多次 `auto_annotate`、按范围去重，且执行
   阶段门禁与“标注写入和工作区写入不可同轮”的约束。框架默认不会执行这些
   业务规则；迁移时仍需自定义 middleware 或图节点，并补测试。
3. 尚未对照提案 chunk 拦截、完整 SSE 事件序列、取消、轮数预算、视觉兜底、
   只读子代理，以及重启后的恢复。实验的 `InMemorySaver` 不提供生产级持久化。
4. 当前后端固定 `langchain-core==1.4.0`；实验采用的 `langchain==1.4.2`
   要求 `langchain-core>=1.6.3` 且引入 `langgraph`，因此不能只增加一个包名
   就无风险切换。

## 切换前的验收条件

- 为相同输入建立旧/新后端事件契约测试：`tool_start`、`tool_pending`、
  `tool_result`、文本和提案流事件的顺序与载荷保持兼容。
- 用真实后端入口覆盖暂停、跨请求恢复、取消、超时和重启恢复；验证工具
  只执行一次且用户确认前无标注写入。
- 将阶段门禁、同轮合并、同范围去重和调用预算移到可测试的扩展层，
  对照现有用例，并测量代码量及维护成本是否实际下降。
- 所有相关后端回归测试通过后，再评估替换生产入口和依赖升级。

本次现有后端定向回归测试：`97 passed, 1 failed`；失败项为协程工具心跳
计数 14/15 的计时测试，单独重跑 `1 passed`。实验未改生产路径。
