import { Notice } from '@renderer/components/ui';
import {
  SOURCE_BUILD_AUTH_GUIDE_REFERENCE,
  parseDeepLinkOAuthStartBlockedMessage,
} from '../utils/deepLinkOAuthStartBlocked';

interface DeepLinkOAuthStartBlockedNoticeProps {
  message: string | null | undefined;
  density?: 'standard' | 'compact';
}

export function DeepLinkOAuthStartBlockedNotice({
  message,
  density = 'standard',
}: DeepLinkOAuthStartBlockedNoticeProps) {
  const parsed = parseDeepLinkOAuthStartBlockedMessage(message);
  if (!parsed) {
    return null;
  }

  return (
    <Notice
      tone="error"
      placement="inline"
      role="alert"
      density={density}
      title={parsed.title}
      data-testid="deep-link-oauth-start-blocked-notice"
    >
      <p>{parsed.body}</p>
      <p>
        Guide: <code>{SOURCE_BUILD_AUTH_GUIDE_REFERENCE}</code>.
      </p>
    </Notice>
  );
}
