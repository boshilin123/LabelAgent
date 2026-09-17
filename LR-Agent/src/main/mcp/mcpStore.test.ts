import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  defaultMcpConfig,
  deleteMcpServer,
  getEnabledMcpServers,
  getMcpConfig,
  getMcpStorePath,
  resetMcpConfigCache,
  setMcpServerEnabled,
  setMcpServerTools,
  upsertMcpServer,
} from './mcpStore';

let userDataDir: string;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('decrypt_failed');
      }
      return text.slice('enc:'.length);
    },
  },
}));

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-store-'));
  resetMcpConfigCache();
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('getMcpConfig', () => {
  it('returns defaults when no file exists', () => {
    expect(getMcpConfig()).toEqual(defaultMcpConfig());
  });

  it('sanitizes a persisted file: bad transport/url/headers dropped or fixed', () => {
    fs.writeJsonSync(getMcpStorePath(), {
      mcpServers: {
        ok_server: {
          name: 'Tavily',
          url: 'https://mcp.tavily.com/mcp',
          transport: 'sse',
          headers: { Authorization: 'Bearer k', Bad: 42, ' ': 'x' },
          enabled: true,
          preset: 'tavily',
        },
        bad_transport: {
          name: 'stdio server',
          url: 'https://example.com/mcp',
          transport: 'stdio',
        },
        bad_url: {
          name: 'broken',
          url: 'not-a-url',
        },
        'bad id!': {
          name: 'bad id',
          url: 'https://example.com/mcp',
        },
      },
    });
    resetMcpConfigCache();

    const config = getMcpConfig();
    const servers = config.mcpServers;
    expect(Object.keys(servers).sort()).toEqual(['bad_transport', 'ok_server']);
    expect(servers.ok_server.transport).toBe('sse');
    expect(servers.ok_server.headers).toEqual({ Authorization: 'Bearer k' });
    expect(servers.ok_server.disabledTools).toEqual([]);
    expect(servers.ok_server.lastTools).toEqual([]);
    // 非法 transport 回退 streamable_http
    expect(servers.bad_transport.transport).toBe('streamable_http');
    expect(servers.bad_transport.enabled).toBe(true);
    expect(servers.bad_transport.preset).toBeNull();
  });
});

describe('upsertMcpServer', () => {
  it('creates a server with generated srv_ id and persists it', async () => {
    const created = await upsertMcpServer({
      name: 'Tavily',
      url: 'https://mcp.tavily.com/mcp',
      transport: 'streamable_http',
      headers: { Authorization: 'Bearer tvly-x' },
      enabled: true,
      preset: 'tavily',
    });
    expect(created).not.toBeNull();
    expect(created!.id).toMatch(/^srv_[a-z0-9]{12}$/);
    expect(created!.preset).toBe('tavily');

    resetMcpConfigCache();
    expect(getMcpConfig().mcpServers[created!.id]).toEqual(created);
  });

  it('rejects invalid url', async () => {
    const result = await upsertMcpServer({
      name: 'x',
      url: 'ftp://example.com',
      transport: 'sse',
      headers: {},
      enabled: true,
    });
    expect(result).toBeNull();
  });

  it('updates an existing server in place, keeping createdAt', async () => {
    const created = await upsertMcpServer({
      name: 'A',
      url: 'https://a.example.com/mcp',
      transport: 'streamable_http',
      headers: {},
      enabled: true,
    });
    const updated = await upsertMcpServer({
      id: created!.id,
      name: 'A2',
      url: 'https://a.example.com/mcp',
      transport: 'sse',
      headers: {},
      enabled: false,
    });
    expect(updated!.name).toBe('A2');
    expect(updated!.transport).toBe('sse');
    expect(updated!.enabled).toBe(false);
    expect(updated!.createdAt).toBe(created!.createdAt);
    expect(Object.keys(getMcpConfig().mcpServers)).toHaveLength(1);
  });
});

describe('deleteMcpServer / setMcpServerEnabled / getEnabledMcpServers', () => {
  it('toggles enabled and filters enabled servers', async () => {
    const a = await upsertMcpServer({
      name: 'A',
      url: 'https://a.example.com/mcp',
      transport: 'streamable_http',
      headers: {},
      enabled: true,
    });
    await upsertMcpServer({
      name: 'B',
      url: 'https://b.example.com/mcp',
      transport: 'streamable_http',
      headers: {},
      enabled: false,
    });
    expect(getEnabledMcpServers().map((s) => s.id)).toEqual([a!.id]);

    const toggled = await setMcpServerEnabled(a!.id, false);
    expect(toggled!.enabled).toBe(false);
    expect(getEnabledMcpServers()).toEqual([]);

    expect(await setMcpServerEnabled('missing', true)).toBeNull();
  });

  it('deletes a server', async () => {
    const a = await upsertMcpServer({
      name: 'A',
      url: 'https://a.example.com/mcp',
      transport: 'streamable_http',
      headers: {},
      enabled: true,
    });
    expect(await deleteMcpServer(a!.id)).toBe(true);
    expect(await deleteMcpServer(a!.id)).toBe(false);
    expect(getMcpConfig().mcpServers[a!.id]).toBeUndefined();
  });
});

describe('setMcpServerTools', () => {
  it('sanitizes lastTools / disabledTools and drops non-strings', async () => {
    fs.writeJsonSync(getMcpStorePath(), {
      mcpServers: {
        srv_abc: {
          name: 'A',
          url: 'https://a.example.com/mcp',
          transport: 'streamable_http',
          headers: {},
          enabled: true,
          lastTools: ['keep', 12, '', 'keep'],
          disabledTools: ['off', null, 'off'],
        },
      },
    });
    resetMcpConfigCache();
    expect(getMcpConfig().mcpServers.srv_abc.lastTools).toEqual(['keep']);
    expect(getMcpConfig().mcpServers.srv_abc.disabledTools).toEqual(['off']);

    const updated = await setMcpServerTools('srv_abc', {
      lastTools: ['a', 'b'],
      disabledTools: ['b'],
    });
    expect(updated!.lastTools).toEqual(['a', 'b']);
    expect(updated!.disabledTools).toEqual(['b']);
  });

  it('preserves lastTools when upserting name/url', async () => {
    const created = await upsertMcpServer({
      name: 'A',
      url: 'https://a.example.com/mcp',
      transport: 'streamable_http',
      headers: {},
      enabled: true,
    });
    await setMcpServerTools(created!.id, {
      lastTools: ['t1', 't2'],
      disabledTools: ['t2'],
    });
    const updated = await upsertMcpServer({
      id: created!.id,
      name: 'A2',
      url: 'https://a.example.com/mcp',
      transport: 'streamable_http',
      headers: {},
      enabled: true,
    });
    expect(updated!.name).toBe('A2');
    expect(updated!.lastTools).toEqual(['t1', 't2']);
    expect(updated!.disabledTools).toEqual(['t2']);
  });
});

describe('大 server 阈值自动白名单', () => {
  const bigTools = Array.from({ length: 25 }, (_, i) => `tool_${i}`);

  async function createServer(
    lastTools: string[] = [],
    disabledTools: string[] = [],
  ) {
    const created = await upsertMcpServer({
      name: 'Big',
      url: 'https://big.example.com/mcp',
      transport: 'streamable_http',
      headers: {},
      enabled: true,
    });
    if (lastTools.length || disabledTools.length) {
      await setMcpServerTools(created!.id, { lastTools, disabledTools });
    }
    return created!.id;
  }

  it('首次探测到超过阈值的工具时全部默认关闭', async () => {
    const id = await createServer();
    const updated = await setMcpServerTools(id, { lastTools: bigTools });
    expect(updated!.disabledTools).toEqual(bigTools);
    expect(updated!.lastTools).toEqual(bigTools);
  });

  it('已有工具不被回溯禁用，只禁新发现的', async () => {
    const id = await createServer(['tool_0', 'tool_1']);
    const updated = await setMcpServerTools(id, {
      lastTools: [...bigTools],
    });
    expect(updated!.disabledTools).toEqual(
      bigTools.filter((n) => !['tool_0', 'tool_1'].includes(n)),
    );
  });

  it('阈值以内的小 server 新工具保持默认开启', async () => {
    const id = await createServer();
    const updated = await setMcpServerTools(id, {
      lastTools: ['t1', 't2', 't3'],
    });
    expect(updated!.disabledTools).toEqual([]);
  });

  it('显式传 disabledTools 时以调用方为准（全部开启按钮）', async () => {
    const id = await createServer();
    await setMcpServerTools(id, { lastTools: bigTools });
    const enabledAll = await setMcpServerTools(id, {
      lastTools: bigTools,
      disabledTools: [],
    });
    expect(enabledAll!.disabledTools).toEqual([]);
  });

  it('只传 disabledTools 的调用不触发自动关闭逻辑', async () => {
    const id = await createServer();
    const autoDisabled = await setMcpServerTools(id, { lastTools: bigTools });
    expect(autoDisabled!.disabledTools).toEqual(bigTools);

    // 「全部开启」后再单项关闭：写入值即用户意图，不再叠加自动关闭
    const picked = await setMcpServerTools(id, { disabledTools: ['tool_1'] });
    expect(picked!.disabledTools).toEqual(['tool_1']);
  });
});
