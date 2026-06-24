import { describe, expect, it } from 'vitest';
import {
  DEEP_LINK_OAUTH_START_BLOCKED_BODY,
  DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
  DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
} from '@core/services/oauthTransport';
import {
  SOURCE_BUILD_AUTH_GUIDE_REFERENCE,
  cloudErrorInfoForDeepLinkOAuthStartBlocked,
  isDeepLinkOAuthStartBlockedMessage,
  parseDeepLinkOAuthStartBlockedMessage,
} from '../deepLinkOAuthStartBlocked';

describe('deepLinkOAuthStartBlocked renderer helpers', () => {
  it('detects and parses the shared fail-loud OAuth message', () => {
    expect(isDeepLinkOAuthStartBlockedMessage(DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE)).toBe(true);

    expect(parseDeepLinkOAuthStartBlockedMessage(DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE)).toEqual({
      title: DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
      body: DEEP_LINK_OAUTH_START_BLOCKED_BODY,
    });
  });

  it('preserves the fail-loud copy for DigitalOcean cloud errors', () => {
    const mapped = cloudErrorInfoForDeepLinkOAuthStartBlocked(DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE);

    expect(mapped).toMatchObject({
      userMessage: DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
      severity: 'error',
      technicalDetail: DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
    });
    expect(mapped?.guidance).toContain(DEEP_LINK_OAUTH_START_BLOCKED_BODY);
    expect(mapped?.guidance).toContain(SOURCE_BUILD_AUTH_GUIDE_REFERENCE);
    expect(mapped?.userMessage).not.toBe("Setup stalled on something we didn't recognize");
  });

  it('ignores unrelated errors', () => {
    expect(isDeepLinkOAuthStartBlockedMessage('DigitalOcean authentication failed.')).toBe(false);
    expect(cloudErrorInfoForDeepLinkOAuthStartBlocked('DigitalOcean authentication failed.')).toBeNull();
  });
});
