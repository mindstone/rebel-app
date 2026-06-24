import { describe, expect, it } from 'vitest';
import {
  DEEP_LINK_OAUTH_START_BLOCKED_BODY,
  DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
  DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
  selectOAuthTransport,
  type OAuthTransportOverride,
  type OAuthTransportSelectionInput,
} from '../oauthTransport';

function expectedMode(input: OAuthTransportSelectionInput): ReturnType<typeof selectOAuthTransport>['mode'] {
  if (input.override === 'loopback' && input.supportsLoopback) return 'loopback';
  if (input.override === 'deeplink' && input.supportsDeepLink) return 'deep_link';
  if (input.supportsLoopback && (!input.isPackaged || !input.supportsDeepLink)) {
    return 'loopback';
  }
  if (input.supportsDeepLink && input.deepLinkDeliverySupported) return 'deep_link';
  return 'fail_loud';
}

describe('selectOAuthTransport', () => {
  it('matches the exhaustive transport truth table', () => {
    const booleans = [false, true] as const;
    const overrides = [undefined, 'loopback', 'deeplink'] as const satisfies readonly (
      OAuthTransportOverride | undefined
    )[];

    for (const isPackaged of booleans) {
      for (const deepLinkDeliverySupported of booleans) {
        for (const supportsDeepLink of booleans) {
          for (const supportsLoopback of booleans) {
            for (const override of overrides) {
              const input: OAuthTransportSelectionInput = {
                isPackaged,
                deepLinkDeliverySupported,
                supportsDeepLink,
                supportsLoopback,
                override,
              };

              expect(selectOAuthTransport(input).mode, JSON.stringify(input)).toBe(
                expectedMode(input),
              );
            }
          }
        }
      }
    }
  });

  it('routes unpackaged win32-dev deep-link-only providers to deep links, not fail-loud', () => {
    expect(selectOAuthTransport({
      isPackaged: false,
      deepLinkDeliverySupported: true,
      supportsDeepLink: true,
      supportsLoopback: false,
    })).toMatchObject({ mode: 'deep_link' });
  });

  it('routes unpackaged mac/Linux-dev deep-link-only providers to fail-loud', () => {
    expect(selectOAuthTransport({
      isPackaged: false,
      deepLinkDeliverySupported: false,
      supportsDeepLink: true,
      supportsLoopback: false,
    })).toMatchObject({ mode: 'fail_loud' });
  });

  it('keeps packaged deep-link-capable providers on deep links without an override', () => {
    expect(selectOAuthTransport({
      isPackaged: true,
      deepLinkDeliverySupported: true,
      supportsDeepLink: true,
      supportsLoopback: true,
    })).toMatchObject({ mode: 'deep_link' });

    expect(selectOAuthTransport({
      isPackaged: true,
      deepLinkDeliverySupported: true,
      supportsDeepLink: true,
      supportsLoopback: false,
    })).toMatchObject({ mode: 'deep_link' });
  });

  it('routes unpackaged loopback-capable providers to loopback by default', () => {
    expect(selectOAuthTransport({
      isPackaged: false,
      deepLinkDeliverySupported: false,
      supportsDeepLink: true,
      supportsLoopback: true,
    })).toMatchObject({ mode: 'loopback' });

    expect(selectOAuthTransport({
      isPackaged: false,
      deepLinkDeliverySupported: false,
      supportsDeepLink: false,
      supportsLoopback: true,
    })).toMatchObject({ mode: 'loopback' });
  });

  it('routes always-loopback providers to loopback on packaged builds', () => {
    expect(selectOAuthTransport({
      isPackaged: true,
      deepLinkDeliverySupported: true,
      supportsDeepLink: false,
      supportsLoopback: true,
    })).toMatchObject({ mode: 'loopback', reason: 'always_loopback' });
  });

  it('honors both override directions when the provider supports the requested transport', () => {
    expect(selectOAuthTransport({
      isPackaged: true,
      deepLinkDeliverySupported: true,
      supportsDeepLink: true,
      supportsLoopback: true,
      override: 'loopback',
    })).toMatchObject({ mode: 'loopback' });

    expect(selectOAuthTransport({
      isPackaged: false,
      deepLinkDeliverySupported: true,
      supportsDeepLink: true,
      supportsLoopback: true,
      override: 'deeplink',
    })).toMatchObject({ mode: 'deep_link' });
  });

  it('preserves OpenRouter-compatible defaults and overrides', () => {
    const openRouterCapabilities = {
      supportsDeepLink: true,
      supportsLoopback: true,
    };

    expect(selectOAuthTransport({
      ...openRouterCapabilities,
      isPackaged: false,
      deepLinkDeliverySupported: false,
    })).toMatchObject({ mode: 'loopback' });

    expect(selectOAuthTransport({
      ...openRouterCapabilities,
      isPackaged: true,
      deepLinkDeliverySupported: true,
    })).toMatchObject({ mode: 'deep_link' });

    expect(selectOAuthTransport({
      ...openRouterCapabilities,
      isPackaged: true,
      deepLinkDeliverySupported: true,
      override: 'loopback',
    })).toMatchObject({ mode: 'loopback' });

    expect(selectOAuthTransport({
      ...openRouterCapabilities,
      isPackaged: false,
      deepLinkDeliverySupported: true,
      override: 'deeplink',
    })).toMatchObject({ mode: 'deep_link' });
  });
});

describe('deep-link OAuth fail-loud copy', () => {
  it('exports a single composed message for guard emitters and renderer detection', () => {
    expect(DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE).toBe(
      `${DEEP_LINK_OAUTH_START_BLOCKED_TITLE}\n\n${DEEP_LINK_OAUTH_START_BLOCKED_BODY}`,
    );
  });
});
