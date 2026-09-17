import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';
import {
  buildProposalFileStats,
  formatFileStatsText,
} from './annotationProposalStats';

const labels = [
  { id: 'curry', name: '斯蒂芬库里', color: '#fff' },
  { id: 'kd', name: '凯文杜兰特', color: '#000' },
];

describe('buildProposalFileStats', () => {
  it('counts added annotations and resolves label names', () => {
    const changes: AnnotationBatchChange[] = [
      {
        relativePath: 'data/2.jpg',
        absolutePath: '/p/data/2.jpg',
        operation: 'append',
        annotations: [
          {
            id: 'a',
            kind: 'bbox',
            labelId: 'curry',
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            createdAt: 't',
            updatedAt: 't',
          },
          {
            id: 'b',
            kind: 'bbox',
            labelId: 'kd',
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            createdAt: 't',
            updatedAt: 't',
          },
          {
            id: 'c',
            kind: 'bbox',
            labelId: 'curry',
            x: 0,
            y: 0,
            width: 2,
            height: 2,
            createdAt: 't',
            updatedAt: 't',
          },
        ],
      },
    ];
    const stats = buildProposalFileStats(changes, labels);
    expect(stats).toHaveLength(1);
    expect(stats[0].path).toBe('data/2.jpg');
    expect(stats[0].added).toBe(3);
    expect(stats[0].deleted).toBe(0);
    expect(stats[0].labels).toEqual(['斯蒂芬库里', '凯文杜兰特']);
  });

  it('counts deletions for delete operations', () => {
    const changes: AnnotationBatchChange[] = [
      {
        relativePath: 'data/8.jpg',
        absolutePath: '/p/data/8.jpg',
        operation: 'delete',
        deleteIds: ['a', 'b'],
      },
    ];
    const stats = buildProposalFileStats(changes, labels);
    expect(stats[0].added).toBe(0);
    expect(stats[0].deleted).toBe(2);
  });

  it('counts modifications for patch operations', () => {
    const changes: AnnotationBatchChange[] = [
      {
        relativePath: 'data/3.jpg',
        absolutePath: '/p/data/3.jpg',
        operation: 'patch',
        patches: [{ id: 'a', labelId: 'curry' } as never],
      },
    ];
    const stats = buildProposalFileStats(changes, labels);
    expect(stats[0].modified).toBe(1);
  });

  it('falls back to label id when name is unknown', () => {
    const changes: AnnotationBatchChange[] = [
      {
        relativePath: 'data/1.jpg',
        absolutePath: '/p/data/1.jpg',
        operation: 'append',
        annotations: [
          {
            id: 'a',
            kind: 'bbox',
            labelId: 'unknown-label',
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            createdAt: 't',
            updatedAt: 't',
          },
        ],
      },
    ];
    const stats = buildProposalFileStats(changes, labels);
    expect(stats[0].labels).toEqual(['unknown-label']);
  });
});

describe('formatFileStatsText', () => {
  it('formats per-file summary with labels', () => {
    const text = formatFileStatsText([
      {
        path: 'data/2.jpg',
        operation: 'append',
        added: 1,
        deleted: 0,
        modified: 0,
        labels: ['斯蒂芬库里'],
      },
      {
        path: 'data/8.jpg',
        operation: 'delete',
        added: 0,
        deleted: 1,
        modified: 0,
        labels: [],
      },
    ]);
    expect(text).toContain('data/2.jpg: 新增 1（斯蒂芬库里）');
    expect(text).toContain('data/8.jpg: 删除 1');
  });

  it('returns empty string for empty stats', () => {
    expect(formatFileStatsText([])).toBe('');
  });
});
