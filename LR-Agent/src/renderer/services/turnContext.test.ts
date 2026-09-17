import { buildTurnContextFromState, formatTurnLine } from './turnContext';
import type { AgentSession } from '../../shared/agentTypes';

describe('formatTurnLine', () => {
  it('uses plain role labels without mode prefix', () => {
    expect(formatTurnLine('user', 'hello')).toBe('用户: hello');
    expect(formatTurnLine('assistant', 'go')).toBe('助手: go');
  });
});

describe('buildTurnContextFromState', () => {
  it('builds transcript without Ask/Agent prefixes', () => {
    const session: AgentSession = {
      id: 's1',
      title: 't',
      providerId: 'p1',
      model: 'm',
      messageIds: ['u1', 'a1'],
      createdAt: 1,
      updatedAt: 1,
    };
    const ctx = buildTurnContextFromState(session, ['u1', 'a1'], {
      s1: [
        {
          id: 'u1',
          sessionId: 's1',
          role: 'user',
          blocks: [{ type: 'text', content: 'hi' }],
          status: 'done',
          interactionMode: 'chat',
          providerId: 'p1',
          model: 'm',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'a1',
          sessionId: 's1',
          role: 'assistant',
          blocks: [{ type: 'text', content: 'ok' }],
          status: 'done',
          interactionMode: 'annotation',
          providerId: 'p1',
          model: 'm',
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });
    expect(ctx.transcript).toContain('用户: hi');
    expect(ctx.transcript).toContain('助手: ok');
    expect(ctx.transcript).not.toContain('[Ask]');
    expect(ctx.transcript).not.toContain('[Agent]');
  });
});
