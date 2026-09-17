import type { AnnotationInstance } from '../../types/annotationDocument';
import {
  inferAnnotationWritePolicy,
  prependRewriteDeletes,
  selectIdsToReplace,
} from './annotationWritePolicy';

const existingCaptions: AnnotationInstance[] = [
  {
    id: 'b1',
    kind: 'caption',
    labelId: null,
    text: '金发小女孩',
    granularity: 'brief',
    language: 'zh',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'd1',
    kind: 'caption',
    labelId: null,
    text: '详细',
    granularity: 'detailed',
    language: 'zh',
    createdAt: '',
    updatedAt: '',
  },
];

describe('inferAnnotationWritePolicy', () => {
  it('appends by default even if user says 重写', () => {
    expect(
      inferAnnotationWritePolicy('给 2.jpg 补一条英文 detailed', 'caption'),
    ).toEqual({
      mode: 'append',
    });
    expect(inferAnnotationWritePolicy('重写鸡兔问题 CoT', 'cot').mode).toBe(
      'append',
    );
    expect(inferAnnotationWritePolicy('重新标注 data/1.jpg', 'bbox').mode).toBe(
      'append',
    );
  });

  it('uses explicit write_mode over request wording', () => {
    expect(
      inferAnnotationWritePolicy('不要重写', 'caption', 'replace_matching')
        .mode,
    ).toBe('replace_matching');
    expect(
      inferAnnotationWritePolicy('重新标注 data/1.jpg', 'bbox', 'append').mode,
    ).toBe('append');
  });

  it('rewrites caption brief when replace_matching', () => {
    const policy = inferAnnotationWritePolicy(
      '只重写 brief，不超过 15 个汉字',
      'caption',
      'replace_matching',
    );
    expect(policy.mode).toBe('replace_matching');
    expect(policy.match?.granularity).toBe('brief');
  });

  it('rewrites cot and classification when replace_matching', () => {
    expect(
      inferAnnotationWritePolicy('重写鸡兔问题 CoT', 'cot', 'replace_matching')
        .mode,
    ).toBe('replace_matching');
    expect(
      inferAnnotationWritePolicy(
        '对四个文件重新自动分类',
        'text_classification',
        'replace_matching',
      ).mode,
    ).toBe('replace_matching');
  });

  it('keeps all caption granularities when asked 每种粒度只留', () => {
    const policy = inferAnnotationWritePolicy(
      '按规范重写 caption，每种粒度只留一条',
      'caption',
      'replace_matching',
    );
    expect(policy.mode).toBe('replace_matching');
    expect(policy.match?.matchAllGranularities).toBe(true);
  });
});

describe('selectIdsToReplace', () => {
  it('replaces same caption granularity', () => {
    const ids = selectIdsToReplace(
      existingCaptions,
      {
        mode: 'replace_matching',
        match: { kinds: ['caption'], granularity: 'brief' },
      },
      [
        {
          id: 'new',
          kind: 'caption',
          labelId: null,
          text: '新brief',
          granularity: 'brief',
          createdAt: '',
          updatedAt: '',
        },
      ],
    );
    expect(ids).toEqual(['b1']);
  });

  it('replaces all caption granularities when matchAllGranularities', () => {
    const ids = selectIdsToReplace(
      existingCaptions,
      {
        mode: 'replace_matching',
        match: { kinds: ['caption'], matchAllGranularities: true },
      },
      [
        {
          id: 'new',
          kind: 'caption',
          labelId: null,
          text: '新brief',
          granularity: 'brief',
          createdAt: '',
          updatedAt: '',
        },
      ],
    );
    expect(ids.sort()).toEqual(['b1', 'd1']);
  });
});

describe('prependRewriteDeletes', () => {
  it('puts delete before append', () => {
    const changes = prependRewriteDeletes(
      [
        {
          relativePath: '2.jpg',
          absolutePath: '/tmp/2.jpg',
          operation: 'append',
          annotations: [
            {
              id: 'new',
              kind: 'caption',
              labelId: null,
              text: '新brief',
              granularity: 'brief',
              createdAt: '',
              updatedAt: '',
            },
          ],
        },
      ],
      new Map([['2.jpg', existingCaptions]]),
      { mode: 'replace_matching', match: { kinds: ['caption'] } },
    );
    expect(changes[0]?.operation).toBe('delete');
    expect(changes[0]?.deleteIds).toEqual(['b1']);
    expect(changes[1]?.operation).toBe('append');
  });
});
