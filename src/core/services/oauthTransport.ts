export type OAuthTransportOverride = 'loopback' | 'deeplink';

export const DEEP_LINK_OAUTH_START_BLOCKED_TITLE = 'Deep-link sign-in needs the packaged app';
export const DEEP_LINK_OAUTH_START_BLOCKED_BODY =
  "This connector signs in via a `mindstone://` link that a source build can't receive, so sign-in won't complete here. The connector itself is fine. Use a packaged build of Rebel to connect it, or see the source-build auth guide.";
export const DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE =
  `${DEEP_LINK_OAUTH_START_BLOCKED_TITLE}\n\n${DEEP_LINK_OAUTH_START_BLOCKED_BODY}`;

export interface OAuthTransportSelectionInput {
  isPackaged: boolean;
  deepLinkDeliverySupported: boolean;
  supportsDeepLink: boolean;
  supportsLoopback: boolean;
  override?: OAuthTransportOverride;
}

export type OAuthTransportSelection =
  | { mode: 'loopback'; reason: string }
  | { mode: 'deep_link'; reason: string }
  | { mode: 'fail_loud'; reason: string };

export function selectOAuthTransport(
  input: OAuthTransportSelectionInput,
): OAuthTransportSelection {
  const {
    isPackaged,
    deepLinkDeliverySupported,
    supportsDeepLink,
    supportsLoopback,
    override,
  } = input;

  if (override === 'loopback' && supportsLoopback) {
    return { mode: 'loopback', reason: 'override_loopback_supported' };
  }

  if (override === 'deeplink' && supportsDeepLink) {
    return { mode: 'deep_link', reason: 'override_deeplink_supported' };
  }

  if (supportsLoopback && (!isPackaged || !supportsDeepLink)) {
    return {
      mode: 'loopback',
      reason: supportsDeepLink ? 'unpackaged_loopback_supported' : 'always_loopback',
    };
  }

  if (supportsDeepLink && deepLinkDeliverySupported) {
    return { mode: 'deep_link', reason: 'deep_link_delivery_supported' };
  }

  return { mode: 'fail_loud', reason: 'no_supported_callback_transport' };
}
