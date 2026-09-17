/**
 * 下载 python-build-standalone 嵌入式运行时（Windows x64，install_only）。
 *
 * 供 Electron 打包使用：解包到 assets/python-runtime/py312，
 * 随 extraResources 分发到 resources/python-runtime/。运行时二进制不提交
 * git（见 .gitignore），本脚本入库，`npm run package` 前会自动执行。
 *
 * 用法: node scripts/fetchPythonRuntimes.mjs [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TARGETS = [{ version: '3.12', dir: 'py312' }];
const ASSET_PATTERN = (version) =>
  new RegExp(
    '^cpython-' +
      version.replace(/\./g, '\\.') +
      '\\.\\d+(?:\\+\\d{8})?-x86_64-pc-windows-msvc-install_only\\.tar\\.gz$',
  );
const RELEASE_API =
  'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'assets', 'python-runtime');
const force = process.argv.includes('--force');
const isWin32 = process.platform === 'win32';

if (!isWin32) {
  console.error(
    `本脚本仅支持在 Windows 上为 Windows x64 产物准备运行时（当前平台: ${process.platform}）。` +
      '其他平台沿用 conda/系统 Python 发现，无需嵌入式运行时。',
  );
  process.exit(1);
}

function githubHeaders(url) {
  const headers = { 'User-Agent': 'lr-agent-fetch-python-runtimes' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token && new URL(url).hostname === 'api.github.com') {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: githubHeaders(url),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

async function downloadTo(asset, destPath) {
  console.log(`下载 ${asset.name} ...`);
  const res = await fetch(asset.browser_download_url, {
    headers: githubHeaders(asset.browser_download_url),
  });
  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status} — ${asset.name}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  console.log(`  完成 (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

function* walkFiles(dir, extension) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, extension);
    } else if (entry.name.toLowerCase().endsWith(extension)) {
      yield full;
    }
  }
}

async function main() {
  const release = await fetchJson(RELEASE_API);
  const assets = release.assets ?? [];

  for (const { version, dir } of TARGETS) {
    const destDir = path.join(outputRoot, dir);
    const pythonExe = path.join(destDir, 'python.exe');
    if (!force && fs.existsSync(pythonExe)) {
      console.log(`${dir}: 已存在，跳过（--force 可重取）`);
      continue;
    }

    const asset = assets.find((a) => ASSET_PATTERN(version).test(a.name));
    if (!asset) {
      throw new Error(
        `${version}: 未在 latest release 中找到 x86_64-pc-windows-msvc install_only 资产`,
      );
    }

    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });

    const archivePath = path.join(outputRoot, `tmp-${asset.name}`);
    // 顺序下载以降低峰值内存/带宽（每个包 ~25MB）
    // eslint-disable-next-line no-await-in-loop
    await downloadTo(asset, archivePath);

    // install_only 包顶层为 python/ 目录，剥掉一层直接铺开。
    // 用相对路径调用 tar：Windows bsdtar 会把含盘符的绝对路径误判为远程主机
    const tar = spawnSync(
      'tar',
      [
        '-xf',
        path.basename(archivePath),
        '-C',
        path.relative(outputRoot, destDir),
        '--strip-components=1',
      ],
      { cwd: outputRoot, stdio: 'inherit' },
    );
    fs.rmSync(archivePath, { force: true });
    if (tar.status !== 0) {
      throw new Error(`${version}: tar 解包失败 (exit ${tar.status})`);
    }
    if (!fs.existsSync(pythonExe)) {
      throw new Error(`${version}: 解包后未找到 python.exe: ${pythonExe}`);
    }

    // 删掉 PDB 调试符号（约 80MB/版本），纯运行时用不到
    for (const pdb of walkFiles(destDir, '.pdb')) {
      fs.rmSync(pdb, { force: true });
    }
    console.log(`${version}: 完成 → ${destDir}`);
  }

  console.log('全部运行时就绪。打包时可通过 resources/python-runtime 访问。');
}

main().catch((err) => {
  console.error(`[fetchPythonRuntimes] ${err.message}`);
  process.exit(1);
});
