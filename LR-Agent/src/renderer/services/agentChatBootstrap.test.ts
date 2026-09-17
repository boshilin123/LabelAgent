import { shouldApplyBootstrapResult } from './agentChatBootstrap';

describe('shouldApplyBootstrapResult', () => {
  it('allows persist when generation matches current', () => {
    expect(shouldApplyBootstrapResult(2, 2)).toBe(true);
  });

  it('blocks persist when a newer bootstrap has started', () => {
    expect(shouldApplyBootstrapResult(1, 2)).toBe(false);
  });

  it('blocks persist when generation is behind current', () => {
    expect(shouldApplyBootstrapResult(3, 2)).toBe(false);
  });
});
