/**
 * F1 候选引擎前端联调验证专用 setupFiles。
 *
 * 与仓库既有的 `./setupElectronMock.ts` 的唯一区别：**不**加载
 * `./.erb/scripts/check-build-exists.ts`。后者会断言
 * `release/app/dist/main/main.js` 与 `dist/renderer/renderer.js` 存在，
 * 而本验证只跑渲染层 service 的纯逻辑，不需要（也没有）已构建的 bundle。
 *
 * 除该断言外，环境与 `npm test` 完全一致：复用同一个 electron mock。
 */
import { TextEncoder, TextDecoder } from 'node:util';

// eslint-disable-next-line import/no-extraneous-dependencies
import './setupElectronMock';

// JSDOM 未实现 TextEncoder / TextDecoder（check-build-exists.ts 原本负责注入）
if (!(global as unknown as { TextEncoder?: unknown }).TextEncoder) {
  (global as unknown as { TextEncoder: unknown }).TextEncoder = TextEncoder;
}
if (!(global as unknown as { TextDecoder?: unknown }).TextDecoder) {
  (global as unknown as { TextDecoder: unknown }).TextDecoder = TextDecoder;
}

export {};
