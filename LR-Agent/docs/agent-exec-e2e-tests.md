# Agent 执行能力端到端测试指南（Skill 脚本 + 终端命令）

本文档给出在真实应用中验证 Agent 执行能力的可复制测试用例。以 `docx` skill
（`~/.agents/skills/docx`）为载体，覆盖三条链路：**Skill 脚本执行**（SYNC）、
**受限终端命令**（ASYNC + 聊天内批准）、以及两者的组合。

自动化回归（不依赖 LLM）见 `src/main/skills/docxWorkflow.test.ts`
（夹具 skill：`src/main/skills/__fixtures__/docx-skill/`）。

## 前置条件

- 应用已启动，Agent 面板绑定了一个工作区（任意含测试文件的目录）。
- `~/.agents/skills/docx` 存在（本机已装）。
- 本机现状：应用 venv 缺 `defusedxml`/`python-docx`；PATH 上有 node/npm/pandoc。

## 场景 1：终端命令 + 批准条（依赖准备）

**提示词：**

```
帮我给应用自带的 Python 运行时安装 docx 处理依赖，执行：
"C:\Users\user\AppData\Roaming\lr-agent\runtimes\local-agent-venv\Scripts\python.exe" -m pip install defusedxml python-docx
装完告诉我结果。
```

**期望行为：**

1. 模型调用 `start_terminal_command`，命令卡片出现在聊天中，状态「等待批准」，
   参数区显示完整命令；
2. 用户点「批准执行」→ 卡片进入「进行中」，pip 下载进度**流式滚动**显示在输出区；
3. 进程退出后卡片状态「已完成（exit 0）」；
4. 模型 resume 后汇报安装结果。

**观察点：**

- 点「拒绝」路径：另发一条命令，点拒绝 → 模型应收到「用户拒绝执行该命令」并
  说明未执行，不会出现执行副作用。
- 危险命令路径：让模型跑 `rm -rf x` 或含 `|` 的命令 → 应直接被门禁拒绝
  （denied_command / shell_syntax_unsupported），连批准卡片都不出现。

**通过标准：** venv 里 `import docx`、`import defusedxml` 成功；批准前无任何
进程产生。

## 场景 2：创建 docx（Skill + 写文件 + 终端组合）

**提示词：**

```
用 docx skill 在工作区生成一份《LR-Agent 执行能力验证报告》.docx，
要求：一个一级标题、一段引言、一个两行两列的表格。生成后打开确认能读出内容。
```

**期望工具序列：**

1. `read_agent_skill(skill_name="docx")` 读 SKILL.md；
2. 创建路径走 docx-js：`write_workspace_file` 写生成脚本（如 `make_report.js`）；
3. `start_terminal_command`（**批准卡片**）执行 `npm install docx`（workspace 内
   本地安装即可，不需要 -g）；
4. `start_terminal_command`（**批准卡片**）执行 `node make_report.js`；
5. 读取校验：`start_terminal_command` 执行 `pandoc report.docx -t markdown`。

**通过标准：** 工作区出现 .docx；pandoc 能读出标题、引言与表格内容；
npm install / node 的实时输出都曾在卡片上流式显示。

## 场景 3：修改 docx（Skill 脚本执行为主）

**提示词：**

```
读取工作区里的《LR-Agent 执行能力验证报告》.docx，在文末追加一段
"修改记录：2026-09-13 由 Agent 追加"，保存为 report-v2.docx。
```

**期望工具序列：**

1. `read_agent_skill` + `list_agent_skill_files` 确认编辑路径；
2. `run_agent_skill_script(skill_name="docx", script="scripts/office/unpack.py", args=[...])`
   解包 docx —— 卡片标签显示「运行脚本 docx/scripts/office/unpack.py」；
3. 文件工具（read/str_replace/write）修改 `word/document.xml`；
4. `run_agent_skill_script` 执行 `scripts/office/pack.py` 重新打包；
5. `run_agent_skill_script` 执行 `scripts/office/validate.py` 校验。

**通过标准：** 全程**不出现**终端批准卡片（脚本执行走 SYNC 白名单，无需确认）；
report-v2.docx 存在且 pandoc 能读出追加段落。

**注意：** unpack/pack 只依赖标准库 + defusedxml（场景 1 已装）；涉及
LibreOffice 的脚本（soffice.py 转 PDF 等）本机没有 soffice，会失败——这属于
环境缺依赖，模型应报告错误而不是静默跳过。

## 场景 4：长任务与中止

**提示词：**

```
在工作区执行一个耗时任务：node -e "console.log('start'); setInterval(()=>{},1000)"
跑起来之后把它停掉。
```

**期望行为：**

1. 批准后命令持续运行（无退出），卡片保持「进行中」；
2. 模型调用 `kill_terminal_job(job_id=...)` 终止 → 输出区出现终态
   「已被终止（exit N/A）」；
3. 或者等 300s 默认超时 → 状态「超时被强制终止」。

**通过标准：** 任务结束后进程树上没有残留 node 进程（任务管理器确认）。

## 通用检查清单

- [ ] 所有终端命令执行前都出现过批准卡片，拒绝时无副作用
- [ ] `run_agent_skill_script` 只能执行 scripts/ 下的脚本（模型尝试 SKILL.md
      本身或 references/ 下的文件应得到 invalid_path）
- [ ] 输出超长时卡片与工具结果都有截断标记，不撑爆上下文
- [ ] 拒绝/门禁拒绝时模型收到结构化错误并如实向用户转述

---

## 附：同步工具不再阻塞事件循环（性能基线）

同步工具（grep / 读文件 / 图片编码等）统一经 `asyncio.to_thread` 在线程池执行，
目的是**不让一次大范围扫描卡住整个 FastAPI 进程**（同进程内其它会话的 SSE 流、
`/health` 健康检查、其它工具的调度都会受连带影响）。顺带让只读白名单里的多个
工具真正重叠执行（`_invoke_tool_fn`、`_invoke_inner` 两处同源逻辑都已改造）。

### 回归测试

`vendor/local-agent/tests/test_tool_blocking.py` 用「事件循环心跳计数器」量化：
起一个每 10ms 自增的 ticker 协程，再调用工具；若工具阻塞事件循环，ticker
在工具执行期间拿不到执行机会。

```bash
cd vendor/local-agent
python -m pytest tests/test_tool_blocking.py -v
```

### 一次性测量脚本

```bash
# 从仓库根执行；对比「直接调用」与「走线程池」两种模式
python vendor/local-agent/scripts/measure_grep_blocking.py <工作区根目录> "def\s+\w+"
```

### 实测数据（本机，中等规模仓库 ~50ms 级 grep）

| 场景 | 调用耗时 | 事件循环心跳 | 事件循环最大阻塞 |
| --- | --- | --- | --- |
| 改造前：同步工具直接调用 | 62.5 ms | **0 次** | 全程阻塞（采样器一次没跑到） |
| 改造后：经 `_invoke_tool_fn` 走线程池 | 59.8 ms | **3 次** | 11.9 ms |
| 桩工具 `time.sleep(0.3)`（改造前） | 300 ms | **0 次** | 全程阻塞 |
| 桩工具 `time.sleep(0.3)`（改造后） | 300 ms | **19 次** | 循环保持响应 |

**读法**：改造前「心跳 0 次」是关键信号 —— 采样器在整个工具执行期间一次都没
被调度到，说明事件循环被完全占住。改造后循环能正常心跳。

### 收益边界（避免误读）

- **主要收益是「不阻塞」而不是「更快」**。单轮对话的墙钟时间由 LLM 流式输出
  主导（秒级），一次 grep 是几十毫秒，端到端耗时的差异基本测不出来。
- **GIL 决定并发上限**：文件读取与目录遍历是真并行（系统调用释放 GIL）；
  而 `grep` 的逐行 `regex.search()` 不释放 GIL，所以上表里改造后仍有约 12ms
  的残余延迟 —— 这是「半并行」的真实体现，不是实现缺陷。
- 因此**不引入 `ProcessPoolExecutor`**：跨进程传路径配置、启动开销、结果回传的
  成本，对这个场景不划算。
- **视觉工具 `read_image_for_vision` 仍不进并行白名单**：它要往消息流里追加一条
  多模态消息（附图），并行会让附图与 `tool_calls` 顺序错位；它还有
  `vision_bootstrapped` 循环状态副作用。改造只让它「不卡」，不改变「不并行」。
