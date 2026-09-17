# 安全说明与加固记录

本文件记录 LR-Agent 桌面端（Electron + 本地 `vendor/local-agent`）的安全加固措施、
残余风险以及尚未闭环的运维事项。改动代码时请同步维护本文件。

## 已实施加固

### 1. XSS → RCE 链阻断

- 所有 `dangerouslySetInnerHTML` 注入点统一走 `src/renderer/utils/sanitizeHtml.ts`
  （基于 DOMPurify）消毒：
  - `FileViewer.tsx`（mammoth 转换的 docx HTML）
  - `markdownCodeComponents.tsx` / `HighlightedCodeBlock.tsx` / `AgentFileDiffView.tsx`
    （highlight.js 输出）
  - `FileTypeIcon.tsx` 为内置可信 SVG，加注释锁定来源。
- docx / markdown 内的链接一律只放行 `https:`，其余协议（`javascript:`、`data:`、
  `file:` 等）在点击时 `preventDefault`；外链统一经主进程 `isSafeExternalUrl` 校验。
- CSP：
  - 渲染层 `index.ejs` 不再内联宽泛策略，由 webpack 通过
    `.erb/configs/rendererCsp.ts` 注入；生产环境内联主题脚本使用 `sha256-` 哈希，
    不使用 `script-src 'unsafe-inline'`；开发环境单独放宽以兼容 HMR/React Refresh。
  - 主进程 `src/main/security/csp.ts` 通过 `onHeadersReceived` 按运行时配置动态拼装
    `connect-src`（后端地址 + 本地 agent/MCP origin），并附加
    `X-Content-Type-Options` / `Referrer-Policy`。
  - 生产 CSP 含 `object-src 'none'`、`base-uri 'none'`、`form-action 'none'`。

### 2. IPC 面收敛

- `src/main/preload.ts` 移除通用 `invoke(channel, ...)` / `sendMessage`，改为逐方法窄接口，
  并对事件 channel 做运行时白名单校验。
- 主进程敏感 handler 增加参数校验：
  - 文件读取拒绝应用自身凭据文件（`lr-agent.db`、`mcp.json`、`session_cache.dat`、
    `refresh_token.dat` 等）。
  - 文件/目录操作限定在「授权根」集合内（`src/main/security/authorizedRoots.ts`）。
  - `shell.openPath` / `window.openExternal` 拒绝可执行/脚本扩展名
    （`src/shared/dangerousExtensions.ts`），协议白名单只放行 `https:`（及配置的后端 `http:`）。
  - `setWindowOpenHandler` + `will-navigate` 通过 `web-contents-created` 统一挂载，
    覆盖未来新增的 webContents。

### 3. 凭据加密

- `src/main/security/secretStore.ts` 基于 Electron `safeStorage` 加解密，格式 `v1:<base64>`。
- LLM Provider API Key（`llm_providers.api_key_encrypted`，`encryption_key_id = v1`）与
  MCP 远程服务敏感 header（`mcp.json`）落盘前加密。
- `tokenStore` / `sessionCacheStore` 去掉了明文回退：`safeStorage` 不可用时失败关闭。
- `src/main/security/migrateSecrets.ts` 启动时幂等迁移历史明文（`v0`）数据，失败不阻断启动。

### 4. 本地服务鉴权

- 本地 MCP Server（`src/main/mcp/server.ts`）：每次启动生成随机 token，`/mcp` 校验
  `Authorization: Bearer`，并校验 `Host` 仅为本机、拒绝带 `Origin` 的跨源请求；`/health` 保持开放。
- 本地 Agent（`vendor/local-agent`）：Electron 主进程通过环境变量 `LR_AGENT_LOCAL_TOKEN`
  注入随机 token，FastAPI 侧 `app/core/deps.py#require_local_token` 对全部 `/api/v1` 路由做
  常量时间校验；未配置 token 时失败关闭（仅 `/health` 可用）。
  渲染层所有发往本地 Agent 的请求统一经 `src/renderer/config.ts#localAgentFetch` 携带 Bearer token。
- CORS 启动校验：`allow_credentials=True` 时禁止 `cors_origins` 含 `*`。

### 5. 文件写入策略

- 写盘/编辑改为「文本扩展名白名单」（`src/shared/workspaceTextExtensions.ts` 与
  `vendor/local-agent/app/agent/tools/workspace_text_extensions.py` 保持同步）：
  白名单之外的扩展名一律禁止写入，脚本/可执行类型（`.bat`、`.cmd`、`.ps1`、`.vbs`、
  `.hta`、`.scr`、`.jar`、`.reg`、`.lnk` 等）被明确拒绝。
- `src/main/workspace/workspaceWrite.ts` 在 `path.resolve` 之外补充 `fs.realpath` 校验，
  防止工作区内符号链接把读写重定向到授权根之外。

### 6. 深度链接

- `src/main/auth/resetDeepLink.ts` 校验 scheme/路径/ token 字符集与长度（16–2048），
  非法输入不入暂存；token 取用即清（`takePendingResetToken`）。

## 测试

- TS：`npm test`（含 secretStore 加解密与失败关闭、MCP `/mcp` 401/403/放行、写盘白名单与
  扩展名拦截、符号链接逃逸、深度链接校验与用后即清）。
- Python：`cd vendor/local-agent && python -m pytest`（含 `tests/test_local_auth.py`
  的 401/放行用例、`tests/test_workspace_text_extensions.py` 白名单用例）。
- 手工验证建议：dev 下确认新 CSP 不破坏 HMR/React Refresh；构造含 `javascript:` 链接的
  `.docx` 确认点击无脚本执行；用错误 token 调 `/mcp` 与本地 Agent 接口确认 401。

## 残余风险

- **自定义协议劫持**：`lr-agent://` 在本机是全局注册的，恶意程序可抢占注册或在应用未运行时
  抢先处理链接。客户端无法彻底解决，需后端缩短 reset token 有效期并做一次性绑定。
- **safeStorage 不可用**：部分 Linux 环境（无 keyring）下 `safeStorage.isEncryptionAvailable()`
  为假，此时凭据写入/读取会失败并需要用户重新输入；这是刻意的失败关闭行为。
- **开发环境 CSP 放宽**：dev 策略包含 `unsafe-inline`/`unsafe-eval` 与本地 `ws:`，仅存在于
  dev 构建，不会进入发布包。

## 未闭环 / BLOCKED 事项

### 代码签名与公证（依赖外部证书，属运维前置）

- Windows：使用 electron-builder 的证书签名，需要在 CI 注入以下 secret（或等价配置）：
  - `WIN_CSC_LINK`：`.pfx` 证书的路径或 base64 内容
  - `WIN_CSC_KEY_PASSWORD`：证书密码
- macOS：`afterSign` 钩子（`.erb/scripts/notarize.js`）已按 CI 环境变量开启公证，缺失时自动跳过。
  需要的 secret：`APPLE_ID`、`APPLE_ID_PASS`、`APPLE_TEAM_ID`。
- **状态：BLOCKED** — 证书/Apple 账号尚未提供，未配置时构建产物为未签名（本地开发可正常运行）。
  配置上述 secret 后无需修改代码即可启用签名与公证。

### `vendor/inference` 反序列化审计

- 审计结论（2026-09）：当前 `vendor/inference` 与 `vendor/local-agent` 中**未发现**
  `torch.load`、`pickle.load`、`np.load(allow_pickle=True)`、`yaml.load(`、`eval(`、`exec(`、
  `os.system` 等高风险调用。
- 后续政策：新增模型加载必须使用 `torch.load(..., weights_only=True)` 或 `safetensors`，
  禁止加载不可信 checkpoint；引入前需补 CodeQL 扫描（已加入 `python` 语言矩阵）。
