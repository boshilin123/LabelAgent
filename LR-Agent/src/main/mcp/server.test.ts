/**
 * @jest-environment node
 */
import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { getMcpServerToken, startMcpServer, stopMcpServer } from './server';

jest.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getName: () => 'lr-agent',
  },
}));

// 停用清单是硬禁用：技能类工具必须拒读。用可变数组替代 userData 存储，避免测试写磁盘。
const mockHiddenSkills: string[] = [];
jest.mock('../skills/skillsStore', () => ({
  getHiddenSkills: () => mockHiddenSkills,
}));

function request(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: data,
          headers: res.headers,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** JSON-RPC POST（Streamable HTTP 单端点） */
function postRpc(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** 响应可能是 JSON 或 SSE 帧（Accept 含 text/event-stream 时），统一取出 JSON-RPC payload */
function parseRpcBody(body: string): any {
  if (
    body.startsWith('event:') ||
    body.includes('\ndata:') ||
    body.startsWith('data:')
  ) {
    const dataLine = body.split('\n').find((line) => line.startsWith('data:'));
    return JSON.parse(dataLine!.slice(5).trim());
  }
  return JSON.parse(body);
}

/** 走完整 initialize 握手，返回带 session 头的后续请求头 */
async function initializeSession(
  baseUrl: string,
): Promise<Record<string, string>> {
  const token = getMcpServerToken();
  const auth = { Authorization: `Bearer ${token}` };
  const init = await postRpc(
    `${baseUrl}/mcp`,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'jest', version: '0.0.0' },
      },
    },
    auth,
  );
  expect(init.status).toBe(200);
  const sid = init.headers['mcp-session-id'];
  expect(typeof sid).toBe('string');
  await postRpc(
    `${baseUrl}/mcp`,
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
    { ...auth, 'Mcp-Session-Id': sid as string },
  );
  return { ...auth, 'Mcp-Session-Id': sid as string };
}

let baseUrl = '';

beforeAll(async () => {
  baseUrl = await startMcpServer();
});

afterAll(() => {
  stopMcpServer();
});

describe('MCP server 鉴权与请求校验', () => {
  it('/health 保持开放', async () => {
    const res = await request(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('缺少 Authorization 时返回 401', async () => {
    const res = await request(`${baseUrl}/mcp`);
    expect(res.status).toBe(401);
  });

  it('错误 token 返回 401', async () => {
    const res = await request(`${baseUrl}/mcp`, {
      Authorization: 'Bearer wrong-token',
    });
    expect(res.status).toBe(401);
  });

  it('带跨源 Origin 时返回 403', async () => {
    const token = getMcpServerToken();
    const res = await request(`${baseUrl}/mcp`, {
      Authorization: `Bearer ${token}`,
      Origin: 'http://evil.example',
    });
    expect(res.status).toBe(403);
  });

  it('正确 token 且无 session 时返回 400（已通过鉴权）', async () => {
    const token = getMcpServerToken();
    expect(token).toBeTruthy();
    const res = await request(`${baseUrl}/mcp`, {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(400);
  });
});

describe('MCP server 工具注册与调用', () => {
  it('run_agent_skill_script 已注册且 handler 可达', async () => {
    const sessionHeaders = await initializeSession(baseUrl);

    const list = await postRpc(
      `${baseUrl}/mcp`,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      },
      sessionHeaders,
    );
    expect(list.status).toBe(200);
    const listedTools = parseRpcBody(list.body).result.tools as {
      name: string;
    }[];
    const names = listedTools.map((tool) => tool.name);
    expect(names).toContain('run_agent_skill_script');
    expect(names).toEqual(
      expect.arrayContaining([
        'memory_read',
        'read_agent_skill',
        'list_agent_skill_files',
      ]),
    );

    // handler 真实执行：不存在的 skill 返回结构化错误 + 可用清单（证明 handler 链路通）
    const call = await postRpc(
      `${baseUrl}/mcp`,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'run_agent_skill_script',
          arguments: {
            skill_name: 'jest-no-such-skill',
            script: 'scripts/x.py',
          },
        },
      },
      sessionHeaders,
    );
    expect(call.status).toBe(200);
    const payload = JSON.parse(parseRpcBody(call.body).result.content[0].text);
    expect(payload).toMatchObject({ ok: false, error: 'skill_not_found' });
    expect(Array.isArray(payload.available_skills)).toBe(true);
  });

  it('停用的 skill 拒读：read_agent_skill 与 list_agent_skill_files 都返回 skill_disabled', async () => {
    const sessionHeaders = await initializeSession(baseUrl);
    mockHiddenSkills.push('jest-blocked-skill');
    try {
      for (const [name, args] of [
        ['read_agent_skill', { skill_name: 'jest-blocked-skill' }],
        ['list_agent_skill_files', { skill_name: 'jest-blocked-skill' }],
        [
          'run_agent_skill_script',
          { skill_name: 'jest-blocked-skill', script: 'scripts/x.py' },
        ],
      ] as const) {
        const res = await postRpc(
          `${baseUrl}/mcp`,
          {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name, arguments: args },
          },
          sessionHeaders,
        );
        expect(res.status).toBe(200);
        const body = JSON.parse(parseRpcBody(res.body).result.content[0].text);
        expect(body).toMatchObject({ ok: false, error: 'skill_disabled' });
      }
    } finally {
      mockHiddenSkills.length = 0;
    }
  });
});
