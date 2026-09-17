/**
 * 项目级指令（.lragent/INSTRUCTIONS.md）读取服务：
 * 经主进程 IPC 读取，带短 TTL 内存缓存，避免每次发消息都读磁盘。
 */

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  content: string | null;
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

type MemoryBridge = {
  electron?: {
    memory?: {
      readInstructions?: (directoryPath: string) => Promise<string | null>;
    };
  };
};

/**
 * 读取指定目录下的项目指令。目录为空或读取失败时返回 null。
 */
export async function loadProjectInstructions(
  directoryPath: string | null | undefined,
): Promise<string | null> {
  const dir = directoryPath?.trim();
  if (!dir) return null;

  const cached = cache.get(dir);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.content;
  }

  const bridge = (window as Window & typeof globalThis & MemoryBridge).electron
    ?.memory;
  if (!bridge?.readInstructions) return null;

  try {
    const content = await bridge.readInstructions(dir);
    cache.set(dir, { content, loadedAt: Date.now() });
    return content;
  } catch {
    return null;
  }
}
