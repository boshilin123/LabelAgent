import { describe, expect, it } from '@jest/globals';
import { buildApiClientContext } from './agentClientContext';
import { buildClientContextPayload } from './agentClientContextBuilder';

jest.mock('./annotationAgentBridge', () => ({
  getAnnotationWorkspaceAgentSnapshot: () => ({
    selectedAnnotationId: null,
    selectedAnnotationIds: [],
    workspaceProjectId: null,
  }),
}));

describe('buildApiClientContext mcp_servers', () => {
  it('maps remote MCP servers to snake_case payload', () => {
    const payload = buildApiClientContext({
      mcpServers: [
        {
          id: 'srv_1',
          url: 'https://mcp.tavily.com/mcp',
          transport: 'sse',
          headers: { Authorization: 'Bearer tvly-x' },
        },
      ],
    });
    expect(payload.mcp_servers).toEqual([
      {
        id: 'srv_1',
        url: 'https://mcp.tavily.com/mcp',
        transport: 'sse',
        headers: { Authorization: 'Bearer tvly-x' },
        disabled_tools: [],
      },
    ]);
  });

  it('maps disabledTools to disabled_tools', () => {
    const payload = buildApiClientContext({
      mcpServers: [
        {
          id: 'srv_3',
          url: 'https://mcp.tavily.com/mcp',
          transport: 'streamable_http',
          headers: {},
          disabledTools: ['tavily_crawl', 'tavily_map'],
        },
      ],
    });
    expect(payload.mcp_servers).toEqual([
      {
        id: 'srv_3',
        url: 'https://mcp.tavily.com/mcp',
        transport: 'streamable_http',
        headers: {},
        disabled_tools: ['tavily_crawl', 'tavily_map'],
      },
    ]);
  });

  it('yields empty list when mcpServers omitted', () => {
    const payload = buildApiClientContext({});
    expect(payload.mcp_servers).toEqual([]);
  });

  it('defaults missing headers to empty object', () => {
    const payload = buildApiClientContext({
      mcpServers: [
        {
          id: 'srv_2',
          url: 'https://mcp.context7.com/mcp',
          transport: 'streamable_http',
          headers: undefined as unknown as Record<string, string>,
        },
      ],
    });
    expect(payload.mcp_servers).toEqual([
      {
        id: 'srv_2',
        url: 'https://mcp.context7.com/mcp',
        transport: 'streamable_http',
        headers: {},
        disabled_tools: [],
      },
    ]);
  });
});

describe('buildClientContextPayload mcpServers', () => {
  it('forwards remote MCP servers', () => {
    const payload = buildClientContextPayload({
      rootPath: '/tmp/project',
      activeFilePath: null,
      activeProject: null,
      agentMode: 'chat',
      workMode: 'editor',
      detectionModels: [],
      mcpServers: [
        {
          id: 'srv_1',
          url: 'https://mcp.tavily.com/mcp',
          transport: 'streamable_http',
          headers: { Authorization: 'Bearer k' },
        },
      ],
    });
    expect(payload.mcpServers).toHaveLength(1);
    expect(payload.mcpServers?.[0]?.id).toBe('srv_1');
  });

  it('defaults mcpServers to null when omitted', () => {
    const payload = buildClientContextPayload({
      rootPath: '/tmp/project',
      activeFilePath: null,
      activeProject: null,
      agentMode: 'chat',
      workMode: 'editor',
      detectionModels: [],
    });
    expect(payload.mcpServers).toBeNull();
  });
});
