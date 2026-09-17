/**
 * 危险可执行/脚本扩展名（跨主进程与渲染层共用）。
 *
 * 用途：
 *   - shell:openPath 拒绝用系统默认程序打开这些类型（避免"写脚本再打开执行"链路）
 *   - 工作区文本写盘白名单的兜底黑名单
 */

const DANGEROUS_EXTENSIONS = new Set([
  'exe',
  'com',
  'scr',
  'pif',
  'cpl',
  'msi',
  'msp',
  'mst',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'psd1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'jar',
  'reg',
  'lnk',
  'url',
  'chm',
  'dll',
  'sys',
  'drv',
  'gadget',
  'application',
  'appref-ms',
  'shb',
  'shs',
  'scf',
  'inf',
]);

function extensionOf(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function isDangerousExecutable(filePath: string): boolean {
  return DANGEROUS_EXTENSIONS.has(extensionOf(filePath));
}
