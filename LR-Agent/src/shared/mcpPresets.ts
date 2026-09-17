/**
 * MCP 广场预设目录。
 *
 * 第三方端点会随厂商调整；此处仅收录带稳定预填 URL 的服务。
 */
import { MCP_API_KEY_PLACEHOLDER, type McpPreset } from './mcpTypes';

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'tavily',
    name: 'Tavily 网页搜索',
    description:
      '实时网页搜索与内容抽取（tavily-search / tavily-extract 等）。在 tavily.com 获取 API Key。',
    url: 'https://mcp.tavily.com/mcp',
    transport: 'streamable_http',
    requiresApiKey: true,
    apiKeyHeader: 'Authorization',
    apiKeyTemplate: `Bearer ${MCP_API_KEY_PLACEHOLDER}`,
    docsUrl: 'https://github.com/tavily-ai/tavily-mcp',
    icon: 'tavily',
  },
  {
    id: 'context7',
    name: 'Context7 文档查询',
    description:
      '查询主流库的最新官方文档与代码示例（resolve-library-id / query-docs）。API Key 可选。',
    url: 'https://mcp.context7.com/mcp',
    transport: 'streamable_http',
    requiresApiKey: false,
    apiKeyHeader: 'CONTEXT7_API_KEY',
    apiKeyTemplate: MCP_API_KEY_PLACEHOLDER,
    docsUrl: 'https://context7.com',
    icon: 'context7',
  },
  {
    id: 'github',
    name: 'GitHub',
    description:
      '仓库、Issue、PR 与代码搜索。使用 GitHub PAT（repo 等权限）作为 API Key。',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable_http',
    requiresApiKey: true,
    apiKeyHeader: 'Authorization',
    apiKeyTemplate: `Bearer ${MCP_API_KEY_PLACEHOLDER}`,
    docsUrl: 'https://github.com/github/github-mcp-server',
    icon: 'github',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description:
      '模型、数据集与 Spaces 检索。在 huggingface.co/settings/tokens 创建 Token。',
    url: 'https://huggingface.co/mcp',
    transport: 'streamable_http',
    requiresApiKey: true,
    apiKeyHeader: 'Authorization',
    apiKeyTemplate: `Bearer ${MCP_API_KEY_PLACEHOLDER}`,
    docsUrl: 'https://huggingface.co/settings/mcp',
    icon: 'huggingface',
  },
];
