import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEP_LINK_OAUTH_START_BLOCKED_BODY,
  DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
  DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
} from '@core/services/oauthTransport';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  trackOAuthStartBlocked: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: mocks.app,
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthStartBlocked: mocks.trackOAuthStartBlocked,
}));

import {
  checkDeepLinkOAuthStartBlocked,
} from '../oauthStartGuard';

const originalPlatform = process.platform;
const originalDefaultAppDescriptor = Object.getOwnPropertyDescriptor(process, 'defaultApp');

function setDeepLinkRuntime(input: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  defaultApp?: boolean;
}): void {
  mocks.app.isPackaged = input.isPackaged;
  Object.defineProperty(process, 'platform', { value: input.platform, configurable: true });
  Object.defineProperty(process, 'defaultApp', {
    value: input.defaultApp ?? false,
    configurable: true,
  });
}

function restoreRuntime(): void {
  mocks.app.isPackaged = true;
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalDefaultAppDescriptor) {
    Object.defineProperty(process, 'defaultApp', originalDefaultAppDescriptor);
  } else {
    delete (process as unknown as { defaultApp?: boolean }).defaultApp;
  }
}

describe('oauthStartGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreRuntime();
  });

  afterEach(() => {
    restoreRuntime();
  });

  it('blocks deep-link-only OAuth immediately on unpackaged source builds without callback delivery', () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });

    const blocked = checkDeepLinkOAuthStartBlocked('Slack');

    expect(blocked).toEqual({
      connectorName: 'Slack',
      connectorType: 'bundled',
      title: DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
      body: DEEP_LINK_OAUTH_START_BLOCKED_BODY,
      message: DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
      reason: 'no_supported_callback_transport',
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorName: 'Slack',
        reason: 'no_supported_callback_transport',
        isPackaged: false,
        deepLinkDeliverySupported: false,
        platform: 'darwin',
      }),
      'Blocked deep-link OAuth start because no callback transport is available',
    );
    expect(mocks.trackOAuthStartBlocked).toHaveBeenCalledWith({
      connectorName: 'Slack',
      connectorType: 'bundled',
      reason: 'no_supported_callback_transport',
    });
  });

  it('allows unpackaged Windows dev builds when deep-link delivery is registered with dev args', () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'win32', defaultApp: true });

    expect(checkDeepLinkOAuthStartBlocked('Slack')).toBeNull();
    expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('allows packaged builds', () => {
    setDeepLinkRuntime({ isPackaged: true, platform: 'darwin' });

    expect(checkDeepLinkOAuthStartBlocked('Slack')).toBeNull();
    expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('uses copy distinct from credentials-not-configured errors', () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'linux' });

    const blocked = checkDeepLinkOAuthStartBlocked('GitHub');

    expect(blocked?.message).toBe(DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE);
    expect(blocked?.message).toContain('source build');
    expect(blocked?.message).toContain('packaged build');
    expect(blocked?.message).not.toMatch(/credentials|client secret|client_secret/i);
  });
});
