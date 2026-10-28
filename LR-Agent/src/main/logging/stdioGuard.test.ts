/** @jest-environment node */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import { describe, expect, it, jest } from '@jest/globals';
import ts from 'typescript';
import { installStdioGuards } from './stdioGuard';

function streamError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`test ${code}`), { code });
}

function recordingStream(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, chunks };
}

describe('installStdioGuards', () => {
  it('preserves ordinary writes and their callbacks', async () => {
    const { stream, chunks } = recordingStream();
    installStdioGuards([stream]);
    await new Promise<void>((resolve, reject) => {
      expect(
        stream.write('ordinary log', (error) => {
          if (error) reject(error);
          else resolve();
        }),
      ).toBe(true);
    });
    expect(chunks).toEqual(['ordinary log']);
  });

  it.each(['EPIPE', 'ERR_STREAM_DESTROYED'])(
    'handles synchronous %s and drops later writes with asynchronous callbacks',
    async (code) => {
      const { stream } = recordingStream();
      const originalWrite = jest
        .spyOn(stream, 'write')
        .mockImplementation(() => {
          throw streamError(code);
        });
      installStdioGuards([stream]);
      let synchronous = true;
      const firstCallback = new Promise<void>((resolve) => {
        expect(
          stream.write('broken pipe', (error) => {
            expect(synchronous).toBe(false);
            expect(error).toBeUndefined();
            resolve();
          }),
        ).toBe(true);
      });
      synchronous = false;
      await firstCallback;
      const callback = jest.fn();
      expect(stream.write('discarded', 'utf8', callback)).toBe(true);
      expect(callback).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => process.nextTick(resolve));
      expect(callback).toHaveBeenCalledTimes(1);
      expect(originalWrite).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['EPIPE', 'ERR_STREAM_DESTROYED'])(
    'handles asynchronous %s without calling the original writer afterward',
    async (code) => {
      const { stream, chunks } = recordingStream();
      const originalWrite = jest.spyOn(stream, 'write');
      installStdioGuards([stream]);
      expect(() => stream.emit('error', streamError(code))).not.toThrow();
      await new Promise<void>((resolve) => {
        stream.write('discarded', (error) => {
          expect(error).toBeUndefined();
          resolve();
        });
      });
      expect(originalWrite).not.toHaveBeenCalled();
      expect(chunks).toEqual([]);
    },
  );

  it('keeps stderr usable when stdout has failed', () => {
    const stdout = recordingStream();
    const stderr = recordingStream();
    installStdioGuards([stdout.stream, stderr.stream]);
    stdout.stream.emit('error', streamError('EPIPE'));
    stdout.stream.write('discarded stdout');
    stderr.stream.write('independent stderr');
    expect(stdout.chunks).toEqual([]);
    expect(stderr.chunks).toEqual(['independent stderr']);
  });

  it('does not swallow unrelated synchronous writer failures', () => {
    const { stream } = recordingStream();
    const failure = streamError('EACCES');
    jest.spyOn(stream, 'write').mockImplementation(() => {
      throw failure;
    });
    installStdioGuards([stream]);
    expect(() => stream.write('log')).toThrow(failure);
  });

  it('does not swallow unrelated asynchronous stream errors', () => {
    const { stream } = recordingStream();
    const failure = streamError('ENOSPC');
    installStdioGuards([stream]);
    expect(() => stream.emit('error', failure)).toThrow(failure);
  });

  it('is idempotent for a stream shared by multiple installers', () => {
    const { stream } = recordingStream();
    const initialListeners = stream.listenerCount('error');
    installStdioGuards([stream]);
    const guardedWrite = stream.write;
    installStdioGuards([stream, stream]);
    expect(stream.listenerCount('error')).toBe(initialListeners + 1);
    expect(stream.write).toBe(guardedWrite);
  });
});

type PipeCaseResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  messages: Array<{ type: string; code?: string; value?: number }>;
  stderr: string;
};

async function runClosedPipeCase(
  channel: 'stdout' | 'stderr',
  guarded: boolean,
): Promise<PipeCaseResult> {
  const compiled = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, 'stdioGuard.ts'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  // Independent IPC keeps the handshake and evidence available after stdio closes.
  // ignoreErrors:false supplies an explicit failing Node Console baseline;
  // Node's ordinary global console can otherwise hide pipe write errors itself.
  const childSource = `
    const { Console } = require('console');
    const channel = ${JSON.stringify(channel)};
    const target = process[channel];
    const guarded = ${JSON.stringify(guarded)};
    const compiled = ${JSON.stringify(compiled)};
    const moduleObject = { exports: {} };
    if (guarded) {
      new Function('exports', 'require', 'module', compiled)(
        moduleObject.exports, require, moduleObject);
      moduleObject.exports.installStdioGuards();
    }
    const logger = new Console({ stdout: process.stdout,
      stderr: process.stderr, ignoreErrors: false });
    process.on('uncaughtExceptionMonitor', error => {
      process.send({ type: 'uncaught', code: error.code });
    });
    let timer;
    let completed = false;
    if (guarded) target.on('error', error => {
      process.send({ type: 'pipe-error', code: error.code });
      if (completed) return;
      completed = true;
      clearInterval(timer);
      setTimeout(() => {
        target.write('another log after pipe failure', () => {
          process.send({ type: 'task-completed', value: 2 + 3 }, () => {
            process.disconnect();
            process.exit(0);
          });
        });
      }, 25);
    });
    process.on('message', message => {
      if (message !== 'reader-closed') return;
      process.send({ type: 'writing' });
      let attempts = 0;
      timer = setInterval(() => {
        attempts += 1;
        if (channel === 'stdout') logger.log('x'.repeat(65536));
        else logger.error('x'.repeat(65536));
        if (attempts >= 200) {
          clearInterval(timer);
          process.send({ type: 'pipe-not-observed' }, () => process.exit(4));
        }
      }, 5);
    });
    process.send({ type: 'ready' });
  `;

  return new Promise<PipeCaseResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childSource], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const result: PipeCaseResult = {
      code: null,
      signal: null,
      messages: [],
      stderr: '',
    };
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(`closed ${channel} case timed out (guarded=${guarded})`),
      );
    }, 10_000);
    child.stderr?.on('data', (data: Buffer) => {
      result.stderr += data.toString();
    });
    child.on('message', (message: PipeCaseResult['messages'][number]) => {
      result.messages.push(message);
      if (message.type === 'ready') {
        const reader = channel === 'stdout' ? child.stdout : child.stderr;
        if (!reader) {
          child.kill();
          reject(new Error(`missing ${channel} reader`));
          return;
        }
        reader.once('close', () => child.send('reader-closed'));
        reader.destroy();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      child.kill();
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      result.code = code;
      result.signal = signal;
      resolve(result);
    });
  });
}

describe('real OS pipe closure', () => {
  it.each(['stdout', 'stderr'] as const)(
    '%s reproduces EPIPE without guards and completes a later task with guards',
    async (channel) => {
      const baseline = await runClosedPipeCase(channel, false);
      expect(baseline.code).not.toBe(0);
      expect(baseline.messages).toContainEqual({
        type: 'uncaught',
        code: 'EPIPE',
      });
      expect(baseline.messages).not.toContainEqual({
        type: 'task-completed',
        value: 5,
      });

      const guarded = await runClosedPipeCase(channel, true);
      expect(guarded.messages).toContainEqual({
        type: 'pipe-error',
        code: 'EPIPE',
      });
      expect(guarded.messages).toContainEqual({
        type: 'task-completed',
        value: 5,
      });
      expect(guarded.code).toBe(0);
      expect(guarded.signal).toBeNull();
    },
    30_000,
  );
});
