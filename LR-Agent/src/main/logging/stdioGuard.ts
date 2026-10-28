import type { Writable } from 'stream';

const guardedStreams = new WeakSet<Writable>();

function isClosedPipeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

/**
 * A detached launcher can close the desktop's console pipes while Python keeps
 * producing logs. Losing that diagnostic sink must not stop the Agent service.
 * Only closed-pipe errors are ignored; all other stream failures stay visible.
 */
export function installStdioGuards(
  streams: readonly Writable[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    if (guardedStreams.has(stream)) continue;
    guardedStreams.add(stream);

    const originalWrite = stream.write;
    let closed = false;

    const discardWrite = (args: unknown[]): boolean => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        process.nextTick(callback);
      }
      // Logging is best effort once the reader has gone. Do not leave callers
      // waiting for a drain event that can no longer arrive.
      return true;
    };

    stream.on('error', (error: Error) => {
      if (!isClosedPipeError(error)) throw error;
      closed = true;
    });

    stream.write = ((...args: unknown[]): boolean => {
      if (closed) return discardWrite(args);
      try {
        return Reflect.apply(originalWrite, stream, args);
      } catch (error) {
        if (!isClosedPipeError(error)) throw error;
        closed = true;
        return discardWrite(args);
      }
    }) as Writable['write'];
  }
}
