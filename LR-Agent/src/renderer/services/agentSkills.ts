/**
 * 全局 Agent Skills 前端服务：
 * 经主进程 IPC 扫描 ~/.agents/skills，带短 TTL 内存缓存。
 */

import type {
  AgentSkillEntry,
  AgentSkillInventoryItem,
  AgentSkillStatus,
} from '../../shared/agentTypes';

const CACHE_TTL_MS = 30_000;

type SkillsBridge = {
  electron?: {
    skills?: {
      listCatalog?: () => Promise<unknown>;
      listInventory?: (force?: boolean) => Promise<unknown>;
      openRoot?: () => Promise<string>;
      reveal?: (dirName: string) => Promise<string>;
      setHidden?: (dirName: string, hidden: boolean) => Promise<unknown>;
    };
  };
};

let catalogCache: { value: AgentSkillEntry[]; loadedAt: number } | null = null;
let inventoryCache: {
  value: AgentSkillInventoryItem[];
  loadedAt: number;
} | null = null;

function skillsBridge() {
  return (window as Window & typeof globalThis & SkillsBridge).electron?.skills;
}

function isSkillEntry(value: unknown): value is AgentSkillEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as AgentSkillEntry;
  return (
    typeof entry.name === 'string' && typeof entry.description === 'string'
  );
}

const STATUSES = new Set<AgentSkillStatus>([
  'available',
  'disabled',
  'hidden',
  'invalid',
]);

function isInventoryItem(value: unknown): value is AgentSkillInventoryItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as AgentSkillInventoryItem;
  return (
    typeof item.dirName === 'string' &&
    typeof item.name === 'string' &&
    typeof item.description === 'string' &&
    STATUSES.has(item.status) &&
    Array.isArray(item.files)
  );
}

/**
 * 加载全局 skills catalog。扫描失败或不可用时返回空数组（不阻塞消息发送）。
 */
export async function loadSkillsCatalog(): Promise<AgentSkillEntry[]> {
  if (catalogCache && Date.now() - catalogCache.loadedAt < CACHE_TTL_MS) {
    return catalogCache.value;
  }

  const bridge = skillsBridge();
  if (!bridge?.listCatalog) return [];

  try {
    const raw = await bridge.listCatalog();
    const entries = Array.isArray(raw)
      ? raw.filter(isSkillEntry).map((e) => ({
          name: e.name,
          description: e.description,
          scope: 'user' as const,
        }))
      : [];
    catalogCache = { value: entries, loadedAt: Date.now() };
    return entries;
  } catch {
    return [];
  }
}

export async function loadSkillsInventory(
  force = false,
): Promise<AgentSkillInventoryItem[]> {
  if (force) {
    catalogCache = null;
    inventoryCache = null;
  } else if (
    inventoryCache &&
    Date.now() - inventoryCache.loadedAt < CACHE_TTL_MS
  ) {
    return inventoryCache.value;
  }

  const bridge = skillsBridge();
  if (!bridge?.listInventory) return [];

  try {
    const raw = await bridge.listInventory(force);
    const items = Array.isArray(raw)
      ? raw.filter(isInventoryItem).map((item) => ({
          dirName: item.dirName,
          name: item.name,
          description: item.description,
          scope: 'user' as const,
          status: item.status,
          reason: item.reason,
          files: item.files.filter(
            (file): file is string => typeof file === 'string',
          ),
          path: typeof item.path === 'string' ? item.path : '',
        }))
      : [];
    inventoryCache = { value: items, loadedAt: Date.now() };
    return items;
  } catch {
    return [];
  }
}

export async function openSkillsRoot(): Promise<void> {
  await skillsBridge()
    ?.openRoot?.()
    .catch(() => undefined);
}

export async function revealSkill(dirName: string): Promise<void> {
  await skillsBridge()
    ?.reveal?.(dirName)
    .catch(() => undefined);
}

/**
 * 停用 / 启用某个 skill（只写本应用的清单，不动磁盘文件）。
 * 成功后清空本地缓存并返回主进程刷新的清单，失败返回空数组由调用方 refresh。
 */
export async function setSkillHidden(
  dirName: string,
  hidden: boolean,
): Promise<AgentSkillInventoryItem[]> {
  const bridge = skillsBridge();
  if (!bridge?.setHidden) return [];
  try {
    const raw = await bridge.setHidden(dirName, hidden);
    clearSkillsCatalogCache();
    return Array.isArray(raw) ? raw.filter(isInventoryItem) : [];
  } catch {
    return [];
  }
}

/** 清空缓存（测试或 skill 目录变更后调用） */
export function clearSkillsCatalogCache(): void {
  catalogCache = null;
  inventoryCache = null;
}
