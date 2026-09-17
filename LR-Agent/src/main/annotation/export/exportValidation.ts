export function appendWarnings(
  base: string[],
  ...extras: Array<string[] | undefined>
): string[] {
  const merged = [...base];
  for (const list of extras) {
    if (!list?.length) continue;
    for (const item of list) {
      if (!merged.includes(item)) merged.push(item);
    }
  }
  return merged;
}

export function unknownLabelWarning(count: number): string | undefined {
  if (count <= 0) return undefined;
  return `有 ${count} 条标注使用了未知 labelId，已跳过`;
}

export function missingMediaWarning(count: number): string | undefined {
  if (count <= 0) return undefined;
  return `有 ${count} 个源文件未找到，未拷贝`;
}
