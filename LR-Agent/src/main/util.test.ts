import path from 'path';
import { pathToFileURL } from 'url';
import { isAppOwnedNavigation } from './util';

describe('isAppOwnedNavigation', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('allows same-origin app routes in development', () => {
    process.env.NODE_ENV = 'development';
    expect(isAppOwnedNavigation('http://localhost:1212/')).toBe(true);
    expect(isAppOwnedNavigation('http://localhost:1212/auth')).toBe(true);
    expect(isAppOwnedNavigation('http://localhost:1212/index.html')).toBe(true);
    expect(isAppOwnedNavigation('https://example.com/docs')).toBe(false);
  });

  it('only allows file: urls inside the renderer directory in production', () => {
    process.env.NODE_ENV = 'production';
    const appRoot = path.resolve(__dirname, '../renderer/');
    const insideUrl = pathToFileURL(path.join(appRoot, 'index.html')).href;
    expect(isAppOwnedNavigation(insideUrl)).toBe(true);
    // 任意的本机文件不再视为应用自身导航
    expect(isAppOwnedNavigation('file:///C:/app/index.html')).toBe(false);
    expect(isAppOwnedNavigation('file:///etc/passwd')).toBe(false);
    expect(isAppOwnedNavigation('https://example.com')).toBe(false);
  });
});
