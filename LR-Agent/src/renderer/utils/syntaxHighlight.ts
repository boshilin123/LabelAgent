import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { basename, getExtension } from '../types/file';

const EXT_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  ndjson: 'json',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  dockerfile: 'dockerfile',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  env: 'ini',
  editorconfig: 'ini',
  gitignore: 'ini',
  dockerignore: 'ini',
  rst: 'plaintext',
  csv: 'plaintext',
  tsv: 'plaintext',
  txt: 'plaintext',
  log: 'plaintext',
};

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.gitignore': 'ini',
  '.dockerignore': 'ini',
  '.env': 'ini',
  '.editorconfig': 'ini',
};

const MARKDOWN_LANGUAGE_ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  console: 'bash',
  zsh: 'bash',
  dockerfile: 'dockerfile',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  rb: 'ruby',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'c',
  jsonc: 'json',
  jsonl: 'json',
  ndjson: 'json',
  scss: 'css',
  sass: 'css',
  less: 'css',
};

let registered = false;

function ensureLanguagesRegistered(): void {
  if (registered) return;
  registered = true;

  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('java', java);
  hljs.registerLanguage('kotlin', kotlin);
  hljs.registerLanguage('c', c);
  hljs.registerLanguage('cpp', cpp);
  hljs.registerLanguage('csharp', csharp);
  hljs.registerLanguage('php', php);
  hljs.registerLanguage('ruby', ruby);
  hljs.registerLanguage('swift', swift);
  hljs.registerLanguage('lua', lua);
  hljs.registerLanguage('perl', perl);
  hljs.registerLanguage('r', r);
  hljs.registerLanguage('powershell', powershell);
  hljs.registerLanguage('ini', ini);
  hljs.registerLanguage('dockerfile', bash);
  hljs.registerLanguage('dos', bash);
  hljs.registerLanguage('makefile', bash);
}

function resolveFilenameLanguage(filePath: string): string | null {
  const name = basename(filePath);
  const lower = name.toLowerCase();
  if (FILENAME_TO_LANGUAGE[lower]) {
    return FILENAME_TO_LANGUAGE[lower];
  }
  if (lower.startsWith('dockerfile')) {
    return 'dockerfile';
  }
  return null;
}

export function getLanguageForFile(filePath: string): string | null {
  const byName = resolveFilenameLanguage(filePath);
  if (byName) return byName;
  const ext = getExtension(filePath);
  if (!ext) return null;
  return EXT_TO_LANGUAGE[ext] ?? null;
}

/** Monaco 语言 ID（未知时返回 plaintext） */
export function getMonacoLanguageForFile(filePath: string): string {
  const lang = getLanguageForFile(filePath);
  if (!lang || lang === 'plaintext') return 'plaintext';
  if (lang === 'dos') return 'bat';
  if (lang === 'makefile') return 'plaintext';
  if (lang === 'dockerfile') return 'dockerfile';
  return lang;
}

export function highlightCode(content: string, filePath: string): string {
  ensureLanguagesRegistered();

  const language = getLanguageForFile(filePath);
  if (language && language !== 'plaintext' && hljs.getLanguage(language)) {
    return hljs.highlight(content, { language }).value;
  }

  return hljs.highlightAuto(content).value;
}

export function normalizeMarkdownLanguage(lang: string): string | null {
  const trimmed = lang.trim().toLowerCase();
  if (!trimmed || trimmed === 'text' || trimmed === 'plaintext') {
    return null;
  }
  const aliased = MARKDOWN_LANGUAGE_ALIASES[trimmed] ?? trimmed;
  return aliased;
}

export function highlightMarkdownCode(
  content: string,
  language?: string | null,
): string {
  ensureLanguagesRegistered();

  const normalized = language ? normalizeMarkdownLanguage(language) : null;
  if (normalized && hljs.getLanguage(normalized)) {
    return hljs.highlight(content, { language: normalized }).value;
  }

  return hljs.highlightAuto(content).value;
}
