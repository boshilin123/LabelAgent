/**
 * CI 后续安装冒烟：复刻向导的 venv / pip / verify，不启动 Electron。
 *
 * 与 src/main/env/envInstaller.ts 保持字面同步：
 *   SAM2_GIT_URL / SAM2_ARCHIVE_URL / TORCH_CPU_INDEX / VERIFY_IMPORTS
 *
 * 用法: node scripts/ciInstallAndTest.mjs
 * 前置: 已执行 npm run fetch-python-runtimes（assets/python-runtime/py312）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SAM2_GIT_URL = 'git+https://github.com/facebookresearch/sam2.git';
const SAM2_ARCHIVE_URL =
  'SAM-2 @ https://github.com/facebookresearch/sam2/archive/refs/heads/main.zip';
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';
const VERIFY_IMPORTS = {
  'local-agent': 'fastapi, uvicorn, langchain_core',
  inference: 'torch, torchvision, ultralytics, cv2, PIL, sam2',
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, 'assets', 'python-runtime');
const venvRoot = path.join(root, '.ci-venvs');

function sanitizeRequirements(content) {
  const lines = [];
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    lines.push(line.includes(SAM2_GIT_URL) ? SAM2_ARCHIVE_URL : line);
  }
  return lines.join('\n');
}

function run(python, args, cwd, label) {
  console.log(`\n=== ${label} ===`);
  console.log(`> ${python} ${args.join(' ')}`);
  const result = spawnSync(python, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} 失败 (exit ${result.status})`);
  }
}

function venvPython(venvDir) {
  return path.join(venvDir, 'Scripts', 'python.exe');
}

function ensureRuntime(versionDir) {
  const pythonExe = path.join(runtimeRoot, versionDir, 'python.exe');
  if (!fs.existsSync(pythonExe)) {
    throw new Error(
      `嵌入式运行时未就绪: ${pythonExe}。请先运行 npm run fetch-python-runtimes`,
    );
  }
  return pythonExe;
}

function createVenv(runtimePython, venvDir, label) {
  fs.rmSync(venvDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(venvDir), { recursive: true });
  run(runtimePython, ['-m', 'venv', venvDir], root, `${label}: 创建 venv`);
  const python = venvPython(venvDir);
  if (!fs.existsSync(python)) {
    throw new Error(`${label}: venv 创建后未找到 ${python}`);
  }
  run(python, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], root, `${label}: 升级 pip`);
  return python;
}

function installLocalAgent() {
  const runtimePython = ensureRuntime('py312');
  const venvDir = path.join(venvRoot, 'local-agent');
  const python = createVenv(runtimePython, venvDir, 'local-agent');
  const requirements = path.join(root, 'vendor', 'local-agent', 'requirements.txt');
  if (!fs.existsSync(requirements)) {
    throw new Error(`依赖清单不存在: ${requirements}`);
  }
  run(
    python,
    ['-m', 'pip', 'install', '-r', requirements],
    root,
    'local-agent: pip install',
  );
  run(
    python,
    ['-c', `import ${VERIFY_IMPORTS['local-agent']}; print('verify ok')`],
    root,
    'local-agent: import verify',
  );
  run(
    python,
    ['-m', 'pytest'],
    path.join(root, 'vendor', 'local-agent'),
    'local-agent: pytest',
  );
}

function installInference() {
  const runtimePython = ensureRuntime('py312');
  const venvDir = path.join(venvRoot, 'inference');
  const python = createVenv(runtimePython, venvDir, 'inference');
  const requirements = path.join(
    root,
    'vendor',
    'inference',
    'requirements-cpu.txt',
  );
  if (!fs.existsSync(requirements)) {
    throw new Error(`依赖清单不存在: ${requirements}`);
  }
  const prepared = path.join(venvRoot, 'inference-requirements.txt');
  fs.writeFileSync(
    prepared,
    sanitizeRequirements(fs.readFileSync(requirements, 'utf8')),
    'utf8',
  );
  run(
    python,
    [
      '-m',
      'pip',
      'install',
      '-r',
      prepared,
      '--extra-index-url',
      TORCH_CPU_INDEX,
    ],
    root,
    'inference: pip install (cpu)',
  );
  run(
    python,
    ['-c', `import ${VERIFY_IMPORTS.inference}; print('verify ok')`],
    root,
    'inference: import verify',
  );
}

function main() {
  installLocalAgent();
  installInference();
  console.log('\n后续安装冒烟全部通过。');
}

try {
  main();
} catch (err) {
  console.error(`[ciInstallAndTest] ${err.message}`);
  process.exit(1);
}
