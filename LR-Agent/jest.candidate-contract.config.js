/**
 * F1 专用 Jest 配置：只跑候选引擎（candidate）帧 → 渲染层状态的对照测试。
 *
 * 为什么需要独立配置：`package.json` 的 jest 配置把
 * `./.erb/scripts/check-build-exists.ts` 放进 setupFiles，而该脚本要求
 * `release/app/dist/{main,renderer}` 已构建。本验证是离线纯逻辑对照，
 * 不构建 Electron bundle，因此换成等价但不做构建断言的 setup 文件。
 *
 * 其余配置（moduleNameMapper / transform / testEnvironment / ts-jest）
 * 全部继承 `package.json`，保证跑的是真实渲染层代码。
 *
 * 用法（在 LR-Agent 目录下）：
 *   npx jest --config jest.candidate-contract.config.js
 */
const base = require('./package.json').jest;

module.exports = {
  ...base,
  rootDir: __dirname,
  setupFiles: ['./.erb/mocks/setupCandidateContract.ts'],
  testMatch: [
    '<rootDir>/src/renderer/services/agentCandidateContract.*.test.ts',
  ],
  testPathIgnorePatterns: [...(base.testPathIgnorePatterns ?? [])],
  // 该沙箱下 Node 子进程的管道 stdio 会被拒绝（spawn EPERM），
  // 因此全部在进程内跑：maxWorkers=1 让 jest-haste-map 不建 worker 池。
  maxWorkers: 1,
  verbose: true,
};
