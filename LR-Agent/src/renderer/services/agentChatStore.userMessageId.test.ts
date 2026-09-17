import { resolveUserMessageIdForJob } from './userMessageIdForJob';

describe('resolveUserMessageIdForJob', () => {
  it('returns new user message id for a new turn', () => {
    expect(
      resolveUserMessageIdForJob({
        editMessageId: null,
        newUserMessageId: 'msg-u2',
      }),
    ).toBe('msg-u2');
  });

  it('returns edit message id when editing', () => {
    expect(
      resolveUserMessageIdForJob({
        editMessageId: 'msg-u1',
        newUserMessageId: null,
      }),
    ).toBe('msg-u1');
  });

  it('prefers edit id over new id when both are set', () => {
    expect(
      resolveUserMessageIdForJob({
        editMessageId: 'msg-u1',
        newUserMessageId: 'msg-u2',
      }),
    ).toBe('msg-u1');
  });

  it('does not use messageIds[length-2] which points at prior assistant', () => {
    const messageIds = ['msg-u1', 'msg-a1', 'msg-u2'];
    const buggyLegacyIndex = messageIds[messageIds.length - 2];
    expect(buggyLegacyIndex).toBe('msg-a1');
    expect(
      resolveUserMessageIdForJob({
        editMessageId: null,
        newUserMessageId: 'msg-u2',
      }),
    ).toBe('msg-u2');
  });

  it('throws when neither edit nor new id is provided', () => {
    expect(() =>
      resolveUserMessageIdForJob({
        editMessageId: null,
        newUserMessageId: null,
      }),
    ).toThrow('missing user message id');
  });
});
