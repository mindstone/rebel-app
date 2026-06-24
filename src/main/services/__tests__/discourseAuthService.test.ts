import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constants, publicEncrypt } from 'node:crypto';

type DiscourseAuthServiceModule = typeof import('../discourseAuthService');
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

let loadedService: DiscourseAuthServiceModule | null = null;

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
  },
  openExternal: vi.fn().mockResolvedValue(undefined),
  getAvailablePort: vi.fn(async (_preferredPort?: number, _host?: string) => 31_337),
  trackOAuthBrowserOpened: vi.fn(),
  bringAppToForeground: vi.fn(),
  writeDiscourseUserApiProfile: vi.fn().mockResolvedValue('/tmp/test-profile.json'),
  loggerInfo: vi.fn(),
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
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
  }),
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: mocks.trackOAuthBrowserOpened,
}));

vi.mock('../oauthPrimitives', () => ({
  bringAppToForeground: mocks.bringAppToForeground,
}));

vi.mock('../bundledMcpManager', () => ({
  writeDiscourseUserApiProfile: mocks.writeDiscourseUserApiProfile,
  buildDiscourseWritePayload: vi.fn().mockReturnValue({ name: 'test' }),
}));

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

async function loadService(): Promise<DiscourseAuthServiceModule> {
  loadedService = await import('../discourseAuthService');
  return loadedService;
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

function encryptDiscoursePayload(
  publicKeyPem: string,
  payload: Record<string, unknown>,
): string {
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(JSON.stringify(payload)),
  ).toString('base64');
}

describe('discourseAuthService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    restoreRuntime();
    loadedService = null;
    mockHttp.state.servers.length = 0;
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.getAvailablePort.mockResolvedValue(31_337);
    mocks.writeDiscourseUserApiProfile.mockResolvedValue('/tmp/test-profile.json');
  });

  afterEach(() => {
    loadedService?.cancelDiscourseAuth();
    restoreRuntime();
    vi.unstubAllEnvs();
  });

  it('keeps packaged builds on the deep-link transport', async () => {
    setRuntime({ isPackaged: true, platform: 'darwin' });
    const service = await loadService();

    const { authUrl, completion } = service.startDiscourseAuth(
      'https://rebels.mindstone.com',
    );
    completion.catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });

    const parsedAuthUrl = new URL(authUrl);
    const redirectUri = parsedAuthUrl.searchParams.get('auth_redirect');
    expect(redirectUri).toBe('https://rebel-auth.mindstone.com/discourse/callback');
    expect(redirectUri).not.toContain('127.0.0.1');
    expect(mocks.openExternal).toHaveBeenCalledWith(authUrl);
    expect(mocks.getAvailablePort).not.toHaveBeenCalled();
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    expect(mocks.trackOAuthBrowserOpened).toHaveBeenCalledWith({
      connectorName: 'Discourse',
      connectorType: 'bundled',
      oauthUrl: authUrl,
      callbackMethod: 'deep_link',
    });

    const payload = encryptDiscoursePayload(
      parsedAuthUrl.searchParams.get('public_key') ?? '',
      {
        key: 'deep-link-user-api-key',
        nonce: parsedAuthUrl.searchParams.get('nonce'),
        username: 'deep-link-user',
      },
    );

    await service.handleDiscourseAuthCallback(
      `mindstone://discourse/callback?payload=${encodeURIComponent(payload)}`,
    );

    await expect(completion).resolves.toEqual({ username: 'deep-link-user' });
    expect(mocks.writeDiscourseUserApiProfile).toHaveBeenCalledWith('discourse-write', {
      siteUrl: 'https://rebels.mindstone.com',
      userApiKey: 'deep-link-user-api-key',
      userApiClientId: expect.stringContaining('mindstone-rebel-'),
    });
  });

  it('uses 127.0.0.1 loopback in unpackaged builds and completes encrypted callbacks', async () => {
    setRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();

    const { authUrl, completion } = service.startDiscourseAuth(
      'https://rebels.mindstone.com',
    );
    completion.catch(() => undefined);

    expect(authUrl).toBe('');
    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });

    const parsedAuthUrl = new URL(String(mocks.openExternal.mock.calls[0]?.[0]));
    const redirectUri = parsedAuthUrl.searchParams.get('auth_redirect');
    expect(redirectUri).toBe('http://127.0.0.1:31337/callback');
    expect(new URL(redirectUri ?? '').searchParams.get('state')).toBeNull();
    expect(mocks.getAvailablePort).toHaveBeenCalledWith(undefined, '127.0.0.1');
    expect(mockHttp.createServer).toHaveBeenCalledTimes(1);
    expect(mockHttp.state.servers[0]?.listen).toHaveBeenCalledWith(
      31_337,
      '127.0.0.1',
      expect.any(Function),
    );
    expect(mocks.trackOAuthBrowserOpened).toHaveBeenCalledWith({
      connectorName: 'Discourse',
      connectorType: 'bundled',
      oauthUrl: parsedAuthUrl.toString(),
      callbackMethod: 'loopback',
    });

    const payload = encryptDiscoursePayload(
      parsedAuthUrl.searchParams.get('public_key') ?? '',
      {
        key: 'loopback-user-api-key',
        nonce: parsedAuthUrl.searchParams.get('nonce'),
        username: 'loopback-user',
      },
    );
    const callbackUrl = new URL(redirectUri ?? '');
    callbackUrl.searchParams.set('payload', payload);

    const response = invokeLoopbackCallback(callbackUrl);

    await expect(completion).resolves.toEqual({ username: 'loopback-user' });
    expect(response.status).toBe(200);
    expect(mocks.writeDiscourseUserApiProfile).toHaveBeenCalledWith('discourse-write', {
      siteUrl: 'https://rebels.mindstone.com',
      userApiKey: 'loopback-user-api-key',
      userApiClientId: expect.stringContaining('mindstone-rebel-'),
    });
    expect(mocks.bringAppToForeground).toHaveBeenCalledTimes(1);
  });

  it('rejects loopback callbacks with a mismatched encrypted nonce', async () => {
    setRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();

    const { completion } = service.startDiscourseAuth('https://rebels.mindstone.com');
    completion.catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });

    const parsedAuthUrl = new URL(String(mocks.openExternal.mock.calls[0]?.[0]));
    const callbackUrl = new URL(parsedAuthUrl.searchParams.get('auth_redirect') ?? '');
    callbackUrl.searchParams.set(
      'payload',
      encryptDiscoursePayload(parsedAuthUrl.searchParams.get('public_key') ?? '', {
        key: 'loopback-user-api-key',
        nonce: 'wrong-nonce',
        username: 'badactor',
      }),
    );

    const response = invokeLoopbackCallback(callbackUrl);

    await expect(completion).rejects.toThrow('Security validation failed');
    expect(response.status).toBe(400);
    expect(mocks.writeDiscourseUserApiProfile).not.toHaveBeenCalled();
  });

  it('cancels loopback auth', async () => {
    setRuntime({ isPackaged: false, platform: 'darwin' });
    const service = await loadService();

    const { completion } = service.startDiscourseAuth('https://rebels.mindstone.com');
    completion.catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });

    service.cancelDiscourseAuth();

    await expect(completion).rejects.toThrow('Auth cancelled by user');
    expect(mockHttp.state.servers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('supersedes an earlier loopback auth before accepting callbacks', async () => {
    setRuntime({ isPackaged: false, platform: 'darwin' });
    mocks.getAvailablePort
      .mockResolvedValueOnce(31_337)
      .mockResolvedValueOnce(31_338);
    const service = await loadService();

    const first = service.startDiscourseAuth('https://rebels.mindstone.com');
    first.completion.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    });
    const firstAuthUrl = new URL(String(mocks.openExternal.mock.calls[0]?.[0]));
    const firstCallbackUrl = new URL(firstAuthUrl.searchParams.get('auth_redirect') ?? '');
    firstCallbackUrl.searchParams.set(
      'payload',
      encryptDiscoursePayload(firstAuthUrl.searchParams.get('public_key') ?? '', {
        key: 'first-user-api-key',
        nonce: firstAuthUrl.searchParams.get('nonce'),
        username: 'first-user',
      }),
    );

    const second = service.startDiscourseAuth('https://rebels.mindstone.com');
    second.completion.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledTimes(2);
    });
    const secondAuthUrl = new URL(String(mocks.openExternal.mock.calls[1]?.[0]));
    const secondCallbackUrl = new URL(secondAuthUrl.searchParams.get('auth_redirect') ?? '');
    secondCallbackUrl.searchParams.set(
      'payload',
      encryptDiscoursePayload(secondAuthUrl.searchParams.get('public_key') ?? '', {
        key: 'second-user-api-key',
        nonce: secondAuthUrl.searchParams.get('nonce'),
        username: 'second-user',
      }),
    );

    await expect(first.completion).rejects.toThrow('Auth cancelled by user');

    const staleResponse = invokeLoopbackCallback(firstCallbackUrl, 0);
    expect(staleResponse.status).toBe(410);
    expect(mocks.writeDiscourseUserApiProfile).not.toHaveBeenCalled();

    const response = invokeLoopbackCallback(secondCallbackUrl, 1);

    await expect(second.completion).resolves.toEqual({ username: 'second-user' });
    expect(response.status).toBe(200);
    expect(mocks.writeDiscourseUserApiProfile).toHaveBeenCalledTimes(1);
    expect(mocks.writeDiscourseUserApiProfile).toHaveBeenCalledWith('discourse-write', {
      siteUrl: 'https://rebels.mindstone.com',
      userApiKey: 'second-user-api-key',
      userApiClientId: expect.stringContaining('mindstone-rebel-'),
    });
  });
});
