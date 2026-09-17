import { describe, expect, it, jest, beforeEach } from '@jest/globals';

import {
  attachDocumentToEditor,
  getSavedText,
  isDocumentDirty,
  markDocumentSaved,
  openDocument,
  resetEditorDocumentStoreForTests,
  saveDocumentViewState,
} from './editorDocumentStore';

jest.mock('monaco-editor/esm/vs/editor/editor.api', () => {
  const models = new Map<string, { value: string; language: string }>();

  class TextModel {
    uri = { path: '' };

    constructor(
      public value: string,
      public language: string,
      uri: { path: string },
    ) {
      this.uri = uri;
    }

    getValue() {
      return this.value;
    }

    setValue(next: string) {
      this.value = next;
    }

    dispose() {
      models.delete(this.uri.path);
    }
  }

  return {
    Uri: {
      file: (path: string) => ({ path }),
    },
    editor: {
      getModel: (uri: { path: string }) => {
        const data = models.get(uri.path);
        if (!data) return null;
        return new TextModel(data.value, data.language, uri);
      },
      createModel: (value: string, language: string, uri: { path: string }) => {
        models.set(uri.path, { value, language });
        return new TextModel(value, language, uri);
      },
      setModelLanguage: jest.fn(),
    },
  };
});

describe('editorDocumentStore', () => {
  beforeEach(() => {
    resetEditorDocumentStoreForTests();
  });

  it('tracks dirty state against saved baseline', () => {
    openDocument('/a.ts', 'hello');
    expect(isDocumentDirty('/a.ts')).toBe(false);

    const model = openDocument('/a.ts', 'hello world');
    model.setValue('hello world');
    expect(isDocumentDirty('/a.ts')).toBe(true);

    markDocumentSaved('/a.ts');
    expect(isDocumentDirty('/a.ts')).toBe(false);
    expect(getSavedText('/a.ts')).toBe('hello world');
  });

  it('does not re-attach when same document is already active', () => {
    const model = openDocument('/a.ts', 'line1');
    const editor = {
      currentModel: model,
      getModel() {
        return this.currentModel;
      },
      setModel(next: unknown) {
        this.currentModel = next as typeof model;
      },
      saveViewState: jest.fn(() => ({ scrollTop: 1 })),
      restoreViewState: jest.fn(),
    };

    attachDocumentToEditor(editor as never, '/a.ts', model as never, '/a.ts');

    const setModel = jest.spyOn(editor, 'setModel');
    const restore = jest.spyOn(editor, 'restoreViewState');

    const result = attachDocumentToEditor(
      editor as never,
      '/a.ts',
      model as never,
      '/a.ts',
    );

    expect(result.switched).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('saves view state when switching away and restores on return', () => {
    const modelA = openDocument('/a.ts', 'a');
    const modelB = openDocument('/b.ts', 'b');
    const editor = {
      currentModel: modelA,
      getModel() {
        return this.currentModel;
      },
      setModel(next: unknown) {
        this.currentModel = next as typeof modelA;
      },
      saveViewState: jest.fn(() => ({ scrollTop: 42 })),
      restoreViewState: jest.fn(),
    };

    attachDocumentToEditor(editor as never, '/a.ts', modelA as never, '');
    saveDocumentViewState('/a.ts', editor as never);

    attachDocumentToEditor(editor as never, '/b.ts', modelB as never, '/a.ts');

    expect(editor.saveViewState).toHaveBeenCalled();

    editor.restoreViewState.mockClear();
    attachDocumentToEditor(editor as never, '/a.ts', modelA as never, '/b.ts');

    expect(editor.restoreViewState).toHaveBeenCalledWith({ scrollTop: 42 });
  });
});
