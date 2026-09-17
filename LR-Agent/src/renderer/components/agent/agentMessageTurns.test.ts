import { describe, expect, it } from '@jest/globals';
import { groupMessagesIntoTurns } from './agentMessageTurns';

function msg(id: string, role: string) {
  return { id, role };
}

describe('groupMessagesIntoTurns', () => {
  it('returns no turns for an empty list', () => {
    expect(groupMessagesIntoTurns([])).toEqual([]);
  });

  it('keeps a user message and its following assistant in one turn', () => {
    expect(
      groupMessagesIntoTurns([msg('u1', 'user'), msg('a1', 'assistant')]),
    ).toEqual([
      { key: 'u1', messages: [msg('u1', 'user'), msg('a1', 'assistant')] },
    ]);
  });

  it('starts a new turn at each user message', () => {
    expect(
      groupMessagesIntoTurns([
        msg('u1', 'user'),
        msg('a1', 'assistant'),
        msg('u2', 'user'),
        msg('a2', 'assistant'),
      ]),
    ).toEqual([
      { key: 'u1', messages: [msg('u1', 'user'), msg('a1', 'assistant')] },
      { key: 'u2', messages: [msg('u2', 'user'), msg('a2', 'assistant')] },
    ]);
  });

  it('gives consecutive user messages their own turns', () => {
    expect(
      groupMessagesIntoTurns([msg('u1', 'user'), msg('u2', 'user')]),
    ).toEqual([
      { key: 'u1', messages: [msg('u1', 'user')] },
      { key: 'u2', messages: [msg('u2', 'user')] },
    ]);
  });

  it('wraps a leading assistant in its own turn', () => {
    expect(groupMessagesIntoTurns([msg('a0', 'assistant')])).toEqual([
      { key: 'a0', messages: [msg('a0', 'assistant')] },
    ]);
  });

  it('attaches trailing system/assistant messages to the current turn', () => {
    expect(
      groupMessagesIntoTurns([
        msg('u1', 'user'),
        msg('a1', 'assistant'),
        msg('s1', 'system'),
      ]),
    ).toEqual([
      {
        key: 'u1',
        messages: [
          msg('u1', 'user'),
          msg('a1', 'assistant'),
          msg('s1', 'system'),
        ],
      },
    ]);
  });
});
