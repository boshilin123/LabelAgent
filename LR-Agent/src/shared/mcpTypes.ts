/**
 * 远程 MCP Server 配置类型（持久化于 <userData>/mcp.json）。
 *
 * 仅覆盖用户可配置的远程 MCP（Streamable HTTP / SSE）；
 * 本机 Electron MCP Server（memory_* / read_agent_skill）不写进该文件，
 * 启动后仍通过 mcp:getServerUrl 单独注入。
 */

export type McpTransport = 'streamable_http' | 'sse';

export const MCP_TRANSPORTS: readonly McpTransport[] = [
  'streamable_http',
  'sse',
];

export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  streamable_http: 'Streamable HTTP',
  sse: 'SSE',
};

/** API Key 值模板占位符：字面上的 "${KEY}"，由表单层替换为用户输入。
 * 故意在普通字符串中使用 ${}，并非模板字符串笔误。
 */
// eslint-disable-next-line no-template-curly-in-string
export const MCP_API_KEY_PLACEHOLDER = '${KEY}';

/**
 * 大 server 自动白名单阈值。
 *
 * 探测到的工具数超过该值时，**新发现**的工具默认写入 disabledTools（已有工具不受影响）：
 * 40+ 个工具的 schema 会常驻提示前缀并大幅提高模型选错工具的概率，默认按需开启更划算。
 */
export const MCP_AUTO_ALLOWLIST_THRESHOLD = 20;

/** 单个远程 MCP Server 配置（mcp.json 中 mcpServers 的值） */
export interface McpServerConfig {
  /** 配置主键（mcpServers 的 key，srv_ 前缀随机串） */
  id: string;
  /** 展示名（可为中文） */
  name: string;
  /** 远程端点完整 URL（不自动拼 /mcp） */
  url: string;
  transport: McpTransport;
  /** 请求头（API Key 等敏感值；禁止打日志） */
  headers: Record<string, string>;
  enabled: boolean;
  /** 来源广场预设 id；自定义添加为 null */
  preset: string | null;
  /** 关闭的工具名，Assist 注入时过滤 */
  disabledTools: string[];
  /** 最近一次 probe 成功的工具名，供 UI 立刻展开 */
  lastTools: string[];
  createdAt: number;
  updatedAt: number;
}

/** mcp.json 顶层结构 */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** 新建/编辑时从 renderer 提交的载荷（id 缺省表示新建） */
export interface McpServerInput {
  id?: string;
  name: string;
  url: string;
  transport: McpTransport;
  headers: Record<string, string>;
  enabled: boolean;
  preset?: string | null;
  disabledTools?: string[];
  lastTools?: string[];
}

/** MCP 广场预设条目（代码目录，不自动写入 mcp.json） */
export interface McpPreset {
  id: string;
  name: string;
  description: string;
  /** 预填端点；空串表示需用户自行从厂商文档获取 */
  url: string;
  transport: McpTransport;
  /** 是否必须填写 API Key 才能保存 */
  requiresApiKey: boolean;
  /** API Key 写入的 header 名（默认 Authorization） */
  apiKeyHeader?: string;
  /** header 值模板，${KEY} 会被替换为用户输入（默认 "Bearer ${KEY}"） */
  apiKeyTemplate?: string;
  /** 厂商文档 / 控制台链接 */
  docsUrl?: string;
  /** 品牌图标键，默认与 id 相同 */
  icon?: string;
}

/** 注入 client_context 的远程 MCP 载荷（snake_case 由 agentClientContext 转换） */
export interface McpRemoteServerPayload {
  id: string;
  url: string;
  transport: McpTransport;
  headers: Record<string, string>;
  disabledTools?: string[];
}

/** 测试连接结果（POST /api/v1/agent/mcp/probe） */
export interface McpProbeResult {
  ok: boolean;
  tools?: string[];
  error?: string;
}

/** 把 header 值脱敏后用于展示（永不展示完整 Key） */
export function maskHeaderValue(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
