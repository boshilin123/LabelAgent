import { bufferContainsNullByte } from './binaryFileDetect';

describe('bufferContainsNullByte', () => {
  it('detects null bytes in buffer head', () => {
    const binary = new Uint8Array([72, 101, 108, 0, 108, 111]).buffer;
    expect(bufferContainsNullByte(binary)).toBe(true);
  });

  it('returns false for utf-8 text', () => {
    const text = new TextEncoder().encode('hello world').buffer;
    expect(bufferContainsNullByte(text)).toBe(false);
  });
});
