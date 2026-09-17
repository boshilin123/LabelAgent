import {
  loadReportImageBlobUrl,
  resolveReportImageAbsolutePath,
} from '../reportImageResolver';

describe('reportImageResolver', () => {
  it('resolveReportImageAbsolutePath joins report root with charts path', () => {
    const root = 'D:/project/.lr-agent/quality-reports/run-1';
    expect(resolveReportImageAbsolutePath(root, 'charts/coverage.png')).toBe(
      'D:/project/.lr-agent/quality-reports/run-1/charts/coverage.png',
    );
  });

  it('resolveReportImageAbsolutePath avoids double charts segment', () => {
    const root = 'D:/project/.lr-agent/quality-reports/run-1';
    const resolved = resolveReportImageAbsolutePath(
      root,
      'charts/coverage.png',
    );
    expect(resolved).not.toContain('charts/charts');
  });

  it('resolveReportImageAbsolutePath returns null for traversal', () => {
    expect(
      resolveReportImageAbsolutePath('/tmp/run', '../secret.png'),
    ).toBeNull();
  });
});

describe('loadReportImageBlobUrl', () => {
  it('returns null when fs is unavailable', async () => {
    const original = window.electron;
    (window as unknown as { electron?: unknown }).electron = undefined;
    await expect(loadReportImageBlobUrl('/tmp/x.png')).resolves.toBeNull();
    (window as unknown as { electron?: unknown }).electron = original;
  });
});
