import {
  getLanguageForFile,
  getMonacoLanguageForFile,
  highlightMarkdownCode,
  normalizeMarkdownLanguage,
} from './syntaxHighlight';

describe('getLanguageForFile', () => {
  it('maps jsonl and dotfiles', () => {
    expect(getLanguageForFile('/ws/data/train.jsonl')).toBe('json');
    expect(getLanguageForFile('/ws/.env')).toBe('ini');
    expect(getLanguageForFile('/ws/.gitignore')).toBe('ini');
  });

  it('maps special filenames', () => {
    expect(getLanguageForFile('/ws/Dockerfile')).toBe('dockerfile');
    expect(getLanguageForFile('/ws/Makefile')).toBe('makefile');
  });

  it('maps monaco language ids', () => {
    expect(getMonacoLanguageForFile('/ws/app.ts')).toBe('typescript');
    expect(getMonacoLanguageForFile('/ws/script.ps1')).toBe('powershell');
    expect(getMonacoLanguageForFile('/ws/unknown.xyz')).toBe('plaintext');
  });
});

describe('normalizeMarkdownLanguage', () => {
  it('maps shell aliases to bash', () => {
    expect(normalizeMarkdownLanguage('shell')).toBe('bash');
    expect(normalizeMarkdownLanguage('sh')).toBe('bash');
    expect(normalizeMarkdownLanguage('console')).toBe('bash');
    expect(normalizeMarkdownLanguage('zsh')).toBe('bash');
  });

  it('returns null for plain text markers', () => {
    expect(normalizeMarkdownLanguage('text')).toBeNull();
    expect(normalizeMarkdownLanguage('plaintext')).toBeNull();
    expect(normalizeMarkdownLanguage('')).toBeNull();
  });

  it('passes through registered languages', () => {
    expect(normalizeMarkdownLanguage('python')).toBe('python');
    expect(normalizeMarkdownLanguage('js')).toBe('javascript');
  });
});

describe('highlightMarkdownCode', () => {
  it('highlights bash fenced code with hljs spans', () => {
    const html = highlightMarkdownCode('echo hi', 'bash');
    expect(html).toMatch(/hljs-/);
    expect(html).toContain('echo');
  });

  it('falls back to highlightAuto for unknown languages', () => {
    expect(() =>
      highlightMarkdownCode('const x = 1', 'not-a-real-language'),
    ).not.toThrow();
    const html = highlightMarkdownCode('const x = 1', 'not-a-real-language');
    expect(html).toContain('const');
  });

  it('uses highlightAuto when language is null', () => {
    const html = highlightMarkdownCode('print("hi")', null);
    expect(html).toContain('print');
  });
});
