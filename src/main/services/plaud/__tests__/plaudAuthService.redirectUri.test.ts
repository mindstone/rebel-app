import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEEP_LINK_OAUTH_START_BLOCKED_TITLE } from '@core/services/oauthTransport';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/rebel-plaud-test'),
  },
  openExternal: vi.fn().mockResolvedValue(undefined),
  trackOAuthBrowserOpened: vi.fn(),
  trackOAuthStartBlocked: vi.fn(),
}));

vi.mock('electron', () => ({
  app: mocks.app,
  shell: {
    openExternal: mocks.openExternal,
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: mocks.trackOAuthBrowserOpened,
  trackOAuthStartBlocked: mocks.trackOAuthStartBlocked,
}));

vi.mock('../../oauthPrimitives', () => ({
  bringAppToForeground: vi.fn(),
}));

import { cancelPlaudAuth, startPlaudAuth } from '../plaudAuthService';

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

function startAuthUrl(): URL {
  const result = startPlaudAuth('plaud-client-id', 'plaud-client-secret', { autoOpen: false });
  result.completion.catch(() => undefined);
  return new URL(result.authUrl);
}

describe('plaudAuthService redirect URI resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreRuntime();
    cancelPlaudAuth();
  });

  afterEach(() => {
    cancelPlaudAuth();
    restoreRuntime();
    vi.unstubAllEnvs();
  });

  it('uses the Rebel-hosted redirect URI by default', () => {
    const authUrl = startAuthUrl();

    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://rebel-auth.mindstone.com/plaud/callback',
    );
  });

  it('uses PLAUD_REDIRECT_URI when configured', () => {
    vi.stubEnv('PLAUD_REDIRECT_URI', 'https://example.test/plaud/callback');

    const authUrl = startAuthUrl();

    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://example.test/plaud/callback');
  });

  it('blocks deep-link OAuth immediately on unpackaged source builds that cannot receive callbacks', () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });

    expect(() => startPlaudAuth('plaud-client-id', 'plaud-client-secret')).toThrow(
      DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
    );
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.trackOAuthBrowserOpened).not.toHaveBeenCalled();
    expect(mocks.trackOAuthStartBlocked).toHaveBeenCalledWith({
      connectorName: 'Plaud',
      connectorType: 'bundled',
      reason: 'no_supported_callback_transport',
    });
  });

  it('does not fail-loud on unpackaged Windows dev builds with deep-link delivery', () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'win32', defaultApp: true });

    const authUrl = startAuthUrl();

    expect(authUrl.origin + authUrl.pathname).toBe('https://app.plaud.ai/platform/oauth');
    expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();
  });

  it('does not fail-loud in packaged builds', () => {
    setDeepLinkRuntime({ isPackaged: true, platform: 'darwin' });

    const authUrl = startAuthUrl();

    expect(authUrl.origin + authUrl.pathname).toBe('https://app.plaud.ai/platform/oauth');
    expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();
  });
});
