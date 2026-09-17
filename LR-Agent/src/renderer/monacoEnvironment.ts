/**
 * Worker filenames from monaco-editor-webpack-plugin template `[name].worker.js`.
 * For entry `vs/language/json/json.worker`, [name] resolves to `json` → `json.worker.js`.
 */
const MONACO_WORKER_FILES: Record<string, string> = {
  editorWorkerService: 'editor.worker.js',
  json: 'json.worker.js',
  typescript: 'ts.worker.js',
  javascript: 'ts.worker.js',
  html: 'html.worker.js',
  handlebars: 'html.worker.js',
  razor: 'html.worker.js',
  css: 'css.worker.js',
  scss: 'css.worker.js',
  less: 'css.worker.js',
};

/** Must match webpack renderer `output.publicPath` (dev: `/`, prod: `./`). */
const MONACO_WORKER_PUBLIC_PATH =
  process.env.NODE_ENV === 'development' ? '/' : './';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function buildWorkerUrl(label: string): string {
  const pathPrefix = stripTrailingSlash(MONACO_WORKER_PUBLIC_PATH);
  const workerFile =
    MONACO_WORKER_FILES[label] ?? MONACO_WORKER_FILES.editorWorkerService;
  const result = pathPrefix ? `${pathPrefix}/${workerFile}` : `/${workerFile}`;

  if (/^((http:)|(https:)|(file:)|(\/\/))/.test(result)) {
    const currentUrl = String(window.location);
    const currentOrigin = currentUrl.substr(
      0,
      currentUrl.length -
        window.location.hash.length -
        window.location.search.length -
        window.location.pathname.length,
    );
    if (result.substring(0, currentOrigin.length) !== currentOrigin) {
      const resolved = /^(\/\/)/.test(result)
        ? window.location.protocol + result
        : result;
      const js = `/*${label}*/importScripts("${resolved}");`;
      const blob = new Blob([js], { type: 'application/javascript' });
      return URL.createObjectURL(blob);
    }
  }

  return result;
}

export function installMonacoEnvironment(): void {
  if (typeof self === 'undefined') return;

  const existing = self.MonacoEnvironment ?? {};
  if (existing.getWorker) return;

  self.MonacoEnvironment = {
    ...existing,
    /**
     * Classic Worker matches webpack WebWorkerTemplatePlugin output.
     * Monaco prefers getWorker over getWorkerUrl (avoids `{ type: 'module' }`).
     */
    getWorker(_moduleId: string, label: string) {
      const url = buildWorkerUrl(label);
      return new Worker(url, { name: label });
    },
  };
}
