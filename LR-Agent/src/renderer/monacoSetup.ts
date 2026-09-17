import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { installMonacoEnvironment } from './monacoEnvironment';

installMonacoEnvironment();

monaco.editor.defineTheme('lr-agent-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1e1e1e',
    // diff 行用统一的浅色整行底色；字符级高亮与行号槽条纹透明，
    // 避免"有字的地方更深"的花斑和 +/- 指示符杂色
    'diffEditor.insertedLineBackground': '#3fb95026',
    'diffEditor.removedLineBackground': '#f8514926',
    'diffEditor.insertedTextBackground': '#00000000',
    'diffEditor.removedTextBackground': '#00000000',
    'diffEditorGutter.insertedLineBackground': '#00000000',
    'diffEditorGutter.removedLineBackground': '#00000000',
  },
});

monaco.editor.defineTheme('lr-agent-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'diffEditor.insertedLineBackground': '#3fb9501f',
    'diffEditor.removedLineBackground': '#f851491f',
    'diffEditor.insertedTextBackground': '#00000000',
    'diffEditor.removedTextBackground': '#00000000',
    'diffEditorGutter.insertedLineBackground': '#00000000',
    'diffEditorGutter.removedLineBackground': '#00000000',
  },
});
