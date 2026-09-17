/** Finalize validation for flat label candidates (fusion parity subset). */

export function validateMappingsForFinalize(
  boxes: Array<{ box_index: number }>,
  mappings: Array<{ box_index: number; label_id: string }>,
  validLabelIds: Set<string>,
): {
  valid: boolean;
  errors: string[];
  labeledCount: number;
  unlabeledCount: number;
} {
  const errors: string[] = [];
  if (!boxes.length) {
    errors.push('boxes 为空');
    return { valid: false, errors, labeledCount: 0, unlabeledCount: 0 };
  }
  if (!mappings.length) {
    errors.push('mappings 为空');
    return { valid: false, errors, labeledCount: 0, unlabeledCount: 0 };
  }

  const byIndex = new Map(mappings.map((m) => [m.box_index, m.label_id]));
  let labeledCount = 0;
  let unlabeledCount = 0;
  for (const box of boxes) {
    const lid = (byIndex.get(box.box_index) || '').trim();
    if (!lid) {
      unlabeledCount += 1;
      continue;
    }
    if (!validLabelIds.has(lid)) {
      errors.push(`box_index=${box.box_index} 的 label_id 不在候选中`);
      continue;
    }
    labeledCount += 1;
  }
  if (labeledCount === 0) {
    errors.push('无有效 label_id 映射');
  }
  return { valid: errors.length === 0, errors, labeledCount, unlabeledCount };
}
