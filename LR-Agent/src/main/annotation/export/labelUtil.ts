import type { LabelDef } from './types';

export class LabelResolver {
  unknownCount = 0;

  constructor(private readonly labels: LabelDef[]) {}

  index(labelId: string): number | null {
    const idx = this.labels.findIndex((l) => l.id === labelId);
    if (idx < 0) {
      this.unknownCount += 1;
      return null;
    }
    return idx;
  }

  name(labelId: string): string {
    return this.labels.find((l) => l.id === labelId)?.name ?? 'unknown';
  }

  get labelList(): LabelDef[] {
    return this.labels;
  }
}
