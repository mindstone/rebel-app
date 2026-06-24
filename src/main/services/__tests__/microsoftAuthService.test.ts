import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE } from '@core/services/oauthTransport';

type MicrosoftAuthServiceModule = typeof import('../microsoftAuthService');
type MockLoopbackRequest = { method?: string; url?: string };
type MockLoopbackResponse = {
  status: number;
  body: string;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
type MockLoopbackHandler = (
  req: MockLoopbackRequest,
  res: MockLoopbackResponse,
) => void;
type MockLoopbackServer = {
  handler: MockLoopbackHandler;
  listen: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let tempUserData: string;
const PENDING_AUTH_TTL_MS = 5 * 60 * 1000;

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return tempUserData;
      return '/tmp';
    }),
  },
  openExternal: vi.fn().mockResolvedValue(undefined),
  getAvailablePort: vi.fn(async (_preferredPort?: number, _host?: string) => 31_337),
  generateCsrfState: vi.fn(() => 'csrf-state-fixture'),
  bringAppToForeground: vi.fn(),
  trackOAuthBrowserOpened: vi.fn(),
  trackOAuthStartBlocked: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const mockHttp = vi.hoisted(() => {
  const state = {
    servers: [] as MockLoopbackServer[],
  };

  const createServer = vi.fn((handler: MockLoopbackHandler) => {
    const server = {
      handler,
      listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
        callback?.();
        return server;
      }),
      on: vi.fn(() => server),
      close: vi.fn((callback?: (err?: Error & { code?: string }) => void) => {
        callback?.();
        return server;
      }),
    };
    state.servers.push(server);
    return server;
  });

  return { createServer, state };
});

vi.mock('electron', () => ({
  app: mocks.app,
  shell: {
    openExternal: mocks.openExternal,
  },
}));

vi.mock('node:http', () => ({
  default: { createServer: mockHttp.createServer },
  createServer: mockHttp.createServer,
}));

vi.mock('../../utils/systemUtils', () => ({
  getAvailablePort: (preferredPort?: number, host?: string) =>
    mocks.getAvailablePort(preferredPort, host),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
  }),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: mocks.captureException,
    captureMessage: mocks.captureMessage,
    addBreadcrumb: vi.fn(),
  }),
  setErrorReporter: vi.fn(),
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: mocks.trackOAuthBrowserOpened,
  trackOAuthStartBlocked: mocks.trackOAuthStartBlocked,
}));

vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: mocks.generateCsrfState,
  bringAppToForeground: mocks.bringAppToForeground,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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

async function loadService(): Promise<MicrosoftAuthServiceModule> {
  return import('../microsoftAuthService');
}

function pendingAuthPath(): string {
  return path.join(tempUserData, 'microsoft-mcp', '.pending-auth.json');
}

function accountsPath(): string {
  return path.join(tempUserData, 'microsoft-mcp', 'accounts.json');
}

function tokenPath(email: string): string {
  return path.join(
    tempUserData,
    'microsoft-mcp',
    'credentials',
    `${email.replace(/[^a-zA-Z0-9]/g, '-')}.token.json`,
  );
}

async function readPersistedPendingAuth(): Promise<{
  clientId: string;
  state: string;
  codeVerifier: string;
}> {
  return JSON.parse(await fs.readFile(pendingAuthPath(), 'utf-8')) as {
    clientId: string;
    state: string;
    codeVerifier: string;
  };
}

async function expectFileMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toThrow();
}

function mockSuccessfulMicrosoftFetch(email = 'ada@example.com'): void {
  mockFetch.mockImplementation(async (url: string | URL) => {
    const urlString = String(url);
    if (urlString === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
      return {
        ok: true,
        json: async () => ({
          access_token: 'access-token-fixture',
          refresh_token: 'refresh-token-fixture',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'offline_access User.Read Mail.Read',
        }),
      };
    }

    if (urlString === 'https://graph.microsoft.com/v1.0/me') {
      return {
        ok: true,
        json: async () => ({
          mail: email,
          userPrincipalName: email,
          displayName: 'Ada Example',
        }),
      };
    }

    throw new Error(`Unexpected fetch URL: ${urlString}`);
  });
}

function tokenExchangeBody(): URLSearchParams {
  const tokenCall = mockFetch.mock.calls.find(
    ([url]) => String(url) === 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  );
  if (!tokenCall) {
    throw new Error('Expected Microsoft token exchange call');
  }
  const init = tokenCall[1] as RequestInit;
  return new URLSearchParams(String(init.body));
}

function createMockResponse(): MockLoopbackResponse {
  const response = {
    status: 0,
    body: '',
  } as MockLoopbackResponse;

  response.writeHead = vi.fn((status: number) => {
    response.status = status;
    return response;
  });
  response.end = vi.fn((body?: unknown) => {
    response.body += body === undefined ? '' : String(body);
    return response;
  });

  return response;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function invokeLoopbackCallback(callbackUrl: URL): MockLoopbackResponse {
  const server = mockHttp.state.servers.at(-1);
  if (!server) {
    throw new Error('Expected loopback callback server');
  }

  const response = createMockResponse();
  server.handler(
    { method: 'GET', url: `${callbackUrl.pathname}${callbackUrl.search}` },
    response,
  );
  return response;
}

describe('microsoftAuthService OAuth transport', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    restoreRuntime();
    tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-oauth-transport-'));
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.getAvailablePort.mockResolvedValue(31_337);
    mocks.generateCsrfState.mockReturnValue('csrf-state-fixture');
    mockHttp.state.servers.length = 0;
    mockFetch.mockReset();
  });

  afterEach(async () => {
    const service = await loadService();
    service.cancelMicrosoftAuth();
    service.__resetMicrosoftAuthMemoryForTests();
    await fs.rm(tempUserData, { recursive: true, force: true });
    restoreRuntime();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('fails loud before browser or pending state when loopback capability is disabled', async () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();
    service.__setMicrosoftLoopbackCapableForTests(false);

    await expect(service.beginMicrosoftAuthFlow('client-id')).rejects.toThrow(
      DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
    );

    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.trackOAuthBrowserOpened).not.toHaveBeenCalled();
    expect(mocks.getAvailablePort).not.toHaveBeenCalled();
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    await expectFileMissing(pendingAuthPath());
    expect(mocks.trackOAuthStartBlocked).toHaveBeenCalledWith({
      connectorName: 'Microsoft',
      connectorType: 'bundled',
      reason: 'no_supported_callback_transport',
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorName: 'Microsoft',
        reason: 'no_supported_callback_transport',
        isPackaged: false,
        deepLinkDeliverySupported: false,
        microsoftLoopbackCapable: false,
      }),
      'Blocked Microsoft OAuth start because no callback transport is available',
    );
  });

  it('keeps unpackaged Windows dev builds on the deep-link transport when loopback capability is disabled', async () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'win32', defaultApp: true });
    const service = await loadService();
    service.__setMicrosoftLoopbackCapableForTests(false);

    const result = await service.beginMicrosoftAuthFlow('client-id');
    const authUrl = new URL(result.authUrl);

    expect(authUrl.origin + authUrl.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://rebel-auth.mindstone.com/microsoft/callback',
    );
    expect(mocks.getAvailablePort).not.toHaveBeenCalled();
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();

    service.cancelMicrosoftAuth();
    await expect(result.awaitedEmail).rejects.toThrow('Auth cancelled by user');
  });

  it.each(['darwin', 'linux'] as const)(
    'uses localhost loopback by default in unpackaged %s dev builds',
    async (platform) => {
      setDeepLinkRuntime({ isPackaged: false, platform });
      const service = await loadService();
      mockSuccessfulMicrosoftFetch();

      const result = await service.beginMicrosoftAuthFlow('client-id');
      const authUrl = new URL(result.authUrl);
      const redirectUri = authUrl.searchParams.get('redirect_uri');

      expect(redirectUri).toBe('http://localhost:31337/callback');
      expect(authUrl.searchParams.get('state')).toBe('csrf-state-fixture');
      expect(mocks.getAvailablePort).toHaveBeenCalledWith(undefined, 'localhost');
      expect(mockHttp.createServer).toHaveBeenCalled();
      expect(mockHttp.state.servers[0]?.listen).toHaveBeenCalledWith(
        31_337,
        'localhost',
        expect.any(Function),
      );
      expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();
      await expectFileMissing(pendingAuthPath());

      const callbackUrl = new URL(redirectUri ?? '');
      callbackUrl.searchParams.set('code', 'default-loopback-code');
      callbackUrl.searchParams.set('state', 'csrf-state-fixture');
      const response = invokeLoopbackCallback(callbackUrl);

      await expect(result.awaitedEmail).resolves.toBe('ada@example.com');
      expect(response.status).toBe(200);

      const exchangeBody = tokenExchangeBody();
      expect(exchangeBody.get('code')).toBe('default-loopback-code');
      expect(exchangeBody.get('redirect_uri')).toBe('http://localhost:31337/callback');
      expect(exchangeBody.has('client_secret')).toBe(false);
    },
  );

  it('uses localhost loopback by default in unpackaged Windows dev builds', async () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'win32', defaultApp: true });
    const service = await loadService();

    const result = await service.beginMicrosoftAuthFlow('client-id');
    const authUrl = new URL(result.authUrl);

    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost:31337/callback',
    );
    expect(mocks.getAvailablePort).toHaveBeenCalledWith(undefined, 'localhost');
    expect(mockHttp.createServer).toHaveBeenCalled();
    expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();

    service.cancelMicrosoftAuth();
    await expect(result.awaitedEmail).rejects.toThrow('Auth cancelled by user');
  });

  it('keeps packaged builds on the deep-link transport', async () => {
    setDeepLinkRuntime({ isPackaged: true, platform: 'linux' });
    const service = await loadService();

    const result = await service.beginMicrosoftAuthFlow('client-id');
    const authUrl = new URL(result.authUrl);

    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://rebel-auth.mindstone.com/microsoft/callback',
    );
    expect(mocks.getAvailablePort).not.toHaveBeenCalled();
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();

    service.cancelMicrosoftAuth();
    await expect(result.awaitedEmail).rejects.toThrow('Auth cancelled by user');
  });

  it('keeps the deep-link pending auth timer responsible for deep-link timeouts', async () => {
    vi.useFakeTimers();
    setDeepLinkRuntime({ isPackaged: true, platform: 'linux' });
    const service = await loadService();

    const result = await service.beginMicrosoftAuthFlow('client-id');
    const authUrl = new URL(result.authUrl);

    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://rebel-auth.mindstone.com/microsoft/callback',
    );
    expect(mocks.getAvailablePort).not.toHaveBeenCalled();
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(PENDING_AUTH_TTL_MS);

    await expect(result.awaitedEmail).rejects.toThrow('Authorization timed out');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('completes a packaged cold-start callback from persisted pending auth', async () => {
    setDeepLinkRuntime({ isPackaged: true, platform: 'darwin' });
    const service = await loadService();

    const result = await service.beginMicrosoftAuthFlow('client-id');
    const authUrl = new URL(result.authUrl);
    expect(authUrl.searchParams.get('state')).toBe('csrf-state-fixture');

    await vi.waitFor(async () => {
      await fs.access(pendingAuthPath());
    });
    const persistedAuth = await readPersistedPendingAuth();
    expect(persistedAuth.clientId).toBe('client-id');
    expect(persistedAuth.state).toBe('csrf-state-fixture');
    expect(persistedAuth.codeVerifier).toBeTruthy();

    service.__resetMicrosoftAuthMemoryForTests();
    mockSuccessfulMicrosoftFetch();

    await service.handleMicrosoftOAuthCallback(
      'mindstone://microsoft/callback?code=deep-link-code&state=csrf-state-fixture',
    );

    const exchangeBody = tokenExchangeBody();
    expect(exchangeBody.get('code')).toBe('deep-link-code');
    expect(exchangeBody.get('redirect_uri')).toBe(
      'https://rebel-auth.mindstone.com/microsoft/callback',
    );
    expect(exchangeBody.has('client_secret')).toBe(false);

    await vi.waitFor(async () => {
      await expectFileMissing(pendingAuthPath());
    });
    const accounts = JSON.parse(await fs.readFile(accountsPath(), 'utf-8')) as {
      accounts: Array<{ email: string; displayName?: string }>;
    };
    expect(accounts.accounts).toEqual([
      { email: 'ada@example.com', displayName: 'Ada Example' },
    ]);
    const token = JSON.parse(await fs.readFile(tokenPath('ada@example.com'), 'utf-8')) as {
      refresh_token?: string;
      expires_at?: number;
    };
    expect(token.refresh_token).toBe('refresh-token-fixture');
    expect(typeof token.expires_at).toBe('number');
  });

  it('rejects packaged deep-link callbacks with mismatched CSRF state before exchange', async () => {
    setDeepLinkRuntime({ isPackaged: true, platform: 'darwin' });
    const service = await loadService();

    const result = await service.beginMicrosoftAuthFlow('client-id');

    await service.handleMicrosoftOAuthCallback(
      'mindstone://microsoft/callback?code=deep-link-code&state=wrong-state',
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      'Microsoft OAuth state mismatch - possible CSRF',
      expect.objectContaining({
        tags: expect.objectContaining({ security: 'csrf' }),
      }),
    );

    service.cancelMicrosoftAuth();
    await expect(result.awaitedEmail).rejects.toThrow('Auth cancelled by user');
  });

  it('uses localhost loopback with matching secretless token exchange when the flag is enabled', async () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();
    service.__setMicrosoftLoopbackCapableForTests(true);
    mockSuccessfulMicrosoftFetch();

    const result = await service.beginMicrosoftAuthFlow('client-id');
    const authUrl = new URL(result.authUrl);
    const redirectUri = authUrl.searchParams.get('redirect_uri');

    expect(redirectUri).toBe('http://localhost:31337/callback');
    expect(authUrl.searchParams.get('state')).toBe('csrf-state-fixture');
    expect(mocks.getAvailablePort).toHaveBeenCalledWith(undefined, 'localhost');
    expect(mockHttp.state.servers[0]?.listen).toHaveBeenCalledWith(
      31_337,
      'localhost',
      expect.any(Function),
    );
    await expectFileMissing(pendingAuthPath());

    const callbackUrl = new URL(redirectUri ?? '');
    callbackUrl.searchParams.set('code', 'loopback-code');
    callbackUrl.searchParams.set('state', 'csrf-state-fixture');
    const response = invokeLoopbackCallback(callbackUrl);

    await expect(result.awaitedEmail).resolves.toBe('ada@example.com');
    expect(response.status).toBe(200);

    const exchangeBody = tokenExchangeBody();
    expect(exchangeBody.get('code')).toBe('loopback-code');
    expect(exchangeBody.get('redirect_uri')).toBe('http://localhost:31337/callback');
    expect(exchangeBody.has('client_secret')).toBe(false);
  });

  it('lets the loopback controller own timeout cleanup without a pending-auth timer race', async () => {
    vi.useFakeTimers();
    setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();

    const result = await service.beginMicrosoftAuthFlow('client-id');
    const authUrl = new URL(result.authUrl);
    const redirectUri = authUrl.searchParams.get('redirect_uri');

    expect(redirectUri).toBe('http://localhost:31337/callback');
    expect(mocks.getAvailablePort).toHaveBeenCalledWith(undefined, 'localhost');
    expect(mockHttp.createServer).toHaveBeenCalled();
    await expectFileMissing(pendingAuthPath());
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(PENDING_AUTH_TTL_MS);

    await expect(result.awaitedEmail).rejects.toThrow('Authorization timed out');
    expect(vi.getTimerCount()).toBe(0);

    mockSuccessfulMicrosoftFetch();
    const callbackUrl = new URL(redirectUri ?? '');
    callbackUrl.searchParams.set('code', 'late-loopback-code');
    callbackUrl.searchParams.set('state', 'csrf-state-fixture');
    const response = invokeLoopbackCallback(callbackUrl);
    await flushPromises();

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects loopback callbacks with mismatched CSRF state before exchange', async () => {
    setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();
    service.__setMicrosoftLoopbackCapableForTests(true);

    const result = await service.beginMicrosoftAuthFlow('client-id');
    const authUrl = new URL(result.authUrl);
    const callbackUrl = new URL(authUrl.searchParams.get('redirect_uri') ?? '');
    callbackUrl.searchParams.set('code', 'loopback-code');
    callbackUrl.searchParams.set('state', 'wrong-state');

    const response = invokeLoopbackCallback(callbackUrl);

    await expect(result.awaitedEmail).rejects.toThrow(
      'OAuth state mismatch - possible CSRF attack',
    );
    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
