/**
 * 主进程侧"授权根目录"集合。
 *
 * 渲染层可写入的目录必须是用户显式选择/打开过的根（对话框、工作区、标注项目），
 * 避免 XSS 场景下通过 workspace:* 写盘接口向任意路径落文件。
 */
import path from 'path';

const authorizedRoots = new Set<string>();

/** 记录一个授权根目录（幂等；非字符串或非法路径直接忽略） */
export function authorizeRoot(dirPath: unknown): void {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return;
  try {
    authorizedRoots.add(path.resolve(dirPath));
  } catch {
    // 非法路径直接忽略
  }
}

/** target 是否位于任一授权根目录之下（含根本身） */
export function isWithinAuthorizedRoot(target: unknown): boolean {
  if (typeof target !== 'string' || !target.trim()) return false;
  let resolved: string;
  try {
    resolved = path.resolve(target);
  } catch {
    return false;
  }
  for (const root of authorizedRoots) {
    const rel = path.relative(root, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}
