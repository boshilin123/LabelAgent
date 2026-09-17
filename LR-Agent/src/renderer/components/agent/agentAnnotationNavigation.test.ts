import { describe, expect, it } from '@jest/globals';
import type { AnnotationProject } from '../../types/annotation';
import {
  getOpenActionLabels,
  isSyntheticAnnotationPath,
  resolveAnnotationOpenTarget,
} from './agentAnnotationNavigation';

const project: AnnotationProject = {
  id: 'p1',
  name: 'Demo',
  directoryPath: 'D:/project',
  modality: 'text',
  annotationType: 'cot',
  labels: [],
  createdAt: '',
  updatedAt: '',
};

describe('isSyntheticAnnotationPath', () => {
  it('detects synthetic relative paths', () => {
    expect(isSyntheticAnnotationPath('_synthetic_/123_cot.json')).toBe(true);
    expect(isSyntheticAnnotationPath('/_synthetic_/x.json')).toBe(true);
    expect(isSyntheticAnnotationPath('business_math.txt')).toBe(false);
  });
});

describe('getOpenActionLabels', () => {
  it('returns canvas label for image projects', () => {
    const labels = getOpenActionLabels('image', 'data/1.jpg');
    expect(labels.button).toBe('画布查看');
    expect(labels.ariaLabel).toContain('标注画布');
  });

  it('returns annotation label for text projects', () => {
    const labels = getOpenActionLabels('text', 'business_math.txt');
    expect(labels.button).toBe('查看标注');
    expect(labels.ariaLabel).toContain('标注工作区');
  });

  it('returns synthetic label for synthetic paths', () => {
    const labels = getOpenActionLabels('text', '_synthetic_/1.json');
    expect(labels.button).toBe('查看条目');
    expect(labels.ariaLabel).toContain('合成标注');
  });
});

describe('resolveAnnotationOpenTarget', () => {
  it('returns synthetic target without opening disk file', () => {
    expect(
      resolveAnnotationOpenTarget(
        '_synthetic_/1.json',
        '_synthetic_/1.json',
        project,
        null,
      ),
    ).toEqual({ kind: 'synthetic' });
  });

  it('resolves real file from relative path', () => {
    expect(
      resolveAnnotationOpenTarget('business_math.txt', '', project, null),
    ).toEqual({
      kind: 'file',
      absolutePath: 'D:/project/business_math.txt',
    });
  });

  it('prefers non-synthetic absolute path when provided', () => {
    expect(
      resolveAnnotationOpenTarget(
        'business_math.txt',
        'D:/project/business_math.txt',
        project,
        null,
      ),
    ).toEqual({
      kind: 'file',
      absolutePath: 'D:/project/business_math.txt',
    });
  });
});
