/** IPC wrapper for `.lr-agent/annotations/` file documents */

export async function readFileAnnotationDoc(
  projectDir: string,
  relativePath: string,
): Promise<unknown | null> {
  const raw = await window.electron.annotation.readFileAnnotationDoc(
    projectDir,
    relativePath,
  );
  return raw ?? null;
}

export async function writeFileAnnotationDoc(
  projectDir: string,
  relativePath: string,
  doc: unknown,
  sourceHint?: { mtimeMs?: number; size?: number },
): Promise<void> {
  await window.electron.annotation.writeFileAnnotationDoc(
    projectDir,
    relativePath,
    doc,
    sourceHint,
  );
}
