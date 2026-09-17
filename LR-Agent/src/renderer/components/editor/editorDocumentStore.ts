import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { getMonacoLanguageForFile } from '../../utils/syntaxHighlight';

interface EditorDocumentRecord {
  model: monaco.editor.ITextModel;
  savedText: string;
  viewState: monaco.editor.ICodeEditorViewState | null;
}

const documents = new Map<string, EditorDocumentRecord>();
const refCounts = new Map<string, number>();

function getLanguage(path: string): string {
  return getMonacoLanguageForFile(path);
}

export function hasDocument(filePath: string): boolean {
  return documents.has(filePath);
}

export function getDocumentModel(
  filePath: string,
): monaco.editor.ITextModel | null {
  return documents.get(filePath)?.model ?? null;
}

export function getSavedText(filePath: string): string {
  return documents.get(filePath)?.savedText ?? '';
}

export function isDocumentDirty(filePath: string): boolean {
  const record = documents.get(filePath);
  if (!record) return false;
  return record.model.getValue() !== record.savedText;
}

export function retainDocument(filePath: string): void {
  refCounts.set(filePath, (refCounts.get(filePath) ?? 0) + 1);
}

export function releaseDocument(filePath: string): void {
  const next = (refCounts.get(filePath) ?? 0) - 1;
  if (next <= 0) {
    refCounts.delete(filePath);
    disposeDocument(filePath);
  } else {
    refCounts.set(filePath, next);
  }
}

export function disposeDocument(filePath: string): void {
  const record = documents.get(filePath);
  if (!record) return;
  record.model.dispose();
  documents.delete(filePath);
}

export function syncDocumentRefCounts(
  prevTabs: ReadonlyArray<{ filePath: string }>,
  nextTabs: ReadonlyArray<{ filePath: string }>,
): void {
  const countByPath = (tabs: ReadonlyArray<{ filePath: string }>) => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      counts.set(tab.filePath, (counts.get(tab.filePath) ?? 0) + 1);
    }
    return counts;
  };

  const prevCounts = countByPath(prevTabs);
  const nextCounts = countByPath(nextTabs);
  const paths = new Set([...prevCounts.keys(), ...nextCounts.keys()]);

  for (const filePath of paths) {
    const delta =
      (nextCounts.get(filePath) ?? 0) - (prevCounts.get(filePath) ?? 0);
    if (delta > 0) {
      for (let i = 0; i < delta; i += 1) retainDocument(filePath);
    } else if (delta < 0) {
      for (let i = 0; i < -delta; i += 1) releaseDocument(filePath);
    }
  }
}

export function openDocument(
  filePath: string,
  text: string,
): monaco.editor.ITextModel {
  const existing = documents.get(filePath);
  if (existing) {
    if (existing.model.getValue() !== text) {
      existing.model.setValue(text);
    }
    monaco.editor.setModelLanguage(existing.model, getLanguage(filePath));
    return existing.model;
  }

  const uri = monaco.Uri.file(filePath);
  const reused = monaco.editor.getModel(uri);
  const model =
    reused ?? monaco.editor.createModel(text, getLanguage(filePath), uri);

  monaco.editor.setModelLanguage(model, getLanguage(filePath));
  documents.set(filePath, {
    model,
    savedText: text,
    viewState: null,
  });
  return model;
}

export function markDocumentSaved(filePath: string, text?: string): void {
  const record = documents.get(filePath);
  if (!record) return;
  record.savedText = text ?? record.model.getValue();
}

export function saveDocumentViewState(
  filePath: string,
  editor: monaco.editor.IStandaloneCodeEditor,
): void {
  const record = documents.get(filePath);
  if (!record) return;
  record.viewState = editor.saveViewState();
}

export function restoreDocumentViewState(
  filePath: string,
  editor: monaco.editor.IStandaloneCodeEditor,
): void {
  const record = documents.get(filePath);
  if (!record?.viewState) return;
  editor.restoreViewState(record.viewState);
}

export interface AttachDocumentResult {
  switched: boolean;
  model: monaco.editor.ITextModel;
}

export function attachDocumentToEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  filePath: string,
  model: monaco.editor.ITextModel,
  previousPath: string,
): AttachDocumentResult {
  const switched = previousPath !== filePath;

  if (!switched && editor.getModel() === model && previousPath === filePath) {
    return { switched: false, model };
  }

  if (previousPath && previousPath !== filePath) {
    saveDocumentViewState(previousPath, editor);
  }

  if (editor.getModel() !== model) {
    editor.setModel(model);
  }

  if (switched) {
    restoreDocumentViewState(filePath, editor);
  }

  return { switched, model };
}

/** Test-only reset */
export function resetEditorDocumentStoreForTests(): void {
  documents.forEach((record) => record.model.dispose());
  documents.clear();
  refCounts.clear();
}
