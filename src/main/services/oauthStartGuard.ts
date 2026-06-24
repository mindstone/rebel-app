import { app } from 'electron';
import { createScopedLogger } from '@core/logger';
import {
  DEEP_LINK_OAUTH_START_BLOCKED_BODY,
  DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
  DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
  selectOAuthTransport,
} from '@core/services/oauthTransport';
import { isDeepLinkDeliverySupported } from './oauthDeepLinkSupport';
import { trackOAuthStartBlocked, type ConnectorType } from './oauthTelemetry';

const log = createScopedLogger({ service: 'oauth-start-guard' });

export interface DeepLinkOAuthStartBlocked {
  connectorName: string;
  connectorType: ConnectorType;
  title: string;
  body: string;
  message: string;
  reason: string;
}

export function checkDeepLinkOAuthStartBlocked(
  connectorName: string,
  connectorType: ConnectorType = 'bundled',
): DeepLinkOAuthStartBlocked | null {
  const deepLinkSupported = isDeepLinkDeliverySupported();
  const transport = selectOAuthTransport({
    isPackaged: app.isPackaged,
    deepLinkDeliverySupported: deepLinkSupported,
    supportsDeepLink: true,
    supportsLoopback: false,
  });

  if (transport.mode !== 'fail_loud') {
    return null;
  }

  const blocked: DeepLinkOAuthStartBlocked = {
    connectorName,
    connectorType,
    title: DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
    body: DEEP_LINK_OAUTH_START_BLOCKED_BODY,
    message: DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
    reason: transport.reason,
  };

  log.warn(
    {
      connectorName,
      connectorType,
      reason: blocked.reason,
      isPackaged: app.isPackaged,
      deepLinkDeliverySupported: deepLinkSupported,
      platform: process.platform,
      isDefaultApp: Boolean(process.defaultApp),
    },
    'Blocked deep-link OAuth start because no callback transport is available',
  );
  trackOAuthStartBlocked({
    connectorName,
    connectorType,
    reason: blocked.reason,
  });

  return blocked;
}
