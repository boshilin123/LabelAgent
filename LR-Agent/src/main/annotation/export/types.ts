export interface LabelDef {
  id: string;
  name: string;
}

export interface SourceMeta {
  width: number;
  height: number;
}

export interface LoadedImageDoc {
  kind: 'image';
  relativePath: string;
  filePath: string;
  source: SourceMeta;
  annotations: Record<string, unknown>[];
  modality?: string;
  annotationType?: string;
}

export interface LoadedTextDoc {
  kind: 'text';
  relativePath: string;
  filePath: string;
  annotations: Record<string, unknown>[];
  modality?: string;
  annotationType?: string;
}

export type LoadedDoc = LoadedImageDoc | LoadedTextDoc;

export interface LoadDocsResult {
  docs: LoadedDoc[];
  skippedFiles: string[];
  warnings: string[];
}
