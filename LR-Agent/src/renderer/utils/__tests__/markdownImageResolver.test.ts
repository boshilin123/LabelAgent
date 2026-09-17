import {
  isRemoteMarkdownImageSrc,
  loadMarkdownImageBlobUrl,
  resolveMarkdownImageAbsolutePath,
} from '../markdownImageResolver';

describe('markdownImageResolver', () => {
  it('isRemoteMarkdownImageSrc detects remote URLs', () => {
    expect(isRemoteMarkdownImageSrc('https://example.com/a.png')).toBe(true);
    expect(isRemoteMarkdownImageSrc('data:image/png;base64,abc')).toBe(true);
    expect(isRemoteMarkdownImageSrc('./images/a.png')).toBe(false);
  });

  it('resolveMarkdownImageAbsolutePath joins relative path with base dir', () => {
    expect(
      resolveMarkdownImageAbsolutePath('D:/project/docs', './images/foo.png'),
    ).toBe('D:/project/docs/images/foo.png');
  });

  it('resolveMarkdownImageAbsolutePath keeps absolute paths', () => {
    expect(
      resolveMarkdownImageAbsolutePath('D:/project/docs', 'D:/assets/logo.png'),
    ).toBe('D:/assets/logo.png');
  });

  it('resolveMarkdownImageAbsolutePath returns null for traversal', () => {
    expect(
      resolveMarkdownImageAbsolutePath('/tmp/docs', '../secret.png'),
    ).toBeNull();
  });

  it('resolveMarkdownImageAbsolutePath strips file:// prefix', () => {
    expect(
      resolveMarkdownImageAbsolutePath(
        'D:/project/docs',
        'file:///D:/project/docs/img.png',
      ),
    ).toBe('/D:/project/docs/img.png');
  });
});

describe('loadMarkdownImageBlobUrl', () => {
  it('returns null when fs is unavailable', async () => {
    const original = window.electron;
    (window as unknown as { electron?: unknown }).electron = undefined;
    await expect(loadMarkdownImageBlobUrl('/tmp/x.png')).resolves.toBeNull();
    (window as unknown as { electron?: unknown }).electron = original;
  });
});
