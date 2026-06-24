import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type GitHubAuthServiceModule = typeof import('../githubAuthService');
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

let testTokensDir: string;
let loadedService: GitHubAuthServiceModule | null = null;

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
  },
  openExternal: vi.fn().mockResolvedValue(undefined),
  getAvailablePort: vi.fn(async (_preferredPort?: number, _host?: string) => 31_337),
  generateCsrfState: vi.fn(() => 'csrf-state-fixture'),
  bringAppToForeground: vi.fn(),
  trackOAuthBrowserOpened: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
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

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
  }),
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: mocks.trackOAuthBrowserOpened,
}));

vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: mocks.generateCsrfState,
  bringAppToForeground: mocks.bringAppToForeground,
}));

vi.mock('../../utils/testIsolation', () => ({
  getSuperMcpOAuthTokensDir: () => testTokensDir,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const originalPlatform = process.platform;
const originalDefaultAppDescriptor = Object.getOwnPropertyDescriptor(process, 'defaultApp');

function setRuntime(input: {
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

async function loadService(): Promise<GitHubAuthServiceModule> {
  loadedService = await import('../githubAuthService');
  return loadedService;
}

function tokensPath(): string {
  return path.join(testTokensDir, 'GitHub_tokens.json');
}

function clientPath(): string {
  return path.join(testTokensDir, 'GitHub_client.json');
}

async function expectFileMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toThrow();
}

function mockSuccessfulGitHubFetch(): void {
  mockFetch.mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify({
      access_token: 'github-access-token-fixture',
      refresh_token: 'github-refresh-token-fixture',
      token_type: 'bearer',
      scope: 'repo,read:org',
    }),
  });
}

function tokenExchangeBody(): URLSearchParams {
  const tokenCall = mockFetch.mock.calls.find(
    ([url]) => String(url) === 'https://github.com/login/oauth/access_token',
  );
  if (!tokenCall) {
    throw new Error('Expected GitHub token exchange call');
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

describe('githubAuthService OAuth transport', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    restoreRuntime();
    loadedService = null;
    testTokensDir = await fs.mkdtemp(path.join(os.tmpdir(), 'github-oauth-transport-'));
    vi.stubEnv('GITHUB_CLIENT_ID', 'github-client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'github-client-secret');
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.getAvailablePort.mockResolvedValue(31_337);
    mocks.generateCsrfState.mockReturnValue('csrf-state-fixture');
    mockHttp.state.servers.length = 0;
    mockFetch.mockReset();
  });

  afterEach(async () => {
    loadedService?.cancelGitHubAuth();
    await fs.rm(testTokensDir, { recursive: true, force: true });
    restoreRuntime();
    vi.unstubAllEnvs();
  });

  it('keeps packaged builds on the deep-link transport', async () => {
    setRuntime({ isPackaged: true, platform: 'linux' });
    const service = await loadService();
    mockSuccessfulGitHubFetch();

    const pending = service.startGitHubAuth();
    pending.catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });

    const authUrl = new URL(String(mocks.openExternal.mock.calls[0]?.[0]));
    const redirectUri = authUrl.searchParams.get('redirect_uri');

    expect(redirectUri).toBe('https://rebel-auth.mindstone.com/github/callback');
    expect(redirectUri).not.toContain('127.0.0.1');
    expect(mocks.getAvailablePort).not.toHaveBeenCalled();
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    expect(mocks.trackOAuthBrowserOpened).toHaveBeenCalledWith({
      connectorName: 'GitHub',
      connectorType: 'bundled',
      oauthUrl: authUrl.toString(),
      callbackMethod: 'deep_link',
    });

    await service.handleGitHubOAuthCallback(
      `mindstone://github/callback?code=deep-link-code&state=${authUrl.searchParams.get('state')}`,
    );

    await expect(pending).resolves.toBeUndefined();
    const exchangeBody = tokenExchangeBody();
    expect(exchangeBody.get('code')).toBe('deep-link-code');
    expect(exchangeBody.get('redirect_uri')).toBe(
      'https://rebel-auth.mindstone.com/github/callback',
    );
    expect(exchangeBody.get('client_secret')).toBe('github-client-secret');
  });

  it('uses 127.0.0.1 loopback in unpackaged builds and persists token/client files', async () => {
    setRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();
    mockSuccessfulGitHubFetch();

    const pending = service.startGitHubAuth();
    pending.catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });

    const authUrl = new URL(String(mocks.openExternal.mock.calls[0]?.[0]));
    const redirectUri = authUrl.searchParams.get('redirect_uri');

    expect(redirectUri).toBe('http://127.0.0.1:31337/callback');
    expect(authUrl.searchParams.get('state')).toBe('csrf-state-fixture');
    expect(mocks.getAvailablePort).toHaveBeenCalledWith(undefined, '127.0.0.1');
    expect(mockHttp.createServer).toHaveBeenCalled();
    expect(mockHttp.state.servers[0]?.listen).toHaveBeenCalledWith(
      31_337,
      '127.0.0.1',
      expect.any(Function),
    );
    expect(mocks.trackOAuthBrowserOpened).toHaveBeenCalledWith({
      connectorName: 'GitHub',
      connectorType: 'bundled',
      oauthUrl: authUrl.toString(),
      callbackMethod: 'loopback',
    });

    const callbackUrl = new URL(redirectUri ?? '');
    callbackUrl.searchParams.set('code', 'loopback-code');
    callbackUrl.searchParams.set('state', 'csrf-state-fixture');
    const response = invokeLoopbackCallback(callbackUrl);

    await expect(pending).resolves.toBeUndefined();
    expect(response.status).toBe(200);

    const exchangeBody = tokenExchangeBody();
    expect(exchangeBody.get('code')).toBe('loopback-code');
    expect(exchangeBody.get('redirect_uri')).toBe('http://127.0.0.1:31337/callback');
    expect(exchangeBody.get('client_secret')).toBe('github-client-secret');

    const tokens = JSON.parse(await fs.readFile(tokensPath(), 'utf-8')) as {
      access_token?: string;
    };
    expect(tokens.access_token).toBe('github-access-token-fixture');
    const client = JSON.parse(await fs.readFile(clientPath(), 'utf-8')) as {
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
    };
    expect(client.client_id).toBe('github-client-id');
    expect(client.client_secret).toBe('github-client-secret');
    expect(client.redirect_uris).toEqual(['http://127.0.0.1:31337/callback']);
    expect(mocks.bringAppToForeground).toHaveBeenCalledTimes(1);
  });

  it('rejects loopback callbacks with mismatched CSRF state before exchange', async () => {
    setRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();
    mockSuccessfulGitHubFetch();

    const pending = service.startGitHubAuth();
    pending.catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });

    const authUrl = new URL(String(mocks.openExternal.mock.calls[0]?.[0]));
    const callbackUrl = new URL(authUrl.searchParams.get('redirect_uri') ?? '');
    callbackUrl.searchParams.set('code', 'loopback-code');
    callbackUrl.searchParams.set('state', 'wrong-state');
    const response = invokeLoopbackCallback(callbackUrl);

    await expect(pending).rejects.toThrow('OAuth state mismatch - possible CSRF attack');
    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
    await expectFileMissing(tokensPath());
    await expectFileMissing(clientPath());
  });

  it('cancels loopback auth', async () => {
    setRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();

    const pending = service.startGitHubAuth();
    pending.catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });

    service.cancelGitHubAuth();

    await expect(pending).rejects.toThrow('Auth cancelled by user');
  });

  it('supersedes an earlier loopback auth before token exchange', async () => {
    setRuntime({ isPackaged: false, platform: 'darwin' });
    mocks.getAvailablePort
      .mockResolvedValueOnce(31_337)
      .mockResolvedValueOnce(31_338);
    mocks.generateCsrfState
      .mockReturnValueOnce('first-state')
      .mockReturnValueOnce('second-state');
    const service = await loadService();
    mockSuccessfulGitHubFetch();

    const firstPending = service.startGitHubAuth();
    firstPending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });
    const firstAuthUrl = new URL(String(mocks.openExternal.mock.calls[0]?.[0]));
    const firstCallbackUrl = new URL(firstAuthUrl.searchParams.get('redirect_uri') ?? '');
    firstCallbackUrl.searchParams.set('code', 'first-code');
    firstCallbackUrl.searchParams.set('state', 'first-state');

    const secondPending = service.startGitHubAuth();
    secondPending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(2);
    });
    const secondAuthUrl = new URL(String(mocks.openExternal.mock.calls[1]?.[0]));
    const secondCallbackUrl = new URL(secondAuthUrl.searchParams.get('redirect_uri') ?? '');
    secondCallbackUrl.searchParams.set('code', 'second-code');
    secondCallbackUrl.searchParams.set('state', 'second-state');

    await expect(firstPending).rejects.toThrow('Auth cancelled by user');

    const staleResponse = invokeLoopbackCallback(firstCallbackUrl, 0);
    expect(staleResponse.status).toBe(410);
    expect(mockFetch).not.toHaveBeenCalled();

    const response = invokeLoopbackCallback(secondCallbackUrl, 1);
    await expect(secondPending).resolves.toBeUndefined();
    expect(response.status).toBe(200);

    const exchangeBody = tokenExchangeBody();
    expect(exchangeBody.get('code')).toBe('second-code');
    expect(exchangeBody.get('redirect_uri')).toBe('http://127.0.0.1:31338/callback');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
