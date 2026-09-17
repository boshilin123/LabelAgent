/**
 * 日常快启：1212 已有 dev server 时只开 Electron；否则走完整 dev 链。
 * 用法: npm run dev:open
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const detectPort = require('detect-port');

const PORT = Number(process.env.PORT || 1212);
const DLL = path.join(__dirname, '../dll');
const REQUIRED = ['main.bundle.dev.js', 'preload.js'];

const env = {
  ...process.env,
  NODE_ENV: 'development',
  SKIP_DEVTOOLS: '1',
};

function runNpm(script) {
  const child = spawn('npm', ['run', script], {
    shell: true,
    stdio: 'inherit',
    env,
  });
  child.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
  return child;
}

function dllReady() {
  return REQUIRED.every((f) => fs.existsSync(path.join(DLL, f)));
}

detectPort(PORT, (err, available) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  if (available === PORT) {
    console.log(
      `[dev:open] 端口 ${PORT} 空闲 → 启动完整开发链 (renderer + Electron)`,
    );
    console.log(
      '提示: 下次若 dev server 未关，可直接 npm run dev:open 只开窗口\n',
    );
    runNpm('dev');
    return;
  }

  if (!dllReady()) {
    const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(DLL, f)));
    console.error(
      '[dev:open] 缺少 .erb/dll 产物，请先执行一次: npm run dev\n' +
        `缺少: ${missing.join(', ')}`,
    );
    process.exit(1);
  }

  console.log(
    `[dev:open] 端口 ${PORT} 已就绪 → 仅启动 Electron (main/preload watch)`,
  );
  runNpm('start:main');
});
