import {
  applyChangeToDoc,
  checkSourceFreshness,
  foldValidatedChangesIntoDoc,
  mergeProposalChangesIntoDoc,
  validateMutations,
} from './annotationMutationApply';
import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';
import type { FileAnnotationDocument } from '../types/annotationDocument';
import type { AnnotationProject } from '../types/annotation';

const labels = [{ id: 'l1', name: 'person', color: '#f00' }];

const project: AnnotationProject = {
  id: 'p1',
  name: 'Demo',
  directoryPath: '/tmp/project',
  modality: 'image',
  annotationType: 'bbox',
  labels,
  createdAt: '',
  updatedAt: '',
};

const doc: FileAnnotationDocument = {
  schemaVersion: 1,
  projectId: 'p1',
  filePath: 'data/1.jpg',
  modality: 'image',
  annotationType: 'bbox',
  annotations: [
    {
      id: 'a1',
      kind: 'bbox',
      labelId: 'l1',
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    },
  ],
  updatedAt: '2020-01-01T00:00:00.000Z',
};

describe('validateMutations', () => {
  it('accepts patch with valid id and label', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'patch',
      patches: [{ id: 'a1', labelId: 'l1' }],
    };
    const result = validateMutations(doc, change, labels);
    expect(result.valid).toBe(true);
  });

  it('rejects delete for missing id', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'delete',
      deleteIds: ['missing'],
    };
    const result = validateMutations(doc, change, labels);
    expect(result.valid).toBe(false);
  });
});

describe('checkSourceFreshness', () => {
  it('detects mtime change', () => {
    const result = checkSourceFreshness(
      { mtimeMs: 100, size: 50 },
      { mtimeMs: 200, size: 50 },
    );
    expect(result.fresh).toBe(false);
  });
});

describe('mergeProposalChangesIntoDoc', () => {
  it('appends multiple changes for the same file', () => {
    const append1: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'append',
      annotations: [
        {
          id: 'a2',
          kind: 'bbox',
          labelId: 'l1',
          x: 0.2,
          y: 0.2,
          width: 0.1,
          height: 0.1,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const append2: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'append',
      annotations: [
        {
          id: 'a3',
          kind: 'bbox',
          labelId: 'l1',
          x: 0.3,
          y: 0.3,
          width: 0.1,
          height: 0.1,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };

    const merged = mergeProposalChangesIntoDoc(
      doc,
      [append1, append2],
      project,
    );
    expect(merged.annotations).toHaveLength(3);
    expect(merged.annotations.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('replace_bboxes keeps non-bbox annotations', () => {
    const docWithCaption: FileAnnotationDocument = {
      ...doc,
      annotations: [
        ...doc.annotations,
        {
          id: 'c1',
          kind: 'caption',
          labelId: null,
          text: 'hello',
          granularity: 'brief',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const change: AnnotationBatchChange = {
      relativePath: 'data/1.jpg',
      absolutePath: '/tmp/data/1.jpg',
      operation: 'replace_bboxes',
      annotations: [
        {
          id: 'b2',
          kind: 'bbox',
          labelId: 'l1',
          x: 0.5,
          y: 0.5,
          width: 0.2,
          height: 0.2,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };

    const merged = mergeProposalChangesIntoDoc(
      docWithCaption,
      [change],
      project,
    );
    expect(merged.annotations).toHaveLength(2);
    expect(merged.annotations.some((a) => a.id === 'c1')).toBe(true);
    expect(merged.annotations.some((a) => a.id === 'b2')).toBe(true);
    expect(merged.annotations.some((a) => a.id === 'a1')).toBe(false);
  });

  it('creates a new doc when parsed is null and changes are append-only', () => {
    const change: AnnotationBatchChange = {
      relativePath: 'data/new.jpg',
      absolutePath: '/tmp/data/new.jpg',
      operation: 'append',
      annotations: [
        {
          id: 'n1',
          kind: 'bbox',
          labelId: 'l1',
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.2,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };

    const merged = mergeProposalChangesIntoDoc(null, [change], project);
    expect(merged.filePath).toBe('data/new.jpg');
    expect(merged.annotations).toHaveLength(1);
    expect(merged.annotations[0]?.id).toBe('n1');
  });
});

describe('applyChangeToDoc patch and rewrite', () => {
  it('patches bbox geometry', () => {
    const next = applyChangeToDoc(
      doc,
      {
        relativePath: 'data/1.jpg',
        absolutePath: '/tmp/data/1.jpg',
        operation: 'patch',
        patches: [{ id: 'a1', x: 0.2, y: 0.2, width: 0.1, height: 0.1 }],
      },
      project,
    );
    const box = next.annotations[0];
    expect(box && box.kind === 'bbox' && box.x).toBe(0.2);
    expect(box && box.kind === 'bbox' && box.width).toBe(0.1);
  });

  it('patches caption text', () => {
    const captionDoc: FileAnnotationDocument = {
      ...doc,
      annotationType: 'caption',
      annotations: [
        {
          id: 'c1',
          kind: 'caption',
          labelId: null,
          text: '金发小女孩',
          granularity: 'brief',
          language: 'zh',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const next = applyChangeToDoc(
      captionDoc,
      {
        relativePath: 'data/1.jpg',
        absolutePath: '/tmp/data/1.jpg',
        operation: 'patch',
        patches: [{ id: 'c1', text: '金发红框眼镜少女' }],
      },
      { ...project, annotationType: 'caption' },
    );
    const cap = next.annotations[0];
    expect(cap && cap.kind === 'caption' && cap.text).toBe('金发红框眼镜少女');
  });

  it('patches cot steps and answer', () => {
    const cotDoc: FileAnnotationDocument = {
      ...doc,
      modality: 'text',
      annotationType: 'cot',
      annotations: [
        {
          id: 't1',
          kind: 'cot',
          labelId: null,
          steps: [
            { description: '旧1', conclusion: 'c1' },
            { description: '旧2', conclusion: 'c2' },
          ],
          answer: '旧答案',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const next = applyChangeToDoc(
      cotDoc,
      {
        relativePath: 'math.md',
        absolutePath: '/tmp/math.md',
        operation: 'patch',
        patches: [
          {
            id: 't1',
            steps: [
              { description: '设未知数', conclusion: '鸡x兔y' },
              { description: '列方程', conclusion: 'x+y=35' },
              { description: '求解', conclusion: 'x=23,y=12' },
            ],
            answer: '鸡 23 兔 12',
          },
        ],
      },
      { ...project, modality: 'text', annotationType: 'cot' },
    );
    const cot = next.annotations[0];
    expect(cot && cot.kind === 'cot' && cot.steps).toHaveLength(3);
    expect(cot && cot.kind === 'cot' && cot.answer).toBe('鸡 23 兔 12');
  });

  it('delete then append rewrites matching items', () => {
    const captionDoc: FileAnnotationDocument = {
      ...doc,
      annotationType: 'caption',
      annotations: [
        {
          id: 'old-brief',
          kind: 'caption',
          labelId: null,
          text: '金发小女孩',
          granularity: 'brief',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
        {
          id: 'keep-detailed',
          kind: 'caption',
          labelId: null,
          text: '详细描述',
          granularity: 'detailed',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const merged = mergeProposalChangesIntoDoc(
      captionDoc,
      [
        {
          relativePath: 'data/1.jpg',
          absolutePath: '/tmp/data/1.jpg',
          operation: 'delete',
          deleteIds: ['old-brief'],
        },
        {
          relativePath: 'data/1.jpg',
          absolutePath: '/tmp/data/1.jpg',
          operation: 'append',
          annotations: [
            {
              id: 'new-brief',
              kind: 'caption',
              labelId: null,
              text: '金发红框眼镜',
              granularity: 'brief',
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-01T00:00:00.000Z',
            },
          ],
        },
      ],
      { ...project, annotationType: 'caption' },
    );
    expect(merged.annotations.map((a) => a.id).sort()).toEqual([
      'keep-detailed',
      'new-brief',
    ]);
  });

  it('rejects bbox geometry outside 0-1', () => {
    const result = validateMutations(
      doc,
      {
        relativePath: 'data/1.jpg',
        absolutePath: '/tmp/data/1.jpg',
        operation: 'patch',
        patches: [{ id: 'a1', x: 1.5 }],
      },
      labels,
    );
    expect(result.valid).toBe(false);
  });
});

describe('applyChangeToDoc patch extended kinds', () => {
  const baseTime = '2020-01-01T00:00:00.000Z';

  it('patches rotated_bbox center and angle', () => {
    const rotatedDoc: FileAnnotationDocument = {
      ...doc,
      annotationType: 'rotated_bbox',
      annotations: [
        {
          id: 'r1',
          kind: 'rotated_bbox',
          labelId: 'l1',
          cx: 0.5,
          cy: 0.5,
          width: 0.2,
          height: 0.1,
          angle: 0,
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
    };
    const next = applyChangeToDoc(
      rotatedDoc,
      {
        relativePath: 'data/1.jpg',
        absolutePath: '/tmp/data/1.jpg',
        operation: 'patch',
        patches: [{ id: 'r1', cx: 0.6, angle: 45 }],
      },
      { ...project, annotationType: 'rotated_bbox' },
    );
    const ann = next.annotations[0];
    expect(ann && ann.kind === 'rotated_bbox' && ann.cx).toBe(0.6);
    expect(ann && ann.kind === 'rotated_bbox' && ann.angle).toBe(45);
    expect(ann && ann.kind === 'rotated_bbox' && ann.cy).toBe(0.5);
  });

  it('patches pose keypoints and angle', () => {
    const poseDoc: FileAnnotationDocument = {
      ...doc,
      annotationType: 'keypoint',
      annotations: [
        {
          id: 'p1',
          kind: 'pose',
          labelId: null,
          templateId: 'tpl',
          cx: 0.5,
          cy: 0.5,
          width: 0.3,
          height: 0.4,
          angle: 0,
          keypoints: [{ x: 0.5, y: 0.4, visibility: 2 }],
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
    };
    const next = applyChangeToDoc(
      poseDoc,
      {
        relativePath: 'data/1.jpg',
        absolutePath: '/tmp/data/1.jpg',
        operation: 'patch',
        patches: [
          {
            id: 'p1',
            angle: 90,
            keypoints: [{ x: 0.6, y: 0.45, visibility: 1 }],
          },
        ],
      },
      { ...project, annotationType: 'keypoint' },
    );
    const ann = next.annotations[0];
    expect(ann && ann.kind === 'pose' && ann.angle).toBe(90);
    expect(ann && ann.kind === 'pose' && ann.keypoints[0]?.visibility).toBe(1);
  });

  it('patches span_ner offsets', () => {
    const spanDoc: FileAnnotationDocument = {
      ...doc,
      modality: 'text',
      annotationType: 'span_ner',
      annotations: [
        {
          id: 's1',
          kind: 'span_ner',
          labelId: 'l1',
          start: 0,
          end: 5,
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
    };
    const next = applyChangeToDoc(
      spanDoc,
      {
        relativePath: 'data/a.txt',
        absolutePath: '/tmp/data/a.txt',
        operation: 'patch',
        patches: [{ id: 's1', start: 2, end: 8 }],
      },
      { ...project, modality: 'text', annotationType: 'span_ner' },
    );
    const ann = next.annotations[0];
    expect(ann && ann.kind === 'span_ner' && ann.start).toBe(2);
    expect(ann && ann.kind === 'span_ner' && ann.end).toBe(8);
  });

  it('patches preference chosen/rejected', () => {
    const prefDoc: FileAnnotationDocument = {
      ...doc,
      modality: 'text',
      annotationType: 'preference',
      annotations: [
        {
          id: 'pr1',
          kind: 'preference',
          labelId: null,
          prompt: '问',
          chosen: '旧好',
          rejected: '旧差',
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
    };
    const next = applyChangeToDoc(
      prefDoc,
      {
        relativePath: 'data/a.txt',
        absolutePath: '/tmp/data/a.txt',
        operation: 'patch',
        patches: [{ id: 'pr1', chosen: '新好', rejected: '新差' }],
      },
      { ...project, modality: 'text', annotationType: 'preference' },
    );
    const ann = next.annotations[0];
    expect(ann && ann.kind === 'preference' && ann.chosen).toBe('新好');
    expect(ann && ann.kind === 'preference' && ann.prompt).toBe('问');
  });

  it('patches conversation turns', () => {
    const convDoc: FileAnnotationDocument = {
      ...doc,
      modality: 'text',
      annotationType: 'conversation',
      annotations: [
        {
          id: 'cv1',
          kind: 'conversation',
          labelId: null,
          turns: [{ role: 'user', content: '旧问题' }],
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
    };
    const next = applyChangeToDoc(
      convDoc,
      {
        relativePath: 'data/a.txt',
        absolutePath: '/tmp/data/a.txt',
        operation: 'patch',
        patches: [
          {
            id: 'cv1',
            turns: [
              { role: 'user', content: '新问题' },
              { role: 'assistant', content: '新回答' },
            ],
          },
        ],
      },
      { ...project, modality: 'text', annotationType: 'conversation' },
    );
    const ann = next.annotations[0];
    expect(ann && ann.kind === 'conversation' && ann.turns).toHaveLength(2);
  });

  it('patches instruction input/output', () => {
    const insDoc: FileAnnotationDocument = {
      ...doc,
      modality: 'text',
      annotationType: 'instruction',
      annotations: [
        {
          id: 'i1',
          kind: 'instruction',
          labelId: null,
          instruction: '旧指令',
          input: '旧输入',
          output: '旧输出',
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
    };
    const next = applyChangeToDoc(
      insDoc,
      {
        relativePath: 'data/a.txt',
        absolutePath: '/tmp/data/a.txt',
        operation: 'patch',
        patches: [{ id: 'i1', instruction: '新指令', output: '新输出' }],
      },
      { ...project, modality: 'text', annotationType: 'instruction' },
    );
    const ann = next.annotations[0];
    expect(ann && ann.kind === 'instruction' && ann.instruction).toBe('新指令');
    expect(ann && ann.kind === 'instruction' && ann.output).toBe('新输出');
  });

  it('rejects angle on bbox', () => {
    const result = validateMutations(
      doc,
      {
        relativePath: 'data/1.jpg',
        absolutePath: '/tmp/data/1.jpg',
        operation: 'patch',
        patches: [{ id: 'a1', angle: 30 }],
      },
      labels,
    );
    expect(result.valid).toBe(false);
  });

  it('rejects keypoints on bbox', () => {
    const result = validateMutations(
      doc,
      {
        relativePath: 'data/1.jpg',
        absolutePath: '/tmp/data/1.jpg',
        operation: 'patch',
        patches: [{ id: 'a1', keypoints: [{ x: 0.5, y: 0.5, visibility: 2 }] }],
      },
      labels,
    );
    expect(result.valid).toBe(false);
  });

  it('rejects span offsets with start >= end', () => {
    const spanDoc: FileAnnotationDocument = {
      ...doc,
      modality: 'text',
      annotationType: 'span_ner',
      annotations: [
        {
          id: 's1',
          kind: 'span_ner',
          labelId: 'l1',
          start: 0,
          end: 5,
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
    };
    const result = validateMutations(
      spanDoc,
      {
        relativePath: 'data/a.txt',
        absolutePath: '/tmp/data/a.txt',
        operation: 'patch',
        patches: [{ id: 's1', start: 8, end: 2 }],
      },
      labels,
    );
    expect(result.valid).toBe(false);
  });
});

describe('foldValidatedChangesIntoDoc', () => {
  it('validates delete+append in memory and keeps remaining items', () => {
    const captionDoc: FileAnnotationDocument = {
      ...doc,
      annotationType: 'caption',
      annotations: [
        {
          id: 'old-brief',
          kind: 'caption',
          labelId: null,
          text: '旧',
          granularity: 'brief',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
        {
          id: 'keep-detailed',
          kind: 'caption',
          labelId: null,
          text: '详',
          granularity: 'detailed',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const folded = foldValidatedChangesIntoDoc(
      captionDoc,
      [
        {
          relativePath: 'data/1.jpg',
          absolutePath: '/tmp/data/1.jpg',
          operation: 'delete',
          deleteIds: ['old-brief'],
        },
        {
          relativePath: 'data/1.jpg',
          absolutePath: '/tmp/data/1.jpg',
          operation: 'append',
          annotations: [
            {
              id: 'new-brief',
              kind: 'caption',
              labelId: null,
              text: '新',
              granularity: 'brief',
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-01T00:00:00.000Z',
            },
          ],
        },
      ],
      { ...project, annotationType: 'caption' },
    );
    expect(folded.annotations.map((a) => a.id).sort()).toEqual([
      'keep-detailed',
      'new-brief',
    ]);
  });

  it('throws before producing a write when later change is invalid', () => {
    expect(() =>
      foldValidatedChangesIntoDoc(
        doc,
        [
          {
            relativePath: 'data/1.jpg',
            absolutePath: '/tmp/data/1.jpg',
            operation: 'delete',
            deleteIds: ['a1'],
          },
          {
            relativePath: 'data/1.jpg',
            absolutePath: '/tmp/data/1.jpg',
            operation: 'patch',
            patches: [{ id: 'a1', labelId: 'l1' }],
          },
        ],
        project,
      ),
    ).toThrow(/未找到标注 id a1/);
  });
});
