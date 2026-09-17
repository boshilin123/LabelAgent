import type { ChatMessage } from '../../shared/agentTypes';
import {
  buildProposalLedger,
  buildProposalStates,
  collectPendingAnnotationChanges,
} from './proposalLedger';

function assistantMessage(
  id: string,
  blocks: ChatMessage['blocks'],
): ChatMessage {
  return {
    id,
    sessionId: 'sess-1',
    role: 'assistant',
    blocks,
    status: 'done',
    providerId: 'p1',
    model: 'm1',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('buildProposalLedger', () => {
  it('returns empty when there are no proposals', () => {
    expect(buildProposalLedger([])).toBe('');
  });

  it('lists applied annotation paths after Keep All', () => {
    const text = buildProposalLedger([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'applied',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'done',
            changes: [
              {
                relativePath: 'data/8.jpg',
                absolutePath: '/p/data/8.jpg',
                operation: 'append',
                annotations: [
                  {
                    id: 'a',
                    kind: 'bbox',
                    labelId: 'face',
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
                    labelId: null,
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    createdAt: 't',
                    updatedAt: 't',
                  },
                ],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 1,
              succeeded: 1,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(text).toContain('【已应用】');
    expect(text).toContain('已写盘');
    expect(text).toContain('data/8.jpg');
    expect(text).toContain('ids=a,b');
    expect(text).toContain('【未确认提案】无');
    expect(text).not.toContain('未写盘');
  });

  it('lists pending annotation boxes and unlabeled count', () => {
    const text = buildProposalLedger([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'pending',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: '4 boxes',
            changes: [
              {
                relativePath: 'data/8.jpg',
                absolutePath: '/p/data/8.jpg',
                operation: 'append',
                annotations: [
                  {
                    id: 'a',
                    kind: 'bbox',
                    labelId: 'face',
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
                    labelId: null,
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    createdAt: 't',
                    updatedAt: 't',
                  },
                ],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 1,
              succeeded: 1,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(text).toContain('【未确认提案】');
    expect(text).toContain('data/8.jpg');
    expect(text).toContain('ids=a,b');
    expect(text).toContain('1 个无标签');
    expect(text).toContain('【已应用】无');
  });
});

describe('collectPendingAnnotationChanges', () => {
  it('collects only pending annotation changes', () => {
    const changes = collectPendingAnnotationChanges([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'pending',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'x',
            changes: [
              {
                relativePath: 'data/8.jpg',
                absolutePath: '/p/data/8.jpg',
                operation: 'append',
                annotations: [],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 1,
              succeeded: 1,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0].relativePath).toBe('data/8.jpg');
  });
});

describe('buildProposalStates', () => {
  it('returns empty when there are no proposals', () => {
    expect(buildProposalStates([])).toEqual([]);
  });

  it('collects annotation change entries with block status', () => {
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'applied',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'done',
            changes: [
              {
                relativePath: 'data/2.jpg',
                absolutePath: '/p/data/2.jpg',
                operation: 'append',
                annotations: [],
              },
              {
                relativePath: 'data/4.jpg',
                absolutePath: '/p/data/4.jpg',
                operation: 'append',
                annotations: [],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 2,
              succeeded: 2,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(states).toEqual([
      {
        path: 'data/2.jpg',
        kind: 'annotation',
        status: 'applied',
        operation: 'append',
        annotationIds: [],
      },
      {
        path: 'data/4.jpg',
        kind: 'annotation',
        status: 'applied',
        operation: 'append',
        annotationIds: [],
      },
    ]);
  });

  it('collects file proposal entries and keeps pending status', () => {
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'file_proposal',
          status: 'pending',
          title: '报告',
          content: '# r',
          suggestedRelativePath: 'reports/r.md',
          operation: 'write',
        },
      ]),
    ]);
    expect(states).toEqual([
      {
        path: 'reports/r.md',
        kind: 'file',
        status: 'pending',
        operation: 'write',
      },
    ]);
  });

  it('passes through dismissed and undone statuses', () => {
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'undone',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'x',
            changes: [
              {
                relativePath: 'data/8.jpg',
                absolutePath: '/p/data/8.jpg',
                operation: 'delete',
                deleteIds: ['a'],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 1,
              succeeded: 1,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(states[0].status).toBe('undone');
    expect(states[0].operation).toBe('delete');
  });

  it('collects annotation ids from annotations, deleteIds and patches', () => {
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'applied',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'x',
            changes: [
              {
                relativePath: 'data/2.jpg',
                absolutePath: '/p/data/2.jpg',
                operation: 'append',
                annotations: [
                  {
                    id: 'ann-1',
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
                    id: 'ann-2',
                    kind: 'bbox',
                    labelId: null,
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    createdAt: 't',
                    updatedAt: 't',
                  },
                ],
              },
              {
                relativePath: 'data/7.jpg',
                absolutePath: '/p/data/7.jpg',
                operation: 'delete',
                deleteIds: ['ann-9'],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 2,
              succeeded: 2,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(states[0].annotationIds).toEqual(['ann-1', 'ann-2']);
    expect(states[1].annotationIds).toEqual(['ann-9']);
  });
});
