import type { ChatMessage } from '../../shared/agentTypes';
import {
  collectAppliedProposalRefs,
  decideEditRollback,
  isSkippableRestoreError,
  messageCanReapply,
  messageCanUndo,
  partitionAppliedCheckpointRefs,
  restoreAppliedCheckpoints,
} from './turnCheckpoint';

function assistant(id: string, blocks: ChatMessage['blocks']): ChatMessage {
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

describe('collectAppliedProposalRefs', () => {
  it('collects applied blocks in message order for newest-first restore', () => {
    const messages = [
      assistant('msg-1', [
        {
          type: 'file_proposal',
          title: 'A',
          content: 'a',
          suggestedRelativePath: 'a.txt',
          status: 'applied',
          hasCheckpoint: true,
        },
      ]),
      assistant('msg-2', [
        {
          type: 'file_proposal',
          title: 'B',
          content: 'b',
          suggestedRelativePath: 'b.txt',
          status: 'applied',
          hasCheckpoint: true,
        },
        {
          type: 'file_proposal',
          title: 'C',
          content: 'c',
          suggestedRelativePath: 'c.txt',
          status: 'pending',
        },
      ]),
    ];
    const refs = collectAppliedProposalRefs(messages);
    expect(refs.map((item) => `${item.messageId}:${item.blockIndex}`)).toEqual([
      'msg-1:0',
      'msg-2:0',
    ]);
    expect([...refs].reverse().map((item) => item.messageId)).toEqual([
      'msg-2',
      'msg-1',
    ]);
  });

  it('skips undone and pending', () => {
    const message = assistant('msg-1', [
      {
        type: 'file_proposal',
        title: 'A',
        content: 'a',
        suggestedRelativePath: 'a.txt',
        status: 'undone',
        hasCheckpoint: true,
      },
    ]);
    expect(collectAppliedProposalRefs([message])).toEqual([]);
  });
});

describe('messageCanUndo / messageCanReapply', () => {
  it('requires checkpoint on every applied block', () => {
    expect(
      messageCanUndo(
        assistant('msg-1', [
          {
            type: 'file_proposal',
            title: 'A',
            content: 'a',
            suggestedRelativePath: 'a.txt',
            status: 'applied',
            hasCheckpoint: true,
          },
        ]),
      ),
    ).toBe(true);
    expect(
      messageCanUndo(
        assistant('msg-1', [
          {
            type: 'file_proposal',
            title: 'A',
            content: 'a',
            suggestedRelativePath: 'a.txt',
            status: 'applied',
          },
        ]),
      ),
    ).toBe(false);
  });

  it('detects undone blocks for reapply', () => {
    expect(
      messageCanReapply(
        assistant('msg-1', [
          {
            type: 'file_proposal',
            title: 'A',
            content: 'a',
            suggestedRelativePath: 'a.txt',
            status: 'undone',
          },
        ]),
      ),
    ).toBe(true);
    expect(
      messageCanReapply(
        assistant('msg-1', [
          {
            type: 'file_proposal',
            title: 'A',
            content: 'a',
            suggestedRelativePath: 'a.txt',
            status: 'pending',
          },
        ]),
      ),
    ).toBe(false);
  });
});

describe('partitionAppliedCheckpointRefs / decideEditRollback', () => {
  const fileRef = {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    blockIndex: 0,
    kind: 'file' as const,
  };

  const appliedBlock: ChatMessage['blocks'][number] = {
    type: 'file_proposal',
    title: 'A',
    content: 'a',
    suggestedRelativePath: 'a.txt',
    status: 'applied',
  };

  afterEach(() => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it('treats applied blocks with hasCheckpoint as restorable', async () => {
    const { restorable, missing } = await partitionAppliedCheckpointRefs(
      [fileRef],
      () => ({ ...appliedBlock, hasCheckpoint: true }),
    );
    expect(restorable).toEqual([fileRef]);
    expect(missing).toEqual([]);
  });

  it('probes disk when the in-memory flag is missing', async () => {
    const has = jest.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      writable: true,
      value: { checkpoint: { has } },
    });
    const { restorable, missing } = await partitionAppliedCheckpointRefs(
      [fileRef],
      () => appliedBlock,
    );
    expect(has).toHaveBeenCalledWith(fileRef);
    expect(restorable).toEqual([fileRef]);
    expect(missing).toEqual([]);
  });

  it('continues without restore when the user confirms a missing snapshot', async () => {
    const confirm = jest.fn().mockReturnValue(true);
    const decision = await decideEditRollback({
      refs: [fileRef],
      getBlock: () => appliedBlock,
      confirmContinue: confirm,
    });
    expect(confirm).toHaveBeenCalledWith(1);
    expect(decision).toEqual({
      action: 'continue',
      restorable: [],
      skipped: 1,
    });
  });

  it('aborts edit when the user cancels a missing snapshot', async () => {
    const decision = await decideEditRollback({
      refs: [fileRef],
      getBlock: () => appliedBlock,
      confirmContinue: () => false,
    });
    expect(decision).toEqual({ action: 'abort' });
  });

  it('restores only the refs that still have snapshots', async () => {
    const otherRef = { ...fileRef, messageId: 'msg-2' };
    const decision = await decideEditRollback({
      refs: [fileRef, otherRef],
      getBlock: (ref) =>
        ref.messageId === 'msg-1'
          ? { ...appliedBlock, hasCheckpoint: true }
          : appliedBlock,
      confirmContinue: () => true,
    });
    expect(decision).toEqual({
      action: 'continue',
      restorable: [fileRef],
      skipped: 1,
    });
  });

  it('marks snapshot-not-found restore errors as skippable', () => {
    expect(isSkippableRestoreError('checkpoint_not_found')).toBe(true);
    expect(isSkippableRestoreError('checkpoint_incomplete')).toBe(true);
    expect(isSkippableRestoreError('checkpoint_unavailable')).toBe(true);
    expect(isSkippableRestoreError('checkpoint_dirty')).toBe(false);
  });

  it('continues restoring remaining refs after a skippable failure', async () => {
    const restore = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'checkpoint_not_found' })
      .mockResolvedValueOnce({ ok: true, restoredPaths: ['b.txt'] });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      writable: true,
      value: { checkpoint: { restore } },
    });
    const older = { ...fileRef, messageId: 'msg-old', blockIndex: 0 };
    const newer = { ...fileRef, messageId: 'msg-new', blockIndex: 0 };
    const result = await restoreAppliedCheckpoints({
      refs: [older, newer],
      project: null,
      workspaceRoot: '/tmp',
      newestFirst: true,
      continueOnSkippable: true,
    });
    expect(result).toEqual({
      ok: true,
      restoredPaths: ['b.txt'],
      skipped: 1,
    });
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('still stops on dirty files even when continueOnSkippable is set', async () => {
    const restore = jest.fn().mockResolvedValue({
      ok: false,
      error: 'checkpoint_dirty',
      dirtyPaths: ['a.txt'],
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      writable: true,
      value: { checkpoint: { restore } },
    });
    const result = await restoreAppliedCheckpoints({
      refs: [fileRef],
      project: null,
      continueOnSkippable: true,
    });
    expect(result).toEqual({
      ok: false,
      error: 'checkpoint_dirty',
      dirtyPaths: ['a.txt'],
    });
  });
});
