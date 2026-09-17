/** 并发任务向 async generator 推送事件的简易队列（fusion 式流式进度） */

export class AsyncEventQueue<T> {
  private queue: T[] = [];

  private resolvers: Array<(value: T | typeof CLOSED) => void> = [];

  private closed = false;

  push(item: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver(item);
    } else {
      this.queue.push(item);
    }
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length) {
      const r = this.resolvers.shift();
      r?.(CLOSED);
    }
  }

  async take(): Promise<T | null> {
    if (this.queue.length) {
      return this.queue.shift()!;
    }
    if (this.closed) {
      return null;
    }
    return new Promise((resolve) => {
      this.resolvers.push((value) => {
        if (value === CLOSED) {
          resolve(null);
        } else {
          resolve(value);
        }
      });
    });
  }
}

const CLOSED = Symbol('closed');
