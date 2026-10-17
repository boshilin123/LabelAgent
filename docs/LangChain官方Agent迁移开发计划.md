# LR-Agent 后端迁移至官方 LangChain Agent：开发与验收计划

> 文档日期：2026-09-23
> 执行目录：D:\Study\LR-Agent-LangChain-Migration
> 原项目目录：D:\Study\LR-Agent
> 状态：计划与基线；**尚未切换生产 Agent 主链路，也未完成最终验收**。

## 0. 先读结论与边界

本次目标是把本机 Agent 服务中手写的「模型 → 工具 → 模型」Tool-Use Loop，迁移到官方 LangChain 的 create_agent；让框架负责通用循环，而标注提案、权限、批处理、事件协议等项目业务规则保留为可测试的自定义 middleware 或独立适配层。只有在新旧后端行为完成对照后，才允许切换默认入口。

本次只改后端 Agent 编排，不改前端，不改 YOLO 模型及推理算法，不替换 BAMS/现有部署中的任何模块。不以引入 LangGraph 手写图作为目的；create_agent 底层已经使用 LangGraph。若某段流程确实需要显式节点、条件边或特殊人工介入，再做局部 StateGraph，而不是把整个项目重写为图。

当前会话历史、本地长期记忆、存储方案不在此次迁移验收范围。但标注提案的单次任务阶段、用户确认前后门禁、工具结果继续推理，仍是必须保持的业务契约；不能因为「不做记忆」而删掉。

### 0.1 开发原则

1. **只在副本开发。** 原目录作为可运行基线和回滚参考；现有容器不得停止、重建、覆盖镜像或共用新副本的数据卷。
2. **先固定契约再迁移。** 每一步都记录输入、事件输出、工具执行次数和测试结果。
3. **一次只改变一个轴。** 框架迁移与模型提供商切换分开验证；DeepSeek API 可用于辅助编码，也可另行作为运行时测试模型，二者不是同一个任务。
4. **禁止用简历术语替代验收。** 只有生产主链路实际采用 create_agent，且业务测试通过后，才能在简历写「基于 LangChain Agent/Middleware 实现」。
5. **不杜撰指标。** 性能、成功率、学校使用情况等均以真实日志或可复现测试为准。

## 1. 已完成的隔离准备

已从 D:\Study\LR-Agent 复制出 D:\Study\LR-Agent-LangChain-Migration。复制包含源码、Git 历史、测试、已有实验、文档、demo 与 weights；没有复制 .venvs、node_modules、release、缓存、.dsh-project-memory、.cursor 和 .env 文件。这样既保留项目基线，又避免复制密钥和大体量生成物。副本中的 .env.example 已恢复。

> **阶段 0 已执行（2026-09-23）**：副本 baseline 环境实测 `306 passed, 2 skipped`（新增 18 个旧路径契约测试后为 `324 passed, 2 skipped`）；并在**同一测试集指纹**下完成单变量对照——core 1.4.0 与 core 1.6.4（+langgraph 1.2.12）均为 `324 passed, 2 skipped`，即 core 升级对旧路径零回归。四个容器经 `docker ps` 核对为 `Up 2 days`、未重建。详见 `docs/阶段0-验收记录.md`。

原环境目前能看到四个运行中的容器：lr-agent-api、lr-agent-redis、lr-agent-postgres、lr-agent-minio。它们属于原环境，**副本迁移无需启动它们的第二套 Compose**。现有 Compose 固定容器名、宿主机端口和数据卷；若以后确需启动第二套，必须先改独立项目名、容器名、端口、网络和卷，并做配置检查，不得直接在副本执行 docker compose up。

本地 Agent 服务位于：

~~~text
D:\Study\LR-Agent-LangChain-Migration\LR-Agent\vendor\local-agent
~~~

云端 LR-Agent-backend 主要承接用户认证与资料服务；本次核心工作不在那里。本地 YOLO 推理位于 LR-Agent\vendor\inference；本次仅验收其工具调用边界，不改模型。

### 1.1 副本核对命令

在 PowerShell 中执行：

~~~powershell
$MigrationRoot = 'D:\Study\LR-Agent-LangChain-Migration'
$OriginalRoot = 'D:\Study\LR-Agent'
Test-Path -LiteralPath $MigrationRoot
Test-Path -LiteralPath (Join-Path $MigrationRoot 'LR-Agent\vendor\local-agent\app\agent\assist_service.py')
Test-Path -LiteralPath (Join-Path $MigrationRoot 'LR-Agent\vendor\local-agent\experiments\VERIFICATION-2026-09-23.md')
git -C $MigrationRoot status --short
docker ps --format '{{.Names}} {{.Status}}'
~~~

预期：前三个检查返回 True；Git 能正常读取历史；原四个容器仍运行。副本 Git 工作树中可能有从原项目带来的未跟踪实验与文档，不要直接清理。首次开始开发前记录提交 SHA、Git 状态和 Python 版本。

## 2. 现状：要替换的是哪一层

### 2.1 当前依赖和入口

- Python 3.12；本地 Agent 依赖见 LR-Agent\vendor\local-agent\requirements.txt。
- 当前固定 langchain-core==1.4.0、langchain-openai==1.2.2、langchain-mcp-adapters==0.3.0；没有把 langchain 主包和 langgraph 作为生产依赖。
- FastAPI 路由为 app\api\v1\agent.py 中的 POST /api/v1/agent/chat/stream；它组装模型、工具、上下文并调用 app\agent\assist_service.py 的 stream_assist。
- stream_assist 手动调用模型 astream、累积模型分片、逐轮解析工具、处理取消和工具预算；app\agent\assist\tool_loop.py 执行工具策略。
- MCP 工具由 app\agent\tools\mcp_client.py 发现和过滤；客户端工具结果由后续请求带回；提案增量由 app\agent\assist\proposal_streamer.py 转换为 SSE。
- 只读探索子 Agent 在 app\agent\assist\explore_readonly.py；任务阶段门禁在 app\agent\assist\task_phase.py；视觉兜底在 app\agent\assist\vision_bootstrap.py。

### 2.2 当前已验证到哪里

现有 experiments\VERIFICATION-2026-09-23.md 记录：隔离实验已证明 create_agent 可承接最小工具循环，并在**四类脚本化场景**中与旧后端逐事件 SSE 对照一致：同范围重复调用、不同范围合批、标注与报告同轮、all_files/write_mode 合并。两个隔离依赖环境各运行过完整本地 Agent 测试，结果均为 306 passed、2 skipped、1 warning。这不是新生产入口验收，也没有调用真实模型、真实 YOLO 或前端运行时。

> **覆盖面更正（2026-09-23 实测复核）**：上述「逐事件 SSE 对照」的实际范围比字面更窄——`experiments/compare_agent_contract.py` 使用的脚本化模型 `MultiCallModel`（`experiments/langchain_multitool_spike.py:27-42`）**只实现 `_generate`、没有流式**，因此该脚本**从未触达 messages 流**，只比较由 `updates` 派生的工具帧；断言对象是 `ToolLoopRunner.execute_round`，不是 `stream_assist`，也不经 HTTP/SSE 层。因此文本增量、reasoning、`tool_call_chunks` 分片（故四场景中提案类事件恒为零）、SYNC 工具执行路径、resume 第二轮、取消、预算耗尽、MCP 不可用、`done` 与 `preparing(mcp)` **均未被覆盖**。阶段 4 必须先把该 harness 按 `docs/阶段4-SSE适配设计备忘.md` §6 强化，再谈"逐事件一致"。

已知不等价：

- 框架默认会执行同范围重复工具调用；需项目策略阻止。
- 框架默认工具异常可能中断执行；需明确错误消息、可重试与不可重试分类。
- 内置 ModelCallLimitMiddleware 可限制循环，却不会自动生成现有的「停止调用工具后的最终答复」。
- LangGraph interrupt 恢复时可能重新执行被暂停的函数体；**interrupt 前不能产生副作用**，执行侧需幂等或去重。
- 现有脚本对照覆盖面不足以证明真实流式工具分片、MCP、只读子 Agent、视觉兜底、超时与并发等价。

## 3. 目标架构和非目标

目标调用链：

~~~text
FastAPI /chat/stream
  ├─ 请求与任务阶段解析（保持现有业务输入）
  ├─ 模型 + 工具注册（本地工具、MCP、受限子 Agent）
  ├─ LangChain create_agent（官方模型—工具循环）
  │    ├─ 模型调用 / 工具执行
  │    ├─ 项目自定义 middleware：阶段门禁、合批去重、同轮写入策略
  │    └─ 选择性内置 middleware：工具错误、重试、调用预算
  └─ 事件适配层：LangChain 流事件 → 现有 StreamEventPayload/SSE
       └─ 标注提案、tool_pending、tool_result、文本与 reasoning
~~~

模型层继续由当前配置/依赖注入决定，不把 DeepSeek 写死在业务逻辑里。用户用 DeepSeek API 辅助迁移代码时，无需因此修改项目运行时模型。若另将 DeepSeek 用作真实联调模型，须独立通过模型契约测试。

不在范围：前端重构、数据库迁移、长期 Store、会话 Checkpointer 选型、LangSmith 云部署、YOLO/SAM 算法替换、云端认证服务改造。原有客户端工具结果跨请求返回属于既有业务协议，迁移时须保持最小可用，但不在此阶段重设计其持久化方式。

## 4. 环境与依赖准备

### 4.1 Windows 开发环境

建议在副本根目录的 **.venvs** 中建两个独立虚拟环境（该目录已被 Git 忽略）：baseline 跑当前依赖；migration 跑候选官方框架。不要在原项目 .venvs 中升级，也不要在 local-agent 下新建未忽略的 .venv。PowerShell 示例：

~~~powershell
$AgentDir = 'D:\Study\LR-Agent-LangChain-Migration\LR-Agent\vendor\local-agent'
$BaselinePython = 'D:\Study\LR-Agent-LangChain-Migration\.venvs\langchain-baseline\Scripts\python.exe'
Set-Location -LiteralPath $AgentDir
py -3.12 -m venv 'D:\Study\LR-Agent-LangChain-Migration\.venvs\langchain-baseline'
& $BaselinePython -m pip install --upgrade pip
& $BaselinePython -m pip install -r requirements.txt
& $BaselinePython -m pip check
& $BaselinePython -m pytest -q
~~~

若系统没有 py 启动器，用实际 Python 3.12 可执行文件替代 py -3.12。当前电脑上 python --version 曾返回 Python 3.12.0，但仍应在副本内重查。依赖下载需网络，失败时记录包名和错误，不通过修改原目录解决。

第二套环境：

~~~powershell
Set-Location -LiteralPath 'D:\Study\LR-Agent-LangChain-Migration\LR-Agent\vendor\local-agent'
$MigrationPython = 'D:\Study\LR-Agent-LangChain-Migration\.venvs\langchain-migration\Scripts\python.exe'
py -3.12 -m venv 'D:\Study\LR-Agent-LangChain-Migration\.venvs\langchain-migration'
& $MigrationPython -m pip install --upgrade pip
& $MigrationPython -m pip install -r requirements.txt
& $MigrationPython -m pip install 'langchain==1.4.2'
& $MigrationPython -m pip check
& $MigrationPython -m pytest -q
& $MigrationPython -m pip freeze
~~~

1.4.2 是此前隔离实验用过的候选版本，**不是最终生产锁版**。**实测（2026-09-23，阶段 0）**：`langchain==1.4.2` 硬约束 `langchain-core>=1.6.3,<2` 与 `langgraph>=1.2.11,<1.3`；本机解析结果为 **`langchain-core==1.6.4` + `langgraph==1.2.12`**（另引入 `langgraph-checkpoint 4.2.0` / `langgraph-prebuilt 1.1.0` / `langgraph-sdk 0.4.5` / `ormsgpack 1.12.2`，并把 `websockets` 从 17.1 降到 16.1.1）。`langchain-openai==1.2.2` 与 `langchain-mcp-adapters==0.3.0` 的现有 pin 保持不变即可满足（两者声明的 core 区间分别为 `>=1.4.0,<2` 与 `>=1.0.0,<2`），两个环境 `pip check` 均通过。

两条命令的解析边界必须注意：先 `pip install -r requirements.txt`、再单独 `pip install langchain==1.4.2`（即本节写法）**可以跑通**，第二步会把 core 升到 1.6.4；但若把两者写成**同一条** pip 命令，pip 会因 `requirements.txt` 中 `langchain-core==1.4.0` 的硬 pin 直接报 `ResolutionImpossible`。因此**切换依赖时必须同步修改 `requirements.txt` 的 core pin**，否则照文件从零建环境必然失败。运行全部测试并记录解析后的版本；确认可用后，再专门提交 requirements 的版本变更。不要把两个虚拟环境的 freeze 混成一个 requirements。

如果选择官方 ChatDeepSeek 作为**运行时**模型，再在 migration 环境单独安装 langchain-deepseek 并做兼容测试；若只用 DeepSeek API 作为编码助手，则本项目不需要新增此包。优先保持现有 ChatOpenAI 模型注入接口不变，先让框架迁移收敛。

### 4.2 DeepSeek API 的两种用途

**用途 A：迁移开发助手。** 由你使用 DeepSeek API 阅读本计划、分析代码、按阶段生成补丁。每次只授权它处理一个阶段；提交前人工复核 diff、运行对应测试。不要给它生产服务器密钥、真实用户数据或原项目 .env。

**用途 B：项目真实联调模型（可选）。** 通过本地环境变量注入 DEEPSEEK_API_KEY，不把密钥写入仓库、文档、测试快照或命令行历史。先以一个无副作用的临时工具验证模型标识、工具调用、异步调用、流式 tool_call chunks、reasoning 字段、错误码和停止条件；通过后再连接标注业务。模型名称以 DeepSeek 账户可用型号和当时官方文档为准，不能仅照抄课程 PDF 的示例型号。若模型不支持项目所需视觉输入，保留现有视觉模型或兜底，不让文本模型承担未验证的识图任务。

可以用当前 PowerShell 会话安全注入（执行时交互输入，不打印密钥）：

~~~powershell
$SecureKey = Read-Host 'DeepSeek API key' -AsSecureString
$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
try { $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr) }
~~~

退出该终端后密钥不再由此会话提供。模型联调应使用测试数据和可接受的调用预算；禁止将真实项目图像、标注文件或用户信息未经授权上传给外部模型。先检查官方 API 文档是否支持当前选用模型的 tool calling 和 streaming，再编码适配。

### 4.3 服务与容器隔离

local-agent 测试无需 PostgreSQL、Redis、MinIO。最初阶段只跑 pytest 和隔离 FastAPI 测试客户端；不启动新 Docker Compose。若要手动启动副本 local-agent，需先确认原服务是否占用 8765，并给副本设置独立端口，例如在**当前终端**执行：

~~~powershell
$env:LR_AGENT_LOCAL_PORT = '18765'
& 'D:\Study\LR-Agent-LangChain-Migration\.venvs\langchain-migration\Scripts\python.exe' local_main.py
~~~

不要同时让原 Electron 客户端自动连接这个实验端口；先用 http://127.0.0.1:18765/health 和测试脚本检查。API Key 的请求方式沿用已有接口，但仅使用测试密钥。不得把副本 FastAPI 暴露在 0.0.0.0。

## 5. 迁移步骤：每步行动、结果与通过门槛

每一步都先读相关生产代码和现有测试，在副本单独开发；每步完成后记录 Git diff、测试命令、通过数和遗留问题。任何阶段失败，保留旧入口并修复当前阶段，勿带着失败继续切换。

### 阶段 0：冻结现有后端契约

**行动**

1. 记录副本 Git SHA/状态、依赖版本、现有运行容器状态；确认本地 Agent 全量 pytest 的真实结果。
2. 审核 tests/test_agent_migration_contract.py、tests/test_agent_migration_multitool_contract.py 与 experiments/compare_agent_contract.py；保留原有样例与事件快照。
3. 扩充旧路径的测试样例：空工具调用、单工具、多个工具、提案确认、拒绝、工具错误、预算耗尽、取消、只读工具、MCP 不可用。每个样例记录「工具实际执行次数」和 SSE 顺序。

**预期结果**：有一份可复现的旧路径行为基线。**通过门槛**：原有测试在副本 baseline 环境通过；新增样例先对旧路径稳定通过。不把实验报告中的 306 passed 直接当作本次运行结果。

### 阶段 1：建立官方 Agent 候选内核，不接生产路由

**行动**

1. 增加一个后端专用候选模块（建议 app/agent/langchain_runtime/），封装 create_agent 的构建与 astream/ainvoke；不要直接编辑或删除 stream_assist。
2. 从现有工具清单构建 Agent；保留模型实例的注入接口和统一工具 schema。
3. 将模式、项目快照、权限/任务阶段等**一次调用内的静态信息**放在运行上下文；工具运行进展放在任务状态或适配层，不引入长期 Store。
4. 为纯文本回答、只读工具、一个异步工具写最小测试，确认消息和工具调用 ID 对齐。

**预期结果**：候选 create_agent 可作为后端函数独立调用，旧路由完全不变。**通过门槛**：无网络的脚本化模型测试稳定通过；不出现重复执行或隐藏副作用。

### 阶段 2：迁移业务 middleware

**行动**

1. 阶段门禁：**只复用 `check_call_allowed`，在执行层做唯一强制门禁**。阶段 0 基线已实测：旧路径刻意保持 `bind_tools` 的工具列表稳定（按名排序，命中 system prompt 前缀缓存，`app/api/v1/agent.py:429-436`），只读轮次中写工具**仍在**绑定列表里（`tests/test_agent_baseline_contract.py::TestReadOnlyTools`）。候选路径**不得**在模型调用前增删工具，否则同时违反阶段 0 基线与本阶段「与阶段 0 一致」的通过门槛。`task_phase.blocked_tool_names()` 在生产代码中从未被调用（引用仅在 `tests/test_task_phase.py`），本阶段将其显式标记为**废弃**，不纳入候选实现。
2. 同轮决策：在执行工具前合并多个 auto_annotate 的 paths/all_files/write_mode；同范围重复只执行一次；标注写入和报告/工作区写入同轮时按原规则拦截。返回给模型的每个 tool_call_id 必须都有明确结果，不能无声丢弃。
3. 工具异常：可先试官方 ToolErrorMiddleware；仅给模型可解释、脱敏后的错误。网络暂时故障可以对**明确允许重试的只读工具**使用 ToolRetryMiddleware；标注写入默认不自动重试。
4. 预算收尾：ModelCallLimitMiddleware 仅作为硬上限；另实现与旧路径一致的「无工具最终答复」策略，并测试刚好达到上限、超限、取消中断三种情况。
5. 记录 middleware 顺序及影响。若某项需要跨本轮全部工具调用做统一决策，先在 after_model 整理，再逐个 wrap_tool_call 做最后门禁。

**预期结果**：候选 Agent 满足标注业务规则，不靠提示词兜底。**通过门槛**：阶段 0 的相关样例在候选路径中工具次数、阻断理由和事件顺序一致；非法写入实测执行次数为零。

### 阶段 3：标注提案和客户端工具继续执行

**行动**

1. 保持 auto_annotate、mutate_annotation 等现有客户端工具语义：后端发 tool_pending，用户确认/客户端执行后，后续请求返回 tool result，Agent 继续推理。
2. 对比「使用框架 interrupt/resume」和「显式适配现有跨请求工具结果」两种方案的复杂度。选择能保留现有 HTTP/SSE 合约且无需重设计存储的最小方案。
3. 如果使用 interrupt，函数体在 interrupt 之前只能构造纯数据，不读写文件、不提交任务；恢复后执行侧使用稳定的业务幂等键。测试重复恢复、不同 tool_call_id、拒绝和异常输入。
4. 提案在用户确认前不得写盘；确认后不能因恢复重放再次写盘。

**预期结果**：保持原客户端协议，无需前端修改。**通过门槛**：一条完整的「生成提案 → pending → 用户确认 → 结果回传 → 最终回答」后端测试通过；重复请求不会产生第二次副作用。

### 阶段 4：流式事件适配

**行动**

1. 用官方 Agent 的 messages/updates/custom 等流事件建立单独适配器，转换为现有 StreamEventPayload，不把 LangChain 内部对象直接输出到 SSE。
2. 保留 preparing、text_delta、reasoning_delta、tool_start、tool_result、tool_pending、file_proposal_start、file_proposal_delta 等项目事件的名称、字段和顺序。
3. 让 ProposalStreamInterceptor 处理候选路径的真实 tool_call 分片；覆盖跨轮索引重用、转义字符、多个提案、分片边界拆开 JSON 字符串等场景。
4. 对四个既有脚本场景逐事件比较；新增真实 FastAPI 测试客户端读取 SSE 的集成测试。

**预期结果**：客户端无需改动即可消费新后端流。**通过门槛**：旧/新路径对契约场景逐事件一致；没有重复、漏发或提早的 tool_pending。

### 阶段 5：MCP、只读子 Agent、视觉兜底

**行动**

1. 复用 mcp_client.py 的连接、发现、缓存、重名冲突和能力过滤；把发现的 StructuredTool 纳入候选 create_agent。测试一台服务失败不影响其他服务、工具同名冲突、禁用工具不可见。
2. 将 explore_readonly 实现为受限工具集的子 Agent 或保留外层工具包装；必须证明它拿不到写入工具，能按其预算结束，并在取消时停下。不要为了简历增加无实际分工的多 Agent。
3. 迁移首轮无工具时的 VisionAutoLoader 兜底。文本模型不能隐式替代视觉推理；图片加载、无图片、图片读取失败各自测试。

**预期结果**：能力边界与旧路径一致。**通过门槛**：MCP 模拟服务 + 只读子 Agent + 视觉兜底的独立和组合测试通过；只读路径零写入。

### 阶段 6：DeepSeek 真实模型联调（若把它作为运行时模型）

**行动**

1. 用无副作用工具做最小联网 smoke test；验证选定模型、ChatCompletions/集成包、工具调用、JSON 参数、异步流、reasoning 和 token usage 的实际返回。
2. 再以脱敏、小规模的标注测试样本运行候选 Agent；记录请求 ID、模型名、调用耗时、失败类型和工具次数，不记录 API Key 或私有图像内容。
3. 实测多轮、同轮多工具、工具参数不合法、429/超时、流中断。模型不能稳定产生所需 tool_calls 时，不以「偶然一次成功」判定通过。
4. 如需视觉能力，先核实所选模型是否真实支持图像输入及与工具调用同时工作的能力；不支持则保持原视觉路线。

**预期结果**：证明特定 DeepSeek 模型与项目契约相容，而不只是 SDK 能回答「你好」。**通过门槛**：测试结果可重复，失败可诊断，预算和外部数据边界受控。

如果 DeepSeek 仅作编码助手，此阶段不阻碍框架迁移；改用项目现有真实模型完成等价验收。

### 阶段 7：接入隔离 FastAPI 入口

**行动**

1. 旧 /chat/stream 保持默认。用后端测试配置或独立测试入口选择候选路径；不要新增前端切换逻辑。
2. 用 httpx/FastAPI 测试客户端覆盖请求校验、MCP 准备事件、SSE、取消、工具结果回传、异常到 HTTP/SSE 的映射。
3. 确认原本的 auth/cloud backend 与候选 local-agent 不发生新耦合；禁用对生产数据、真实工作区写入的集成测试。
4. 回归完成后再考虑让候选成为默认；保留一段明确的旧路径回退开关。

**预期结果**：新旧入口可在后端受控切换。**通过门槛**：FastAPI 集成测试与第 0 阶段基线一致，原容器和原项目目录没有变化。

### 阶段 8：全量验收与默认切换

**行动**

1. 在 migration 环境运行完整 local-agent pytest 和四类逐事件对照；记录确切通过数、跳过项及原因。
2. 做故障注入：模型超时、工具超时、MCP 断开、重复结果、取消竞态、非法工具参数、用户未确认、标注后重复重标。
3. 分别统计旧/新路径的代码量、额外依赖、关键场景耗时、模型/工具调用次数、错误定位难度。性能只在相同输入、模型和配置下比较。
4. 明确执行一次真实端到端标注小样本测试（不接真实业务数据），核对结果内容与工具副作用；如无法调用 YOLO，验收标记为「未完成」而非「通过」。
5. 所有门槛通过后，才把候选切为副本中的默认入口。原目录与原容器仍不动。

**预期结果**：副本成为可复现的官方框架版本。**通过门槛**：下一节验收清单全部满足；否则维持旧入口，记录阻塞项。

## 6. 最终验收清单

### 6.1 环境与隔离

- [ ] 原项目目录可运行，原四个容器未停止、重建或共享新数据卷。
- [ ] 所有迁移代码只在 D:\Study\LR-Agent-LangChain-Migration。
- [ ] 新副本无真实 .env 密钥进入 Git；pip check 通过；依赖版本有固定记录。
- [ ] local-agent 使用独立端口与测试数据；没有误连接生产服务。

### 6.2 业务正确性

- [ ] 官方 create_agent 实际承接副本默认 Agent 模型—工具循环，而非仅存在实验目录。
- [ ] 标注待确认时不写盘；确认后继续推理；重复恢复不重复执行副作用。
- [ ] 同轮 auto_annotate 合批、同范围去重、all_files/write_mode 合并和报告写入门禁正确。
- [ ] 工具错误可恢复与不可恢复边界正确；调用预算耗尽会给出合理最终答复。
- [ ] 只读子 Agent 无写入能力；MCP 工具经过权限过滤；视觉兜底行为保留。

### 6.3 协议与可靠性

- [ ] 所有固定 SSE 契约场景逐事件一致，或差异逐项经人工批准并更新契约测试。
- [ ] FastAPI 流式集成测试通过；取消、超时、重试、网络中断和工具参数错误有明确结果。
- [ ] 真正执行过至少一次无敏感数据的小样本端到端标注，且结果可复核。
- [ ] 全量本地 Agent 测试通过；跳过项和已知限制已写入验收记录。

### 6.4 简历表述条件

- [ ] 迁移前只表述为「基于 LangChain 组件实现 Agent，并验证官方 Agent 迁移方案」。
- [ ] 迁移且验收后才表述为「基于 LangChain create_agent 与自定义 Middleware 实现自动标注 Agent」。
- [ ] 不把框架自带循环写成「独立自研核心循环」，也不把模拟测试写成真实业务效果。

## 7. 给 DeepSeek 编码助手的执行规范

每次只发送一个阶段，不发送整个仓库或密钥。可复制以下任务模板；把尖括号内容替换为当前阶段真实信息：

~~~text
你只在 D:\Study\LR-Agent-LangChain-Migration 中工作。原项目 D:\Study\LR-Agent 和已运行 Docker 容器不得修改。
当前阶段：<阶段编号与目标>。
先阅读本迁移计划、相关生产代码和既有测试，再列出要修改的后端文件及原因。
优先复用现有业务规则；不要改前端、YOLO 算法、数据库/会话存储，不要提交或打印密钥。
保持旧入口可用；新增候选路径和对应测试；不得把脚本化实验称为生产验收。
完成后交付：修改文件清单、关键设计决策、运行的命令和原始测试结果、尚未覆盖的场景、下一阶段门槛。
如果某项需要改变现有 SSE/工具协议或执行有副作用的操作，先停下说明差异，不要自行扩大范围。
~~~

建议按阶段 0→1→2→3→4→5→6→7→8 依次交给编码助手；每阶段结束人工阅读 diff 后再开始下一阶段。若代码助手给出「官方 middleware 已自动处理全部业务」之类说法，要以项目测试验证，而不是直接接受。

## 8. 验收记录模板（执行时填写，不能预填为通过）

~~~text
日期：
副本 Git SHA / 分支：
Python / langchain / langgraph / langchain-core / 模型集成包版本：
使用的运行时模型（如适用）：
阶段编号：
修改文件：
测试命令与原始结果：
旧/新事件差异：
工具实际执行次数与副作用核对：
性能数据（相同输入与模型才可比较）：
失败与待验证项：
是否达到本阶段门槛：是 / 否
人工复核人及结论：
~~~

最终报告应把「已通过」「仅脚本模拟」「未验证」「不在范围」分开写。不得把本计划文档本身当成完成证明。

## 9. 回滚规则

副本开发期间，回滚只影响副本：保留旧 stream_assist 与路由选择；切换失败立即将副本默认选择返回旧路径，定位后重新运行阶段测试。不要用 git reset --hard、直接删除用户数据或覆盖原项目来回滚。若未来要替换原项目/发布版本，须另起部署计划、备份与发布审批；本文件不授权触碰现有容器或其数据卷。

## 10. 学习资料与官方文档

学习顺序：第 2 章的 LangChain 核心组件与 Agent 入门 → 第 3 章 Runtime、Middleware、MCP、Multi Agent → 第 5 章 LangGraph 概念、常见 Workflow、Think In LangGraph。课程示例用于理解 API 与模式，具体包版本、模型名称、HITL/streaming 行为以**当前官方文档和本项目测试**为准。PDF 中出现的示例密钥不得使用；若任何示例密钥是真实有效凭据，应及时轮换。

- LangChain Agent：https://docs.langchain.com/oss/python/langchain/agents
- 自定义 middleware：https://docs.langchain.com/oss/python/langchain/middleware/custom
- 内置 middleware：https://docs.langchain.com/oss/python/langchain/middleware/built-in
- Streaming：https://docs.langchain.com/oss/python/langchain/streaming
- ChatDeepSeek 集成：https://docs.langchain.com/oss/python/integrations/chat/deepseek
- DeepSeek Chat Completions：https://api-docs.deepseek.com/api/create-chat-completion/

本地原始验证记录：LR-Agent\vendor\local-agent\experiments\VERIFICATION-2026-09-23.md。执行阶段 0 时先核对其中哪些结论仍可在副本重现。
