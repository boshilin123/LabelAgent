import {
  appendWarnings,
  missingMediaWarning,
  unknownLabelWarning,
} from '../exportValidation';

describe('exportValidation', () => {
  it('merges unique warnings', () => {
    expect(appendWarnings(['a'], ['b', 'a'], undefined, ['c'])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('formats unknown label warning', () => {
    expect(unknownLabelWarning(0)).toBeUndefined();
    expect(unknownLabelWarning(3)).toBe(
      '有 3 条标注使用了未知 labelId，已跳过',
    );
  });

  it('formats missing media warning', () => {
    expect(missingMediaWarning(2)).toBe('有 2 个源文件未找到，未拷贝');
  });
});
