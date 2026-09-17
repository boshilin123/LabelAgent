import { describe, expect, it, beforeEach } from '@jest/globals';
import {
  isValidResetToken,
  parseResetDeepLink,
  setPendingResetToken,
  takePendingResetToken,
} from './resetDeepLink';

const VALID_TOKEN = 'a'.repeat(32);

describe('resetDeepLink', () => {
  beforeEach(() => {
    takePendingResetToken();
  });

  it('parses a well-formed deep link', () => {
    expect(
      parseResetDeepLink(`lr-agent://reset-password?token=${VALID_TOKEN}`),
    ).toBe(VALID_TOKEN);
    expect(
      parseResetDeepLink(
        `lr-agent://reset-password/?token=${VALID_TOKEN}&extra=1`,
      ),
    ).toBe(VALID_TOKEN);
  });

  it('rejects wrong scheme, path, or missing token', () => {
    expect(parseResetDeepLink(null)).toBeNull();
    expect(parseResetDeepLink('https://example.com/reset-password')).toBeNull();
    expect(parseResetDeepLink('lr-agent://other?token=x')).toBeNull();
    expect(parseResetDeepLink('lr-agent://reset-password')).toBeNull();
    expect(
      parseResetDeepLink('lr-agent://reset-password-extra?token=x'),
    ).toBeNull();
  });

  it('rejects tokens with bad length or characters', () => {
    expect(isValidResetToken('short')).toBe(false);
    expect(isValidResetToken('a'.repeat(4096))).toBe(false);
    expect(isValidResetToken(`${'a'.repeat(31)}<script>`)).toBe(false);
    expect(
      parseResetDeepLink('lr-agent://reset-password?token=%3Cscript%3E'),
    ).toBeNull();
  });

  it('stores only valid tokens and clears after use', () => {
    setPendingResetToken('bad token with space');
    expect(takePendingResetToken()).toBeNull();

    setPendingResetToken(VALID_TOKEN);
    expect(takePendingResetToken()).toBe(VALID_TOKEN);
    expect(takePendingResetToken()).toBeNull();
  });
});
