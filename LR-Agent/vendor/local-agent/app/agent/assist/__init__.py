"""Assist 模式流式推理子模块。

职责划分：
  - tool_loop        多轮 LLM ↔ 工具循环
  - vision_bootstrap 视觉兜底加载（首轮无 tool call 时触发）
  - proposal_streamer write_workspace_file chunk 流式拦截与 file_proposal SSE 生成
  - pending_emitter   异步工具 pending SSE 发送
  - task_phase        标注任务阶段状态机（提案门禁与阶段提示词）
  - explore_readonly  只读查阅子代理（嵌套短循环 + subagent_* SSE）
"""
