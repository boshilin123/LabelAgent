const binaryCache = new Map<string, boolean>();

export function bufferContainsNullByte(
  buffer: ArrayBuffer,
  maxBytes = 8192,
): boolean {
  const bytes = new Uint8Array(buffer.slice(0, maxBytes));
  return bytes.includes(0);
}

export async function checkBinaryFile(filePath: string): Promise<boolean> {
  const cached = binaryCache.get(filePath);
  if (cached !== undefined) return cached;

  const buffer = await window.electron.fileSystem?.readFileBuffer(filePath);
  const isBinary = buffer ? bufferContainsNullByte(buffer) : false;
  binaryCache.set(filePath, isBinary);
  return isBinary;
}

export function clearBinaryFileCache(filePath?: string): void {
  if (filePath) {
    binaryCache.delete(filePath);
    return;
  }
  binaryCache.clear();
}

/** Test-only */
export function setBinaryFileCacheForTests(
  filePath: string,
  isBinary: boolean,
): void {
  binaryCache.set(filePath, isBinary);
}

export function resetBinaryFileCacheForTests(): void {
  binaryCache.clear();
}
