import {
  resolveMutationTargets,
  labelIdByName,
  parseMutationOperation,
} from './mutationTargetResolver';
import type {
  BboxAnnotation,
  CaptionAnnotation,
  PolygonAnnotation,
  TextClassificationAnnotation,
} from '../../types/annotationDocument';

const labels = [
  { id: 'l1', name: 'person', color: '#f00' },
  { id: 'l2', name: 'worker', color: '#0f0' },
];

const bboxes: BboxAnnotation[] = [
  {
    id: 'left',
    kind: 'bbox',
    labelId: 'l1',
    x: 0.05,
    y: 0.2,
    width: 0.1,
    height: 0.2,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'right',
    kind: 'bbox',
    labelId: 'l1',
    x: 0.7,
    y: 0.2,
    width: 0.1,
    height: 0.2,
    createdAt: '',
    updatedAt: '',
  },
];

describe('resolveMutationTargets', () => {
  it('resolves by id', () => {
    const result = resolveMutationTargets(
      bboxes,
      [{ by: 'id', id: 'left' }],
      labels,
      [],
    );
    expect(result.ids).toEqual(['left']);
  });

  it('resolves leftmost spatial hint', () => {
    const result = resolveMutationTargets(
      bboxes,
      [{ by: 'spatial', hint: 'leftmost' }],
      labels,
      [],
    );
    expect(result.ids).toEqual(['left']);
  });

  it('uses selected ids', () => {
    const result = resolveMutationTargets(
      bboxes,
      [{ by: 'selected' }],
      labels,
      ['right'],
    );
    expect(result.ids).toEqual(['right']);
  });

  it('resolves all bboxes', () => {
    const result = resolveMutationTargets(bboxes, [{ by: 'all' }], labels, []);
    expect(result.ids.sort()).toEqual(['left', 'right']);
  });
});

describe('labelIdByName', () => {
  it('finds label case-insensitively', () => {
    expect(labelIdByName('Worker', labels)).toBe('l2');
  });
});

const polygons: PolygonAnnotation[] = [
  {
    id: 'p-empty',
    kind: 'polygon',
    labelId: null,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.1 },
      { x: 0.15, y: 0.2 },
    ],
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'p-right',
    kind: 'polygon',
    labelId: 'l1',
    points: [
      { x: 0.7, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.8, y: 0.3 },
    ],
    createdAt: '',
    updatedAt: '',
  },
];

const captions: CaptionAnnotation[] = [
  {
    id: 'brief-zh',
    kind: 'caption',
    labelId: null,
    text: '短',
    granularity: 'brief',
    language: 'zh',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'detailed-zh',
    kind: 'caption',
    labelId: null,
    text: '这是一条很长很长很长很长的中文详细描述内容用于压过英文长度',
    granularity: 'detailed',
    language: 'zh',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'detailed-en',
    kind: 'caption',
    labelId: null,
    text: 'a medium english caption',
    granularity: 'detailed',
    language: 'en',
    createdAt: '',
    updatedAt: '',
  },
];

const classifications: TextClassificationAnnotation[] = [
  {
    id: 'c1',
    kind: 'text_classification',
    labelId: 'l1',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'c2',
    kind: 'text_classification',
    labelId: 'l1',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'c3',
    kind: 'text_classification',
    labelId: 'l2',
    createdAt: '',
    updatedAt: '',
  },
];

describe('resolveMutationTargets extra locators', () => {
  it('resolves unlabeled polygons', () => {
    const result = resolveMutationTargets(
      polygons,
      [{ by: 'unlabeled' }],
      labels,
      [],
    );
    expect(result.ids).toEqual(['p-empty']);
  });

  it('resolves polygon spatial rightmost', () => {
    const result = resolveMutationTargets(
      polygons,
      [{ by: 'spatial', hint: 'right' }],
      labels,
      [],
    );
    expect(result.ids).toEqual(['p-right']);
  });

  it('resolves caption by granularity', () => {
    const result = resolveMutationTargets(
      captions,
      [{ by: 'granularity', granularity: 'brief' }],
      labels,
      [],
    );
    expect(result.ids).toEqual(['brief-zh']);
  });

  it('resolves longest caption', () => {
    const result = resolveMutationTargets(
      captions,
      [{ by: 'longest' }],
      labels,
      [],
    );
    expect(result.ids).toEqual(['detailed-zh']);
  });

  it('resolves duplicate classification labels', () => {
    const result = resolveMutationTargets(
      classifications,
      [{ by: 'duplicate_label' }],
      labels,
      [],
    );
    expect(result.ids).toEqual(['c2']);
  });

  it('rejects duplicate_label on bbox/polygon', () => {
    const result = resolveMutationTargets(
      bboxes,
      [{ by: 'duplicate_label' }],
      labels,
      [],
    );
    expect(result.ids).toEqual([]);
    expect(result.errors.some((e) => e.includes('仅用于分类'))).toBe(true);
  });
});

describe('parseMutationOperation', () => {
  it('parses patch_geometry and patch_content', () => {
    const geom = parseMutationOperation({
      relative_path: 'data/1.jpg',
      mutation_kind: 'patch_geometry',
      targets: [{ by: 'id', id: 'left' }],
      x: 0.1,
      y: 0.2,
      width: 0.15,
      height: 0.18,
    });
    expect(geom?.mutation_kind).toBe('patch_geometry');
    expect(geom?.width).toBe(0.15);

    const content = parseMutationOperation({
      relative_path: 'data/2.jpg',
      mutation_kind: 'patch_content',
      targets: [{ by: 'granularity', granularity: 'brief' }],
      text: '金发红框眼镜',
      granularity: 'brief',
    });
    expect(content?.mutation_kind).toBe('patch_content');
    expect(content?.text).toBe('金发红框眼镜');
  });
});
