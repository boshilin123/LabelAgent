# LR-Agent 的 LangSmith Studio 本地调试

Studio 的 Graph 页面是 LangSmith 提供的界面，连接本机的 LangGraph Agent Server；它不是桌面应用的内嵌页面，也不是 Tracing 项目的详情页。本项目用 `studio_graph.py` 复用现有 `build_engine_agent`，因此显示真实的 `model`、`tools` 和 middleware 节点，而非手绘示意图。

## 首次准备

在 PowerShell 中执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\Study\LR-Agent\scripts\setup-lr-agent-studio.ps1
```

这会在 `.venvs\langchain-studio` 安装独立 Python 环境和官方 `langgraph-cli[inmem]`，不修改桌面应用使用的 `.venvs\langchain-main`。现有 LangSmith Key 从被 Git 忽略的 `.venvs\.runtime\langsmith-api-key.txt` 加载，不要把密钥写入仓库。

## 启动与进入页面

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\Study\LR-Agent\scripts\start-lr-agent-studio.ps1
```

保持该窗口运行。CLI 会尝试自动打开浏览器；若没有打开，手动访问：

<https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2025>

登录与 LangSmith Key 对应的账号，选择 `lr_agent_ask`，切换到 **Graph**。Agent Server 只监听本机 `127.0.0.1:2025`；`Ctrl+C` 停止。已存在的另一个项目占用 `2024`，LR-Agent 因此使用独立端口 `2025`，并在该端口被占用时拒绝启动，以免连接到其他项目。桌面应用仍用原来的 `start-lr-agent.ps1`，两个服务可独立启动。

## 可选：启用 Studio 内的模型交互

没有单独模型凭据时，Studio 仍能展示图，但模型地址固定为本机无服务的 `127.0.0.1:9`，不能执行真实对话。要交互调试，在被 Git 忽略的 `.venvs\.runtime\studio-model.env` 中填写以下四项，重新启动 Studio：

```text
LR_AGENT_STUDIO_MODEL=你在桌面应用使用的模型名
LR_AGENT_STUDIO_BASE_URL=对应的 OpenAI 兼容 API 地址
LR_AGENT_STUDIO_MODEL_API_KEY=该模型的 API Key
LR_AGENT_STUDIO_WORKSPACE_ROOT=D:\Study\LR-Agent\demo\bottlecap
```

`LR_AGENT_STUDIO_WORKSPACE_ROOT` 可省略；省略时默认读取本仓库根目录。脚本只解析上面四个变量，不执行文件中的 PowerShell 代码。请仅用测试数据调试：启用 LangSmith tracing 后，模型输入和工具输出可能上传到 LangSmith。Studio 轨迹位于独立项目 `lr-agent-studio`。

## 当前边界

- Studio 暴露的是**现有只读 Ask 模式图**，复用真实装配函数与业务 middleware。它不会执行 `auto_annotate`、`mutate_annotation` 或工作区写入；桌面端的客户端确认与跨请求续跑也不在 Studio 中模拟。
- 当前项目用 `create_agent` 生成图，没有自定义的 `understand_query`、`retrieve` 等节点；Studio 不会显示截图中其他项目的节点。
- 现有图没有 checkpointer，因此 Studio 的持久化记忆、恢复和 time-travel 能力不代表桌面端已实现。
- 若要在 Studio 中完整调试自动标注闭环，需要另行设计客户端工具代理、授权边界与状态持久化，不能直接把写入工具暴露在调试服务中。

官方参考：[LangSmith Studio](https://docs.langchain.com/langsmith/studio) · [本地 Agent Server](https://docs.langchain.com/langsmith/local-dev-testing)
