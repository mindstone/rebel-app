import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEEP_LINK_OAUTH_START_BLOCKED_TITLE } from '@core/services/oauthTransport';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/rebel-slack-test'),
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

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: mocks.trackOAuthBrowserOpened,
  trackOAuthStartBlocked: mocks.trackOAuthStartBlocked,
}));

import { cancelSlackAuth, handleSlackOAuthCallback, startSlackAuth } from '../slackAuthService';

const PENDING_AUTH_TIMEOUT_MS = 30 * 60 * 1000;
const PENDING_AUTH_FRESHNESS_MS = 25 * 60 * 1000;

function startAuth(
  clientId = 'client-id',
  clientSecret = 'client-secret',
  options: { autoOpen?: boolean } = { autoOpen: false },
) {
  const result = startSlackAuth(clientId, clientSecret, options);
  result.completion.catch(() => {});
  return result;
}

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

describe('slackAuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreRuntime();
    cancelSlackAuth();
  });

  afterEach(() => {
    cancelSlackAuth();
    restoreRuntime();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('uses the Rebel-hosted redirect URI by default', () => {
    const pending = startAuth();
    const authUrl = new URL(pending.authUrl);

    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://rebel-auth.mindstone.com/slack/callback',
    );
  });

  it('uses SLACK_REDIRECT_URI when configured', () => {
    vi.stubEnv('SLACK_REDIRECT_URI', 'https://example.test/slack/callback');

    const pending = startAuth();
    const authUrl = new URL(pending.authUrl);

    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://example.test/slack/callback');
  });

  it('blocks deep-link OAuth immediately on unpackaged source builds that cannot receive callbacks', () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });

    expect(() => startSlackAuth('client-id', 'client-secret')).toThrow(
      DEEP_LINK_OAUTH_START_BLOCKED_TITLE,
    );
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.trackOAuthBrowserOpened).not.toHaveBeenCalled();
    expect(mocks.trackOAuthStartBlocked).toHaveBeenCalledWith({
      connectorName: 'Slack',
      connectorType: 'bundled',
      reason: 'no_supported_callback_transport',
    });
  });

  it('does not fail-loud on unpackaged Windows dev builds with deep-link delivery', () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'win32', defaultApp: true });

    const pending = startAuth();
    const authUrl = new URL(pending.authUrl);

    expect(authUrl.origin + authUrl.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();
  });

  it('does not fail-loud in packaged builds', () => {
    setDeepLinkRuntime({ isPackaged: true, platform: 'darwin' });

    const pending = startAuth();
    const authUrl = new URL(pending.authUrl);

    expect(authUrl.origin + authUrl.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();
  });

  it('returns the same authUrl and completion promise for fresh idempotent calls', () => {
    const first = startAuth();
    const second = startAuth();

    expect(second.authUrl).toBe(first.authUrl);
    expect(second.completion).toBe(first.completion);
  });

  it('starts a new auth flow when credentials differ within freshness window', async () => {
    const first = startAuth('client-id', 'secret-one');
    const second = startAuth('client-id', 'secret-two');

    expect(second.authUrl).not.toBe(first.authUrl);
    expect(second.completion).not.toBe(first.completion);
    await expect(first.completion).rejects.toThrow('Authorization cancelled');
  });

  it('starts a new auth flow when existing pending auth is stale', async () => {
    vi.useFakeTimers();
    const first = startAuth();
    await vi.advanceTimersByTimeAsync(PENDING_AUTH_FRESHNESS_MS + 1);

    const second = startAuth();

    expect(second.authUrl).not.toBe(first.authUrl);
    expect(second.completion).not.toBe(first.completion);
    await expect(first.completion).rejects.toThrow('Authorization cancelled');
  });

  it('rejects pending auth when the 30-minute timeout elapses', async () => {
    vi.useFakeTimers();
    const pending = startAuth();

    await vi.advanceTimersByTimeAsync(PENDING_AUTH_TIMEOUT_MS);

    await expect(pending.completion).rejects.toThrow('Authorization timed out');
  });

  it('cancelSlackAuth clears pending auth and rejects the persisted completion promise', async () => {
    const first = startAuth();

    cancelSlackAuth();
    await expect(first.completion).rejects.toThrow('Authorization cancelled');

    const second = startAuth();
    expect(second.authUrl).not.toBe(first.authUrl);
    expect(second.completion).not.toBe(first.completion);
  });

  it('preserves pending auth on state mismatch and completes when a matching callback arrives', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: true,
        access_token: 'xoxb-test',
        bot_user_id: 'B123',
        team: { id: 'T123', name: 'Mindstone' },
        authed_user: { id: 'U123' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = startAuth();
    const expectedState = new URL(pending.authUrl).searchParams.get('state');
    if (!expectedState) {
      throw new Error('Expected Slack OAuth URL to include state');
    }

    await handleSlackOAuthCallback(
      `mindstone://slack/callback?code=stale-code&state=wrong-state`,
    );

    const reusedPending = startAuth();
    expect(reusedPending.authUrl).toBe(pending.authUrl);
    expect(reusedPending.completion).toBe(pending.completion);

    const pendingCheck = await Promise.race([
      pending.completion.then(() => 'settled'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);
    expect(pendingCheck).toBe('pending');

    await handleSlackOAuthCallback(
      `mindstone://slack/callback?code=fresh-code&state=${expectedState}`,
    );

    await expect(pending.completion).resolves.toEqual({
      teamId: 'T123',
      teamName: 'Mindstone',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/oauth.v2.access',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
