/**
 * Electron 本地 MCP Server
 *
 * 在 Electron 主进程中启动 Streamable HTTP MCP 服务器（单端点 /mcp），暴露本地能力：
 *   - memory_read / memory_write / memory_create（工作区记忆，需任务开关激活）
 *   - read_agent_skill / list_agent_skill_files
 *
 * 后端 Agent 通过 langchain-mcp-adapters（streamable_http）连接此服务器。
 * 前端在 app.whenReady() 后调用 startMcpServer()，并将端口通过 IPC 传给 renderer。
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import net from 'net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  assertAgentWritableTopic,
  createMemoryTopic,
  getActiveMemoryScope,
  isWorkspaceMemoryActive,
  listMemoryTopics,
  readMemoryTopic,
  writeMemoryTopic,
} from '../memory/memoryStore';
import {
  listSkillFiles,
  readSkillFile,
  resolveSkillDirName,
  scanSkillsCatalog,
} from '../skills/skillScanner';
import { getHiddenSkills } from '../skills/skillsStore';
import { runSkillScript } from '../skills/skillScriptRunner';
import {
  killTerminalJob,
  readTerminalJobFrom,
} from '../exec/commandJobManager';

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

let httpServer: http.Server | null = null;
let listenPort: number | null = null;
let authToken: string | null = null;
const sessions = new Map<string, McpSession>();

/** 常量时间比较，避免 token 被逐字节探测 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** /mcp 只接受本机 Host，且不允许带 Origin（浏览器跨源请求一律拒绝） */
function isTrustedMcpRequest(req: IncomingMessage): boolean {
  const { host } = req.headers;
  if (typeof host !== 'string' || !host.trim()) return false;
  const hostname = host.split(':')[0].toLowerCase();
  if (
    hostname !== '127.0.0.1' &&
    hostname !== 'localhost' &&
    hostname !== '[::1]' &&
    hostname !== '::1'
  ) {
    return false;
  }
  const { origin } = req.headers;
  if (typeof origin === 'string' && origin.trim()) return false;
  return true;
}

function hasValidBearerToken(req: IncomingMessage): boolean {
  if (!authToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return safeEqual(match[1].trim(), authToken);
}

/** 获取本机随机空闲端口 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
    srv.on('error', reject);
  });
}

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        req.destroy();
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sessionIdFromRequest(req: IncomingMessage): string | undefined {
  const header = req.headers['mcp-session-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim();
  return undefined;
}

function mcpJson(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

function requireActiveWorkspaceMemory():
  | { ok: true; scopeKey: string }
  | { ok: false; result: ReturnType<typeof mcpJson> } {
  if (!isWorkspaceMemoryActive()) {
    return {
      ok: false,
      result: mcpJson({
        ok: false,
        error: 'workspace_memory_inactive',
      }),
    };
  }
  return { ok: true, scopeKey: getActiveMemoryScope() };
}

/**
 * 停用清单按目录名存储，而入参可能是 frontmatter name，故先反查目录名。
 * 停用是硬禁用：技能类工具一律拒读，不只是从 prompt 清单里隐藏。
 */
async function isSkillDisabledForAgent(skillName: string): Promise<boolean> {
  const name = skillName.trim();
  if (!name) return false;
  const hidden = getHiddenSkills();
  if (hidden.length === 0) return false;
  if (hidden.includes(name)) return true;
  const dirName = await resolveSkillDirName(name);
  return dirName !== null && hidden.includes(dirName);
}

function createMcpServer(): McpServer {
  const mcpServer = new McpServer({
    name: 'lr-agent-local',
    version: '1.0.0',
  });

  mcpServer.tool(
    'memory_read',
    'Read a workspace-memory topic file (full content) for the current annotation task. Topics are listed in the workspace-memory index in the system prompt. You may read system facts such as "progress.md" or "annotated-files.md", or preference topics such as "conventions.md".',
    {
      topic_file: z
        .string()
        .describe('Workspace memory topic filename, e.g. "progress.md"'),
    },
    async ({ topic_file }) => {
      try {
        const active = requireActiveWorkspaceMemory();
        if (!active.ok) return active.result;
        const content = await readMemoryTopic(active.scopeKey, topic_file);
        if (content === null) {
          const topics = await listMemoryTopics(active.scopeKey);
          return mcpJson({
            ok: false,
            error: 'topic_not_found',
            available_topics: topics,
          });
        }
        return mcpJson({ ok: true, content });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  mcpServer.tool(
    'read_agent_skill',
    'Read a text file from a user-level agent skill. Skills are listed with name and description in the available-skills block. When a user request matches a skill, first read SKILL.md (omit relative_path), follow its steps, then read bundled files it references via relative_path (e.g. "references/api.md"). Bundled scripts under scripts/ can be executed with run_agent_skill_script. Pass skill_name exactly as listed (directory name).',
    {
      skill_name: z
        .string()
        .describe(
          'Skill name as listed in the available-skills block, e.g. "caveman"',
        ),
      relative_path: z
        .string()
        .optional()
        .describe(
          'Optional path relative to the skill directory. Omit to read SKILL.md. Examples: "references/guide.md", "scripts/extract.py".',
        ),
    },
    async ({ skill_name, relative_path }) => {
      try {
        if (await isSkillDisabledForAgent(skill_name)) {
          return mcpJson({ ok: false, error: 'skill_disabled' });
        }
        const result = await readSkillFile(skill_name, relative_path);
        if (!result.ok) {
          const catalog = await scanSkillsCatalog(undefined, getHiddenSkills());
          return mcpJson({
            ok: false,
            error: result.error,
            available_skills: catalog.map((s) => s.name),
          });
        }
        return mcpJson({
          ok: true,
          relative_path: result.relativePath,
          content: result.content,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  mcpServer.tool(
    'list_agent_skill_files',
    'List text files bundled in a user-level agent skill directory (SKILL.md, references, templates, script sources). Use after matching a skill, or when SKILL.md points to extra files. Scripts under scripts/ can be executed with run_agent_skill_script. Pass skill_name exactly as listed.',
    {
      skill_name: z
        .string()
        .describe(
          'Skill name as listed in the available-skills block, e.g. "caveman"',
        ),
    },
    async ({ skill_name }) => {
      try {
        if (await isSkillDisabledForAgent(skill_name)) {
          return mcpJson({ ok: false, error: 'skill_disabled' });
        }
        const files = await listSkillFiles(skill_name);
        if (files === null) {
          const catalog = await scanSkillsCatalog(undefined, getHiddenSkills());
          return mcpJson({
            ok: false,
            error: 'skill_not_found',
            available_skills: catalog.map((s) => s.name),
          });
        }
        return mcpJson({ ok: true, files });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  mcpServer.tool(
    'run_agent_skill_script',
    "Execute a bundled script from a user-level agent skill. Only files under the skill's scripts/ directory can run: .py scripts use the app's Python runtime, .sh scripts use bash, other types are rejected. Arguments are passed verbatim as argv (no shell interpolation), the working directory is the current workspace, and the script is force-killed after a 120s timeout. Read the skill's SKILL.md first to learn each script's interface, then pass arguments exactly as documented. Combined stdout+stderr is returned, truncated when too long.",
    {
      skill_name: z
        .string()
        .describe(
          'Skill name as listed in the available-skills block, e.g. "pdf-extract"',
        ),
      script: z
        .string()
        .describe(
          'Script path relative to the skill directory, e.g. "scripts/extract.py"',
        ),
      args: z
        .array(z.string())
        .max(64)
        .optional()
        .describe(
          'Positional arguments passed to the script verbatim, e.g. ["input.pdf", "--pages", "1-3"]',
        ),
    },
    async ({ skill_name, script, args }) => {
      try {
        if (await isSkillDisabledForAgent(skill_name)) {
          return mcpJson({ ok: false, error: 'skill_disabled' });
        }
        const result = await runSkillScript(skill_name, script, args ?? []);
        if (!result.ok) {
          const catalog = await scanSkillsCatalog(undefined, getHiddenSkills());
          return mcpJson({
            ok: false,
            error: result.error,
            message: result.message,
            available_skills: catalog.map((s) => s.name),
          });
        }
        return mcpJson(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  mcpServer.tool(
    'start_terminal_command',
    'Run a terminal command in the current workspace (cwd is locked to it). Runs WITHOUT a shell: no pipes, redirections or command chains — split into multiple calls instead. Every execution requires explicit user approval in the chat UI before it starts, and destructive commands are rejected outright. Returns a job id; the tool result delivered to you contains the exit code and an output tail. Use read_terminal_output for the full/incremental output and kill_terminal_job to abort a long-running job.',
    {
      command: z
        .string()
        .describe(
          'Executable name or path, e.g. "git". Shell builtins and shell syntax (|, >, &&) are not supported',
        ),
      args: z
        .array(z.string())
        .max(128)
        .optional()
        .describe(
          'Arguments passed verbatim as argv, e.g. ["status", "--short"]',
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe(
          'Kill the command after this many ms (default 300000, max 600000)',
        ),
    },
    // Agent loop 以 ASYNC runner 分派本工具（TOOL_RUNNERS），不会走到这里；
    // handler 仅在其他 MCP 客户端直调时说明真实入口。
    async () =>
      mcpJson({
        ok: false,
        error: 'approval_required',
        message:
          'start_terminal_command is executed by the app frontend after in-chat user approval; it is not directly callable over MCP',
      }),
  );

  mcpServer.tool(
    'read_terminal_output',
    'Read incremental output of a terminal job started with start_terminal_command (use cursor from the previous call). Returns the job status, exit code, the output chunk and next_cursor.',
    {
      job_id: z.string().describe('Job id returned by start_terminal_command'),
      cursor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          'Absolute character offset from the previous read (0 = start)',
        ),
    },
    async ({ job_id, cursor }) => {
      try {
        const result = readTerminalJobFrom(job_id, cursor ?? 0);
        return mcpJson(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  mcpServer.tool(
    'kill_terminal_job',
    'Force-kill a running terminal job (process tree). No-op if the job already finished.',
    {
      job_id: z.string().describe('Job id returned by start_terminal_command'),
    },
    async ({ job_id }) => {
      try {
        return mcpJson({ ok: true, killed: killTerminalJob(job_id) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  mcpServer.tool(
    'memory_write',
    'Overwrite an existing preference/convention topic (not progress.md or annotated-files.md). Those two files are system-managed after the user confirms or saves annotations. Use for user conventions, labeling preferences, and corrections. File must already exist; use memory_create for a new topic. Keep content concise markdown.',
    {
      topic_file: z
        .string()
        .describe(
          'Existing preference topic filename, e.g. "conventions.md" (letters/digits/dash/underscore, must end with .md). Do not use progress.md or annotated-files.md.',
        ),
      content: z
        .string()
        .describe(
          'Full markdown content of the topic file (overwrites existing)',
        ),
      index_line: z
        .string()
        .describe(
          'One-line index entry describing this topic, e.g. "- [规范](topics/conventions.md)：框贴紧文字"',
        ),
    },
    async ({ topic_file, content, index_line }) => {
      try {
        const active = requireActiveWorkspaceMemory();
        if (!active.ok) return active.result;
        assertAgentWritableTopic(topic_file);
        await writeMemoryTopic({
          scopeKey: active.scopeKey,
          topicFile: topic_file,
          content,
          indexLine: index_line,
        });
        return mcpJson({
          ok: true,
          topic_file,
          scope: active.scopeKey,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  mcpServer.tool(
    'memory_create',
    'Create a preference/convention topic (not progress.md or annotated-files.md). Those two files are system-managed after the user confirms or saves annotations. Suggested names: conventions.md, preferences.md, feedback.md. Fails if the file already exists (use memory_write to update).',
    {
      topic_file: z
        .string()
        .describe(
          'New preference topic filename, e.g. "conventions.md" (letters/digits/dash/underscore, must end with .md). Do not use progress.md or annotated-files.md.',
        ),
      content: z
        .string()
        .describe('Full markdown content of the new topic file'),
      index_line: z
        .string()
        .describe(
          'One-line index entry describing this topic, e.g. "- [规范](topics/conventions.md)：框贴紧文字"',
        ),
    },
    async ({ topic_file, content, index_line }) => {
      try {
        const active = requireActiveWorkspaceMemory();
        if (!active.ok) return active.result;
        assertAgentWritableTopic(topic_file);
        await createMemoryTopic({
          scopeKey: active.scopeKey,
          topicFile: topic_file,
          content,
          indexLine: index_line,
        });
        return mcpJson({
          ok: true,
          created: true,
          topic_file,
          scope: active.scopeKey,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  return mcpServer;
}

async function createSession(): Promise<McpSession> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { transport, server });
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
    },
  });
  // 只清 map。不要在这里 server.close()：Protocol.close() 会再调 transport.close()，形成同步死递归。
  transport.onclose = () => {
    const { sessionId } = transport;
    if (sessionId) {
      sessions.delete(sessionId);
    }
  };
  await server.connect(transport);
  return { transport, server };
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = sessionIdFromRequest(req);
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (existing) {
    await existing.transport.handleRequest(req, res);
    return;
  }

  if (req.method === 'POST') {
    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
    if (parsedBody !== undefined && isInitializeRequest(parsedBody)) {
      const session = await createSession();
      try {
        await session.transport.handleRequest(req, res, parsedBody);
      } finally {
        if (!session.transport.sessionId) {
          void session.server.close();
        }
      }
      return;
    }
    sendJson(res, sessionId ? 404 : 400, {
      error: sessionId ? 'session_not_found' : 'missing_or_invalid_session',
    });
    return;
  }

  sendJson(res, sessionId ? 404 : 400, {
    error: sessionId ? 'session_not_found' : 'missing_session',
  });
}

/** 启动 Electron 本地 MCP Server，返回监听地址（不含 path） */
export async function startMcpServer(): Promise<string> {
  if (httpServer && listenPort) {
    return `http://127.0.0.1:${listenPort}`;
  }

  const port = await getFreePort();
  authToken = randomBytes(32).toString('hex');

  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/mcp') {
      if (!isTrustedMcpRequest(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (!hasValidBearerToken(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        await handleMcpRequest(req, res);
      } catch (err) {
        console.error('[MCP] Failed to handle /mcp request:', err);
        sendJson(res, 500, { error: 'internal_error' });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'lr-agent-local-mcp' }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer!.listen(port, '127.0.0.1', () => resolve());
    httpServer!.on('error', reject);
  });

  listenPort = port;
  console.log(`[MCP] Local MCP server started at http://127.0.0.1:${port}/mcp`);
  return `http://127.0.0.1:${port}`;
}

/** 停止 MCP Server */
export function stopMcpServer(): void {
  const active = [...sessions.values()];
  sessions.clear();
  for (const { server } of active) {
    void server.close();
  }
  if (httpServer) {
    httpServer.closeAllConnections?.();
    httpServer.close();
    httpServer = null;
    listenPort = null;
    authToken = null;
  }
}

/** 获取当前 MCP Server URL（未启动时返回 null） */
export function getMcpServerUrl(): string | null {
  if (listenPort) return `http://127.0.0.1:${listenPort}`;
  return null;
}

/** 获取当前 MCP Server 访问 token（未启动时返回 null） */
export function getMcpServerToken(): string | null {
  return authToken;
}
