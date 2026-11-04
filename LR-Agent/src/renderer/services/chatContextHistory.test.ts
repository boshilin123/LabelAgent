import { loadContextHistory } from './chatContextHistory';
import type { ChatMessage } from '../../shared/agentTypes';

function message(id: string, content = id): ChatMessage {
  return {
    id,
    sessionId: 's',
    role: id.startsWith('u') ? 'user' : 'assistant',
    blocks: [{ type: 'text', content }],
    status: 'done',
    interactionMode: 'chat',
    providerId: 'p',
    model: 'm',
    createdAt: 1,
    updatedAt: 1,
  };
}

it('does not fetch history already present in memory', async () => {
  const loadPage = jest.fn();
  const messages = { u1: message('u1') };
  expect(
    await loadContextHistory({ messageIds: ['u1'], messages, loadPage }),
  ).toEqual(messages);
  expect(loadPage).not.toHaveBeenCalled();
});

it('loads all unsummarized pages while keeping edited in-memory content', async () => {
  const loadPage = jest
    .fn()
    .mockResolvedValueOnce({
      messages: {
        u1: message('u1'),
        a1: message('a1'),
        u2: message('u2', 'old'),
      },
      hasMoreBefore: true,
    })
    .mockResolvedValueOnce({
      messages: { u0: message('u0'), a0: message('a0') },
      hasMoreBefore: false,
    });
  const result = await loadContextHistory({
    messageIds: ['u0', 'a0', 'u1', 'a1', 'u2'],
    messages: { u2: message('u2', 'edited') },
    loadPage,
  });
  expect(Object.keys(result).sort()).toEqual(['a0', 'a1', 'u0', 'u1', 'u2']);
  expect(result.u2.blocks).toEqual([{ type: 'text', content: 'edited' }]);
  expect(loadPage).toHaveBeenNthCalledWith(1, undefined);
  expect(loadPage).toHaveBeenNthCalledWith(2, 'u1');
});

it('does not reload raw messages already covered by the summary', async () => {
  const loadPage = jest.fn();
  await loadContextHistory({
    messageIds: ['u0', 'a0', 'u1'],
    messages: { u1: message('u1') },
    summaryUpToMessageId: 'a0',
    loadPage,
  });
  expect(loadPage).not.toHaveBeenCalled();
});

it('reports unavailable history rather than silently omitting it', async () => {
  await expect(
    loadContextHistory({
      messageIds: ['u0', 'u1'],
      messages: { u1: message('u1') },
      loadPage: jest
        .fn()
        .mockResolvedValue({ messages: {}, hasMoreBefore: false }),
    }),
  ).rejects.toThrow('无法完整读取');
});

it('stops on a repeated pagination cursor', async () => {
  const loadPage = jest.fn().mockResolvedValue({
    messages: { u1: message('u1') },
    hasMoreBefore: true,
  });
  await expect(
    loadContextHistory({
      messageIds: ['u0', 'u1'],
      messages: {},
      loadPage,
    }),
  ).rejects.toThrow('无法完整读取');
  expect(loadPage).toHaveBeenCalledTimes(2);
});
