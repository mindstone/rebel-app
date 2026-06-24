import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';

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

const SALESFORCE_LOOPBACK_PORT = 47823;

// Mock electron before importing the module
const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/mock/user-data'),
  },
  openExternal: vi.fn().mockResolvedValue(undefined),
  getAvailablePort: vi.fn(async (_preferredPort?: number, _host?: string) => 47_823),
  generateCsrfState: vi.fn(() => 'mock-csrf-state'),
  bringAppToForeground: vi.fn(),
  trackOAuthBrowserOpened: vi.fn(),
  trackOAuthStartBlocked: vi.fn(),
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
  getAvailablePort: (preferredPort?: number, host?: '127.0.0.1' | 'localhost') =>
    mocks.getAvailablePort(preferredPort, host),
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: mocks.trackOAuthBrowserOpened,
  trackOAuthStartBlocked: mocks.trackOAuthStartBlocked,
}));

// Mock oauthPrimitives
vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: mocks.generateCsrfState,
  fetchWithTimeoutBestEffort: vi.fn().mockResolvedValue({ ok: true }),
  bringAppToForeground: mocks.bringAppToForeground,
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock settingsStore — default to production (no environment set)
const mockGetSettings = vi.fn().mockReturnValue({});
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}));

import {
  startSalesforceAuth,
  handleSalesforceOAuthCallback,
  cancelSalesforceAuth,
  __resetSalesforceAuthMemoryForTests,
} from '../salesforceAuthService';
import { shell } from 'electron';

const mockFetch = vi.fn();

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

function invokeLoopbackCallback(callbackUrl: URL, serverIndex = -1): MockLoopbackResponse {
  const server = serverIndex === -1
    ? mockHttp.state.servers.at(-1)
    : mockHttp.state.servers[serverIndex];
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

// Helper to build a callback URL with given params
function buildCallbackUrl(params: Record<string, string>): string {
  const url = new URL('mindstone://salesforce/callback');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function mockSuccessfulSalesforceFetch(): void {
  const identityUrl = 'https://login.salesforce.com/id/00Dfixture/005fixture';
  mockFetch.mockImplementation(async (url: string | URL) => {
    const urlString = String(url);
    if (urlString.endsWith('/services/oauth2/token')) {
      return {
        ok: true,
        json: async () => ({
          access_token: 'salesforce-access-token',
          refresh_token: 'salesforce-refresh-token',
          instance_url: 'https://example.my.salesforce.com',
          id: identityUrl,
          issued_at: '1700000000000',
          signature: 'salesforce-signature',
        }),
      };
    }
    if (urlString === identityUrl) {
      return {
        ok: true,
        json: async () => ({
          username: 'ada@example.com',
          organization_id: '00Dfixture',
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${urlString}`);
  });
}

function tokenExchangeBody(): URLSearchParams {
  const tokenCall = mockFetch.mock.calls.find(
    ([url]) => String(url).endsWith('/services/oauth2/token'),
  );
  if (!tokenCall) {
    throw new Error('Expected Salesforce token exchange call');
  }
  const init = tokenCall[1] as RequestInit;
  return new URLSearchParams(String(init.body));
}

function expectSalesforceArtifactsPersisted(): void {
  const writeFile = vi.mocked(fs.writeFile);
  const tokenWrite = writeFile.mock.calls.find(
    ([filePath]) => String(filePath).endsWith('/credentials/ada-example.com.token.json'),
  );
  expect(tokenWrite).toBeTruthy();
  const tokenJson = JSON.parse(String(tokenWrite?.[1])) as {
    access_token?: string;
    refresh_token?: string;
    username?: string;
    organization_id?: string;
  };
  expect(tokenJson.access_token).toBe('salesforce-access-token');
  expect(tokenJson.refresh_token).toBe('salesforce-refresh-token');
  expect(tokenJson.username).toBe('ada@example.com');
  expect(tokenJson.organization_id).toBe('00Dfixture');

  const accountsWrite = writeFile.mock.calls.find(
    ([filePath]) => String(filePath).endsWith('/mcp/salesforce/accounts.json'),
  );
  expect(accountsWrite).toBeTruthy();
  const accountsJson = JSON.parse(String(accountsWrite?.[1])) as {
    accounts?: Array<{
      id?: string;
      username?: string;
      instance_url?: string;
      is_sandbox?: boolean;
      organization_id?: string;
    }>;
  };
  expect(accountsJson.accounts?.[0]).toMatchObject({
    id: 'ada-example.com',
    username: 'ada@example.com',
    instance_url: 'https://example.my.salesforce.com',
    is_sandbox: false,
    organization_id: '00Dfixture',
  });
}

describe('salesforceAuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreRuntime();
    vi.unstubAllEnvs();
    mockGetSettings.mockReturnValue({});
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.getAvailablePort.mockResolvedValue(SALESFORCE_LOOPBACK_PORT);
    mocks.generateCsrfState.mockReturnValue('mock-csrf-state');
    mockHttp.state.servers.length = 0;
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    // Cancel any pending auth between tests
    cancelSalesforceAuth();
  });

  afterEach(() => {
    cancelSalesforceAuth();
    __resetSalesforceAuthMemoryForTests();
    restoreRuntime();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('OAuth transport', () => {
    it('keeps packaged builds on the deep-link transport and exchanges with the worker redirect', async () => {
      setDeepLinkRuntime({ isPackaged: true, platform: 'linux' });
      mockSuccessfulSalesforceFetch();

      const authPromise = startSalesforceAuth('client-id', 'client-secret');

      await vi.waitFor(() => {
        expect(mocks.openExternal).toHaveBeenCalledTimes(1);
      });

      const oauthUrl = new URL(mocks.openExternal.mock.calls[0][0] as string);
      const redirectUri = oauthUrl.searchParams.get('redirect_uri');

      expect(oauthUrl.origin + oauthUrl.pathname).toBe(
        'https://login.salesforce.com/services/oauth2/authorize',
      );
      expect(redirectUri).toBe('https://rebel-auth.mindstone.com/salesforce/callback');
      expect(redirectUri).not.toContain('localhost');
      expect(mocks.getAvailablePort).not.toHaveBeenCalled();
      expect(mockHttp.createServer).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(mocks.trackOAuthBrowserOpened).toHaveBeenCalledWith({
          connectorName: 'Salesforce',
          connectorType: 'bundled',
          oauthUrl: oauthUrl.toString(),
          callbackMethod: 'deep_link',
        });
      });
      expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();

      await handleSalesforceOAuthCallback(
        `mindstone://salesforce/callback?code=deep-link-code&state=${oauthUrl.searchParams.get('state')}`,
      );

      await expect(authPromise).resolves.toBe('ada@example.com');
      const exchangeBody = tokenExchangeBody();
      expect(exchangeBody.get('code')).toBe('deep-link-code');
      expect(exchangeBody.get('redirect_uri')).toBe(
        'https://rebel-auth.mindstone.com/salesforce/callback',
      );
      expect(exchangeBody.get('client_secret')).toBe('client-secret');
      expectSalesforceArtifactsPersisted();
    });

    it('uses fixed localhost loopback in unpackaged builds and persists the connected account', async () => {
      setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });
      mockSuccessfulSalesforceFetch();

      const authPromise = startSalesforceAuth('client-id', 'client-secret');

      await vi.waitFor(() => {
        expect(mocks.openExternal).toHaveBeenCalledTimes(1);
      });

      const oauthUrl = new URL(mocks.openExternal.mock.calls[0][0] as string);
      const redirectUri = oauthUrl.searchParams.get('redirect_uri');

      expect(redirectUri).toBe('http://localhost:47823/callback');
      expect(oauthUrl.searchParams.get('state')).toBe('mock-csrf-state');
      expect(mocks.getAvailablePort).toHaveBeenCalledWith(
        SALESFORCE_LOOPBACK_PORT,
        'localhost',
      );
      expect(mockHttp.createServer).toHaveBeenCalled();
      expect(mockHttp.state.servers[0]?.listen).toHaveBeenCalledWith(
        SALESFORCE_LOOPBACK_PORT,
        'localhost',
        expect.any(Function),
      );
      await vi.waitFor(() => {
        expect(mocks.trackOAuthBrowserOpened).toHaveBeenCalledWith({
          connectorName: 'Salesforce',
          connectorType: 'bundled',
          oauthUrl: oauthUrl.toString(),
          callbackMethod: 'loopback',
        });
      });
      expect(mocks.trackOAuthStartBlocked).not.toHaveBeenCalled();

      const callbackUrl = new URL(redirectUri ?? '');
      callbackUrl.searchParams.set('code', 'loopback-code');
      callbackUrl.searchParams.set('state', 'mock-csrf-state');
      const response = invokeLoopbackCallback(callbackUrl);

      await expect(authPromise).resolves.toBe('ada@example.com');
      expect(response.status).toBe(200);

      const exchangeBody = tokenExchangeBody();
      expect(exchangeBody.get('code')).toBe('loopback-code');
      expect(exchangeBody.get('redirect_uri')).toBe('http://localhost:47823/callback');
      expect(exchangeBody.get('client_secret')).toBe('client-secret');
      expectSalesforceArtifactsPersisted();
      expect(mocks.bringAppToForeground).toHaveBeenCalledTimes(1);
    });

    it('fails loudly before opening the browser when the fixed Salesforce loopback port is busy', async () => {
      setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });
      mocks.getAvailablePort.mockResolvedValue(50_000);

      await expect(startSalesforceAuth('client-id', 'client-secret')).rejects.toThrow(
        'Salesforce sign-in needs local port 47823, but it\'s in use. Close the app using it and try again.',
      );

      expect(mocks.getAvailablePort).toHaveBeenCalledWith(
        SALESFORCE_LOOPBACK_PORT,
        'localhost',
      );
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(mocks.trackOAuthBrowserOpened).not.toHaveBeenCalled();
      expect(mockHttp.createServer).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects loopback callbacks with mismatched CSRF state before exchange', async () => {
      setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });
      mockSuccessfulSalesforceFetch();

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      authPromise.catch(() => undefined);

      await vi.waitFor(() => {
        expect(mocks.openExternal).toHaveBeenCalledTimes(1);
      });

      const oauthUrl = new URL(mocks.openExternal.mock.calls[0][0] as string);
      const callbackUrl = new URL(oauthUrl.searchParams.get('redirect_uri') ?? '');
      callbackUrl.searchParams.set('code', 'loopback-code');
      callbackUrl.searchParams.set('state', 'wrong-state');
      const response = invokeLoopbackCallback(callbackUrl);

      await expect(authPromise).rejects.toThrow('OAuth state mismatch - possible CSRF attack');
      expect(response.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
    });

    it('cancels loopback auth', async () => {
      setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      authPromise.catch(() => undefined);

      await vi.waitFor(() => {
        expect(mocks.openExternal).toHaveBeenCalledTimes(1);
      });

      cancelSalesforceAuth();

      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });

    it('supersedes an earlier loopback auth before token exchange', async () => {
      setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });
      mocks.generateCsrfState
        .mockReturnValueOnce('first-state')
        .mockReturnValueOnce('second-state');
      mockSuccessfulSalesforceFetch();

      const firstAuthPromise = startSalesforceAuth('client-id', 'client-secret');
      firstAuthPromise.catch(() => undefined);
      await vi.waitFor(() => {
        expect(mocks.openExternal).toHaveBeenCalledTimes(1);
      });
      const firstAuthUrl = new URL(mocks.openExternal.mock.calls[0][0] as string);
      const firstCallbackUrl = new URL(firstAuthUrl.searchParams.get('redirect_uri') ?? '');
      firstCallbackUrl.searchParams.set('code', 'first-code');
      firstCallbackUrl.searchParams.set('state', 'first-state');

      const secondAuthPromise = startSalesforceAuth('client-id', 'client-secret');
      secondAuthPromise.catch(() => undefined);
      await vi.waitFor(() => {
        expect(mocks.openExternal).toHaveBeenCalledTimes(2);
      });
      const secondAuthUrl = new URL(mocks.openExternal.mock.calls[1][0] as string);
      const secondCallbackUrl = new URL(secondAuthUrl.searchParams.get('redirect_uri') ?? '');
      secondCallbackUrl.searchParams.set('code', 'second-code');
      secondCallbackUrl.searchParams.set('state', 'second-state');

      await expect(firstAuthPromise).rejects.toThrow('Auth cancelled by user');

      const staleResponse = invokeLoopbackCallback(firstCallbackUrl, 0);
      expect(staleResponse.status).toBe(410);
      expect(mockFetch).not.toHaveBeenCalled();

      const response = invokeLoopbackCallback(secondCallbackUrl, 1);
      await expect(secondAuthPromise).resolves.toBe('ada@example.com');
      expect(response.status).toBe(200);

      const exchangeBody = tokenExchangeBody();
      expect(exchangeBody.get('code')).toBe('second-code');
      expect(exchangeBody.get('redirect_uri')).toBe('http://localhost:47823/callback');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('PKCE generation', () => {
    it('generates a valid PKCE verifier and challenge pair', async () => {
      // Start auth to trigger PKCE generation internally; we verify the OAuth URL
      // contains the challenge parameters
      const authPromise = startSalesforceAuth('test-client-id', 'test-client-secret');

      // Verify shell.openExternal was called with an OAuth URL containing PKCE params
      expect(shell.openExternal).toHaveBeenCalledTimes(1);
      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.searchParams.get('code_challenge')).toBeTruthy();
      expect(parsedUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsedUrl.searchParams.get('client_id')).toBe('test-client-id');
      expect(parsedUrl.searchParams.get('response_type')).toBe('code');

      // Clean up pending auth
      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });
  });

  describe('token exchange URL construction', () => {
    it('constructs OAuth URL with correct parameters', async () => {
      const authPromise = startSalesforceAuth('my-client-id', 'my-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.origin + parsedUrl.pathname).toBe(
        'https://login.salesforce.com/services/oauth2/authorize'
      );
      expect(parsedUrl.searchParams.get('client_id')).toBe('my-client-id');
      expect(parsedUrl.searchParams.get('redirect_uri')).toBe(
        'https://rebel-auth.mindstone.com/salesforce/callback'
      );
      expect(parsedUrl.searchParams.get('scope')).toContain('api');
      expect(parsedUrl.searchParams.get('scope')).toContain('refresh_token');
      expect(parsedUrl.searchParams.get('state')).toBe('mock-csrf-state');

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });

    it('uses SALESFORCE_REDIRECT_URI when configured', async () => {
      vi.stubEnv('SALESFORCE_REDIRECT_URI', 'https://example.test/salesforce/callback');

      const authPromise = startSalesforceAuth('my-client-id', 'my-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.searchParams.get('redirect_uri')).toBe(
        'https://example.test/salesforce/callback',
      );

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });
  });

  describe('exchangeCodeForTokens error messages', () => {
    it('provides actionable error for redirect_uri_mismatch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"redirect_uri_mismatch","error_description":"redirect_uri must match"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Ensure your Connected App callback URL is set to');
    });

    it('provides actionable error for invalid_client', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"invalid_client","error_description":"Invalid client credentials"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Ensure your Connected App callback URL is set to');
    });

    it('provides actionable error for OAUTH_APP_ACCESS_DENIED', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('{"error":"OAUTH_APP_ACCESS_DENIED","error_description":"user hasn\'t approved this consumer"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow("admin hasn't granted access");
    });

    it('provides actionable error for insufficient_scope', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('{"error":"insufficient_scope"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow("admin hasn't granted access");
    });

    it('provides actionable error for invalid_grant', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"invalid_grant","error_description":"expired authorization code"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Authorization code expired or already used');
    });

    it('provides actionable error for unsupported_grant_type', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"unsupported_grant_type"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow("Connected App may not have OAuth enabled");
    });

    it('falls through to generic error for unknown error types', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Token exchange failed: 500');
    });
  });

  describe('handleSalesforceOAuthCallback error handling', () => {
    it('provides actionable error for access_denied callback', async () => {
      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({
        error: 'access_denied',
        error_description: 'end-user denied authorization',
        state: 'mock-csrf-state',
      });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow(
        "Access was denied. If you're not a Salesforce admin"
      );
    });

    it('uses error_description for non-access_denied errors', async () => {
      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({
        error: 'server_error',
        error_description: 'Something went wrong on Salesforce side',
        state: 'mock-csrf-state',
      });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Something went wrong on Salesforce side');
    });

    it('rejects on CSRF state mismatch', async () => {
      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({
        code: 'test-code',
        state: 'wrong-state',
      });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('OAuth state mismatch');
    });

    it('ignores callback when no auth is pending', async () => {
      // No startSalesforceAuth called — callback should be ignored silently
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'some-state' });
      await handleSalesforceOAuthCallback(callbackUrl);
      // Should not throw — just return silently
    });
  });

  describe('sandbox environment support', () => {
    it('uses production OAuth URL by default (no environment set)', async () => {
      mockGetSettings.mockReturnValue({});

      const authPromise = startSalesforceAuth('client-id', 'client-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.origin).toBe('https://login.salesforce.com');
      expect(parsedUrl.pathname).toBe('/services/oauth2/authorize');

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });

    it('uses production OAuth URL when environment is explicitly production', async () => {
      mockGetSettings.mockReturnValue({ salesforce: { environment: 'production' } });

      const authPromise = startSalesforceAuth('client-id', 'client-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.origin).toBe('https://login.salesforce.com');

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });

    it('uses sandbox OAuth URL when environment is sandbox', async () => {
      mockGetSettings.mockReturnValue({ salesforce: { environment: 'sandbox' } });

      const authPromise = startSalesforceAuth('client-id', 'client-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.origin).toBe('https://test.salesforce.com');
      expect(parsedUrl.pathname).toBe('/services/oauth2/authorize');

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });

    it('uses sandbox token URL for token exchange in sandbox environment', async () => {
      mockGetSettings.mockReturnValue({ salesforce: { environment: 'sandbox' } });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"invalid_grant"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);

      // Verify fetch was called with sandbox token URL
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.salesforce.com/services/oauth2/token',
        expect.any(Object)
      );

      await expect(authPromise).rejects.toThrow('Authorization code expired');
    });
  });
});
