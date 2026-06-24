import { DEEP_LINK_OAUTH_START_BLOCKED_TITLE } from '@core/services/oauthTransport';
import type { CloudErrorInfo } from '../../../../core/services/cloudErrorMapper';
export {
  DEEP_LINK_OAUTH_START_BLOCKED_BODY,
  DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
  DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
} from '@core/services/oauthTransport';
export const SOURCE_BUILD_AUTH_GUIDE_REFERENCE = 'docs/project/AUTHENTICATION.md';

export interface DeepLinkOAuthStartBlockedCopy {
  title: string;
  body: string;
}

export function parseDeepLinkOAuthStartBlockedMessage(message: string | null | undefined): DeepLinkOAuthStartBlockedCopy | null {
  if (typeof message !== 'string') {
    return null;
  }

  const trimmed = message.trim();
  if (!trimmed.startsWith(DEEP_LINK_OAUTH_START_BLOCKED_TITLE)) {
    return null;
  }

  const [rawTitle, ...rawBody] = trimmed.split('\n\n');
  const body = rawBody.join('\n\n').trim();

  return {
    title: rawTitle.trim() || DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
    body: body || trimmed,
  };
}

export function isDeepLinkOAuthStartBlockedMessage(message: string | null | undefined): boolean {
  return parseDeepLinkOAuthStartBlockedMessage(message) !== null;
}

export function cloudErrorInfoForDeepLinkOAuthStartBlocked(rawError: string): CloudErrorInfo | null {
  const parsed = parseDeepLinkOAuthStartBlockedMessage(rawError);
  if (!parsed) {
    return null;
  }

  return {
    category: 'unknown',
    userMessage: parsed.title,
    guidance: `${parsed.body} Guide: ${SOURCE_BUILD_AUTH_GUIDE_REFERENCE}.`,
    helpKey: undefined,
    severity: 'error',
    technicalDetail: rawError,
  };
}
